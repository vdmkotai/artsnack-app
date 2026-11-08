//! `AVPlayer` → `AVPlayerItemVideoOutput` → `CVPixelBuffer`.

use std::{
    cell::Cell,
    ptr::NonNull,
    time::{Duration, Instant},
};

use anyhow::Context as _;
use objc2::{AnyThread as _, MainThreadMarker, rc::Retained, runtime::AnyObject};
use objc2_av_foundation::{
    AVPlayer, AVPlayerActionAtItemEnd, AVPlayerItem, AVPlayerItemStatus, AVPlayerItemVideoOutput,
    AVPlayerTimeControlStatus,
};
use objc2_core_foundation::{CFRetained, CFString};
use objc2_core_media::{CMTime, CMTimeFlags, kCMTimeZero};
use objc2_core_video::{
    CVGetCurrentHostTime, CVGetHostClockFrequency, CVPixelBuffer,
    kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

use crate::{Options, Status};

/// A decoded frame, ready for GPUI's `surface()`.
pub type Frame = CFRetained<CVPixelBuffer>;

/// Seeking this close to the end counts as the end, for looping.
const END_SLACK_SECONDS: f64 = 0.05;
/// Seeks land on a frame within this many seconds; exact seeks stall.
const SEEK_TIMESCALE: i32 = 600;
/// A seek whose frame has not come out by then no longer keeps a paused
/// clip asking for frames.
const SEEK_DEADLINE: Duration = Duration::from_secs(2);
/// A frame this close to the clip's position is the frame a seek landed on.
const SEEK_LANDED_SECONDS: f64 = 0.25;

/// One clip. Lives on the main thread, like every AppKit object it drives.
pub struct Player {
    player: Retained<AVPlayer>,
    item: Retained<AVPlayerItem>,
    output: Retained<AVPlayerItemVideoOutput>,
    options: Options,
    /// The last frame handed out, kept so a paused clip still draws.
    last: Option<Frame>,
    /// When the user's last seek started, until its frame is out. `seekToTime`
    /// is asynchronous: until then a paused clip still shows the old frame.
    seeking: Cell<Option<Instant>>,
    /// The loop's own seek back to the start is in flight; set once per lap,
    /// so the end is not sought again on every frame while the seek lands.
    looping_back: Cell<bool>,
}

impl Player {
    pub fn new(url: &str, options: Options) -> anyhow::Result<Self> {
        let mtm = MainThreadMarker::new().context("a player must be made on the main thread")?;
        let url = NSURL::URLWithString(&NSString::from_str(url))
            .with_context(|| format!("not a URL: {url}"))?;
        let item = unsafe { AVPlayerItem::playerItemWithURL(&url, mtm) };
        let output = unsafe {
            AVPlayerItemVideoOutput::initWithPixelBufferAttributes(
                AVPlayerItemVideoOutput::alloc(),
                Some(&pixel_buffer_attributes()),
            )
        };
        unsafe { item.addOutput(&output) };
        let player = unsafe { AVPlayer::playerWithPlayerItem(Some(&item), mtm) };
        unsafe {
            player.setMuted(options.muted);
            // Looping is ours: at the end the player holds still and `frame`
            // seeks back, so there is no gap of a new item loading.
            player.setActionAtItemEnd(if options.looping {
                AVPlayerActionAtItemEnd::None
            } else {
                AVPlayerActionAtItemEnd::Pause
            });
            if options.autoplay {
                player.play();
            }
        }
        Ok(Self {
            player,
            item,
            output,
            options,
            last: None,
            seeking: Cell::new(None),
            looping_back: Cell::new(false),
        })
    }

    pub fn status(&self) -> Status {
        let status = unsafe { self.item.status() };
        if status == AVPlayerItemStatus::ReadyToPlay {
            Status::Ready
        } else if status == AVPlayerItemStatus::Failed {
            let message = unsafe { self.item.error() }
                .map(|error| error.localizedDescription().to_string())
                .unwrap_or_else(|| "The clip could not be played".to_string());
            Status::Failed(message)
        } else {
            Status::Loading
        }
    }

    pub fn play(&self) {
        unsafe { self.player.play() };
    }

    pub fn pause(&self) {
        unsafe { self.player.pause() };
    }

    /// Playing, or about to (waiting for data counts: the user asked for it).
    pub fn is_playing(&self) -> bool {
        let status = unsafe { self.player.timeControlStatus() };
        status != AVPlayerTimeControlStatus::Paused
    }

    pub fn set_muted(&self, muted: bool) {
        unsafe { self.player.setMuted(muted) };
    }

    pub fn is_muted(&self) -> bool {
        unsafe { self.player.isMuted() }
    }

    /// Moves to `seconds`. The new frame follows asynchronously: until it is
    /// out (or [`SEEK_DEADLINE`] passes) [`Self::wants_frames`] stays true, so
    /// a paused clip still shows where it was moved to.
    pub fn seek(&self, seconds: f64) {
        let time = unsafe { CMTime::with_seconds(seconds.max(0.), SEEK_TIMESCALE) };
        self.seeking.set(Some(Instant::now()));
        self.looping_back.set(false);
        unsafe { self.player.seekToTime(time) };
    }

    /// A seek asked for by [`Self::seek`] has not shown its frame yet.
    pub fn is_seeking(&self) -> bool {
        self.seeking
            .get()
            .is_some_and(|started| started.elapsed() < SEEK_DEADLINE)
    }

    /// Whether the clip still needs [`Self::tick`] polled every display
    /// frame: while it loads, plays (or waits for data to play), a seek is
    /// landing, or no frame has come out yet. A paused, settled clip does not:
    /// its last frame stays up without asking for more.
    pub fn wants_frames(&self) -> bool {
        match self.status() {
            Status::Loading => true,
            Status::Failed(_) => false,
            Status::Ready => self.is_playing() || self.is_seeking() || self.last.is_none(),
        }
    }

    /// Loops at the end if the clip is meant to, and reports whether a new
    /// frame is ready for [`Self::frame`]. Cheap; call once per display frame
    /// while [`Self::wants_frames`], and draw only when it says so.
    pub fn tick(&self) -> bool {
        self.loop_at_end();
        let item_time = unsafe { self.output.itemTimeForHostTime(host_seconds()) };
        unsafe { self.output.hasNewPixelBufferForItemTime(item_time) }
    }

    /// Seconds from the start.
    pub fn position(&self) -> f64 {
        seconds(unsafe { self.player.currentTime() }).unwrap_or(0.)
    }

    /// Seconds, once the clip's header is in.
    pub fn duration(&self) -> Option<f64> {
        seconds(unsafe { self.item.duration() }).filter(|duration| *duration > 0.)
    }

    /// Width and height in pixels, once known.
    pub fn natural_size(&self) -> Option<(f32, f32)> {
        let size = unsafe { self.item.presentationSize() };
        (size.width > 0. && size.height > 0.).then_some((size.width as f32, size.height as f32))
    }

    /// The frame to show now: a new one if the output has it, else the last.
    pub fn frame(&mut self) -> Option<Frame> {
        self.loop_at_end();
        unsafe {
            let item_time = self.output.itemTimeForHostTime(host_seconds());
            let mut shown_at = item_time;
            if self.output.hasNewPixelBufferForItemTime(item_time)
                && let Some(buffer) = self
                    .output
                    .copyPixelBufferForItemTime_itemTimeForDisplay(item_time, &mut shown_at)
            {
                self.last = Some(to_cf(buffer));
                // The frame a seek was waiting for: it shows the position the
                // clip was moved to, not one decoded before the seek.
                if self.seeking.get().is_some()
                    && seconds(shown_at)
                        .is_some_and(|at| (at - self.position()).abs() <= SEEK_LANDED_SECONDS)
                {
                    self.seeking.set(None);
                }
            }
        }
        if self.seeking.get().is_some() && !self.is_seeking() {
            self.seeking.set(None);
        }
        self.last.clone()
    }

    /// Back to the start at the end — only while the clip is meant to be
    /// playing (a pause or a scrub into the last moments stays put), never
    /// during the user's own seek, and once per lap.
    fn loop_at_end(&self) {
        if !self.options.looping || self.is_seeking() {
            return;
        }
        // The rate is the intent: 0 once paused, 1 while playing or waiting
        // for data to play (with `ActionAtItemEnd::None` it stays 1 at the end).
        if unsafe { self.player.rate() } == 0.0 {
            self.looping_back.set(false);
            return;
        }
        let Some(duration) = self.duration() else {
            return;
        };
        let at_end = self.position() >= duration - END_SLACK_SECONDS;
        if at_end && !self.looping_back.get() {
            self.looping_back.set(true);
            unsafe { self.player.seekToTime(kCMTimeZero) };
        } else if !at_end {
            self.looping_back.set(false);
        }
    }
}

/// Now on the host clock, in seconds — what the output maps to item time.
fn host_seconds() -> f64 {
    CVGetCurrentHostTime() as f64 / CVGetHostClockFrequency()
}

impl Drop for Player {
    fn drop(&mut self) {
        // Stops the network and the decoder now rather than when AppKit gets
        // round to releasing the objects.
        unsafe {
            self.player.pause();
            self.player.replaceCurrentItemWithPlayerItem(None);
        }
    }
}

/// Seconds of a valid, finite `CMTime`.
fn seconds(time: CMTime) -> Option<f64> {
    if !time.flags.contains(CMTimeFlags::Valid)
        || time.flags.intersects(
            CMTimeFlags::Indefinite | CMTimeFlags::PositiveInfinity | CMTimeFlags::NegativeInfinity,
        )
    {
        return None;
    }
    let seconds = unsafe { time.seconds() };
    seconds.is_finite().then_some(seconds)
}

/// The output's frames: bi-planar YCbCr full range, IOSurface-backed and
/// Metal-compatible — what GPUI's renderer turns into textures without a copy.
fn pixel_buffer_attributes() -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys: [&NSString; 3] = unsafe {
        [
            ns_string(kCVPixelBufferPixelFormatTypeKey),
            ns_string(kCVPixelBufferMetalCompatibilityKey),
            ns_string(kCVPixelBufferIOSurfacePropertiesKey),
        ]
    };
    let format = NSNumber::numberWithUnsignedInt(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange);
    let metal = NSNumber::numberWithBool(true);
    let surface = NSDictionary::<NSString, AnyObject>::new();
    let values: [&AnyObject; 3] = [&format, &metal, &surface];
    NSDictionary::from_slices(&keys, &values)
}

/// A CoreFoundation string as the `NSString` it is toll-free bridged to.
fn ns_string(string: &'static CFString) -> &'static NSString {
    // SAFETY: CFString and NSString are toll-free bridged.
    unsafe { &*(string as *const CFString).cast::<NSString>() }
}

/// The output hands frames over as an Objective-C retained object; GPUI takes
/// a CoreFoundation one. Same object, same +1 retain count.
fn to_cf(buffer: Retained<CVPixelBuffer>) -> Frame {
    let raw = Retained::into_raw(buffer);
    // SAFETY: `into_raw` gives up exactly the one retain `from_raw` takes over.
    unsafe { CFRetained::from_raw(NonNull::new_unchecked(raw)) }
}
