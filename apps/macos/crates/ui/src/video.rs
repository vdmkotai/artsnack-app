//! Clips on screen, from `artsnack_video` players.
//!
//! - [`ClipPlayers`]: the clips a grid plays — muted, looping, no controls —
//!   made when a clip starts and dropped (decoder and download with it) when it
//!   stops. Which clips play is the grid's choice ([`ClipChooser`]: nearest the
//!   centre, at most four); this keeps players for them and draws them.
//! - [`ClipViewer`]: the viewer's player, with controls: play/pause (Space,
//!   K), mute (M), full screen (F), and a scrub bar. It opens muted, like every
//!   clip: sound only ever starts because the user pressed M or the unmute
//!   button.
//!
//! **Frames without re-rendering the screen.** A playing grid clip is drawn by
//! a small view of its own, [`ClipPlayers::surface`], which looks at its player
//! once per display frame without drawing anything and notifies itself only
//! when the player has a new frame (a 30 fps clip on a 120 Hz display redraws a
//! quarter of the frames) — and not at all once the clip is paused, settled,
//! suspended or failed. In GPUI a notification re-renders the notified view and
//! every view above it, so the grid's owner still re-renders on a clip frame;
//! what keeps that cheap is drawing the other tiles through
//! `MediaGridState::render_cached` / `MediaMasonryState::render_cached`, whose
//! cached tiles are reused untouched, and keeping other heavy regions of the
//! screen (a composer form) in cached views of their own.
//!
//! **Lifecycle.** Players live until [`ClipPlayers::sync`] no longer names
//! them, [`ClipPlayers::clear`] drops them, or the `ClipPlayers` itself is
//! dropped. A screen that stops being shown — another tab, the window hidden
//! — calls [`ClipPlayers::set_active`]`(false)`, which pauses every clip until
//! `set_active(true)`; a viewer the same through [`ClipViewer::set_active`].
//!
//! A clip shown once is copied into the disk cache in the background after it
//! stops, and plays from that file the next time (`artsnack_media::clips`).
//!
//! Frames are drawn with GPUI's `surface()`, which exists on macOS only; on
//! other platforms no player is ever made and posters stay up.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::{Rc, Weak},
    time::{Duration, Instant},
};

use artsnack_media::{ImageRequest, clips::ClipSource, media_image};
use artsnack_video::{Frame, Options, Player, Status, format_time};
use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, ObjectFit, ParentElement as _, Pixels,
    Render, SharedString, Styled as _, StyledImage as _, Subscription, WeakEntity, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        slider::{Slider, SliderEvent, SliderState},
        spinner::Spinner,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
};

/// Whether this build can play clips at all.
pub const PLAYBACK: bool = cfg!(target_os = "macos");

actions!(clip_viewer, [TogglePlay, ToggleMute, ToggleFullScreen]);

const CONTEXT: &str = "ClipViewer";

/// A clip still loading after this long is given up on.
const LOAD_DEADLINE: Duration = Duration::from_secs(20);
/// A clip that has wanted frames for this long without one is stalled: it is
/// looked at twice a second instead of every display frame.
const STALL_AFTER: Duration = Duration::from_secs(5);
const STALLED_POLL: Duration = Duration::from_millis(500);

pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("space", TogglePlay, Some(CONTEXT)),
        KeyBinding::new("k", TogglePlay, Some(CONTEXT)),
        KeyBinding::new("m", ToggleMute, Some(CONTEXT)),
        KeyBinding::new("f", ToggleFullScreen, Some(CONTEXT)),
    ]);
}

/// A frame as an element filling its box.
#[cfg(target_os = "macos")]
fn frame_element(frame: Frame, fit: ObjectFit) -> AnyElement {
    gpui_kit::surface(frame)
        .object_fit(fit)
        .size_full()
        .into_any_element()
}

#[cfg(not(target_os = "macos"))]
fn frame_element(_: Frame, _: ObjectFit) -> AnyElement {
    div().into_any_element()
}

// --- One open clip ------------------------------------------------------------

/// What a clip needs after a look at its player.
enum Poll {
    /// A new frame is out: redraw.
    Frame,
    /// Look again next display frame.
    Wait,
    /// Look again in a moment: it has waited a while for data.
    Later,
    /// Nothing until something changes (paused and settled).
    Idle,
    /// It will not play: close it.
    Failed(SharedString),
}

/// A player and what playback needs to know about it.
struct Clip {
    player: Player,
    /// The clip's own URL — what the disk cache keys it by.
    url: SharedString,
    /// Where the player reads from; holding it pins a cached file.
    source: ClipSource,
    opened: Instant,
    /// When the last new frame came out (or the clip opened).
    last_frame: Instant,
    /// A frame of it has been drawn.
    shown: bool,
}

impl Clip {
    /// Opens `url` from the disk cache if it is there, else the network.
    fn open(url: &SharedString, options: Options) -> Result<Self, String> {
        let source = artsnack_media::clips::source(url);
        let player = Player::new(source.url(), options).map_err(|error| format!("{error:#}"))?;
        let now = Instant::now();
        Ok(Self {
            player,
            url: url.clone(),
            source,
            opened: now,
            last_frame: now,
            shown: false,
        })
    }

    fn poll(&mut self) -> Poll {
        let now = Instant::now();
        match self.player.status() {
            Status::Failed(message) => Poll::Failed(message.into()),
            Status::Loading if now - self.opened > LOAD_DEADLINE => {
                Poll::Failed("the clip took too long to load".into())
            }
            Status::Loading => Poll::Wait,
            Status::Ready if self.player.tick() => {
                self.last_frame = now;
                Poll::Frame
            }
            Status::Ready if !self.player.wants_frames() => Poll::Idle,
            Status::Ready if now - self.last_frame > STALL_AFTER => Poll::Later,
            Status::Ready => Poll::Wait,
        }
    }

    /// Whether it should be looked at again (loading, playing, seeking).
    fn wants_frames(&self) -> bool {
        match self.player.status() {
            Status::Loading => self.opened.elapsed() <= LOAD_DEADLINE,
            Status::Ready => self.player.wants_frames(),
            Status::Failed(_) => false,
        }
    }

    fn frame(&mut self) -> Option<Frame> {
        let frame = self.player.frame();
        self.shown |= frame.is_some();
        frame
    }
}

impl Drop for Clip {
    fn drop(&mut self) {
        // Shown from the network: worth having on disk for next time.
        if self.shown && !self.source.is_cached() {
            artsnack_media::clips::remember_played(&self.url);
        }
    }
}

// --- Grid clips ---------------------------------------------------------------

/// How many clips of a grid may play at the same time.
const MAX_PLAYING_CLIPS: usize = 4;
/// A playing clip keeps its slot unless a rival is clearly closer.
const PLAYING_BIAS: f32 = 0.75;

/// Which clips of a grid play: the visible ones nearest the viewport's
/// centre, vertical distance first (a feed is read top to bottom), at most
/// four, nothing while the viewer covers the grid (the web's
/// `video-playback.ts`).
#[derive(Default)]
pub struct ClipChooser {
    playing: Vec<SharedString>,
    suspended: bool,
}

impl ClipChooser {
    /// Nothing is chosen while suspended (the viewer covers the grid, the
    /// screen is hidden).
    pub fn set_suspended(&mut self, suspended: bool) {
        self.suspended = suspended;
        if suspended {
            self.playing.clear();
        }
    }

    pub fn is_suspended(&self) -> bool {
        self.suspended
    }

    /// Picks from `clips` (key, tile bounds) within `viewport`, both in window
    /// coordinates. Call once per frame.
    pub fn choose(
        &mut self,
        clips: impl IntoIterator<Item = (SharedString, Bounds<Pixels>)>,
        viewport: Bounds<Pixels>,
    ) -> &[SharedString] {
        if !PLAYBACK || self.suspended || viewport.size.height <= Pixels::ZERO {
            self.playing.clear();
            return &self.playing;
        }
        let centre = viewport.center();
        let mut ranked: Vec<(f32, SharedString)> = clips
            .into_iter()
            .filter(|(_, tile)| tile.bottom() > viewport.top() && tile.top() < viewport.bottom())
            .map(|(key, tile)| {
                let middle = tile.center();
                let distance =
                    ((middle.x - centre.x).as_f32() * 0.5).hypot((middle.y - centre.y).as_f32());
                let bias = if self.playing.contains(&key) {
                    PLAYING_BIAS
                } else {
                    1.0
                };
                (distance * bias, key)
            })
            .collect();
        ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
        self.playing = ranked
            .into_iter()
            .take(MAX_PLAYING_CLIPS)
            .map(|(_, key)| key)
            .collect();
        &self.playing
    }

    pub fn playing(&self) -> &[SharedString] {
        &self.playing
    }
}

#[derive(Default)]
struct Players {
    clips: HashMap<SharedString, Clip>,
    /// The views drawing them, made on first ask.
    surfaces: HashMap<SharedString, Entity<ClipSurface>>,
    /// Clips that would not open or play; they keep their poster until they
    /// leave the playing set.
    failed: HashSet<SharedString>,
    /// Paused by `set_active(false)`: nothing plays, opens or ticks.
    suspended: bool,
}

impl Players {
    fn close(&mut self, key: &SharedString, reason: &str) {
        if let Some(clip) = self.clips.remove(key) {
            tracing::warn!(url = %clip.url, reason, "could not play a clip");
        }
        self.surfaces.remove(key);
        self.failed.insert(key.clone());
    }

    fn poll(&mut self, key: &SharedString) -> Poll {
        if self.suspended {
            return Poll::Idle;
        }
        let Some(clip) = self.clips.get_mut(key) else {
            return Poll::Idle;
        };
        let poll = clip.poll();
        if let Poll::Failed(reason) = &poll {
            let reason = reason.clone();
            self.close(key, &reason);
        }
        poll
    }

    /// Closes every clip that failed or timed out; returns whether any other
    /// still wants frames.
    fn prune(&mut self) -> bool {
        let failing: Vec<(SharedString, SharedString)> = self
            .clips
            .iter()
            .filter_map(|(key, clip)| match clip.player.status() {
                Status::Failed(reason) => Some((key.clone(), reason.into())),
                Status::Loading if clip.opened.elapsed() > LOAD_DEADLINE => {
                    Some((key.clone(), "the clip took too long to load".into()))
                }
                _ => None,
            })
            .collect();
        for (key, reason) in failing {
            self.close(&key, &reason);
        }
        !self.suspended && self.clips.values().any(Clip::wants_frames)
    }
}

/// The players of the clips a grid is playing, by tile key. Cheap to clone,
/// so a grid's tile builder can hold it.
#[derive(Clone, Default)]
pub struct ClipPlayers(Rc<RefCell<Players>>);

impl ClipPlayers {
    /// Keeps a muted, looping player for each of `playing` (key, clip URL) and
    /// drops the rest — their downloads and decoders go with them. While
    /// suspended ([`Self::set_active`]) no new player opens.
    pub fn sync(&self, playing: impl IntoIterator<Item = (SharedString, SharedString)>) {
        let playing: Vec<(SharedString, SharedString)> = playing.into_iter().collect();
        let mut state = self.0.borrow_mut();
        let Players {
            clips,
            surfaces,
            failed,
            suspended,
        } = &mut *state;
        let wanted = |key: &SharedString| playing.iter().any(|(candidate, _)| candidate == key);
        clips.retain(|key, _| wanted(key));
        surfaces.retain(|key, _| wanted(key));
        failed.retain(|key| wanted(key));
        if !PLAYBACK || *suspended {
            return;
        }
        for (key, url) in playing {
            if clips.contains_key(&key) || failed.contains(&key) {
                continue;
            }
            match Clip::open(&url, Options::TILE) {
                Ok(clip) => {
                    clips.insert(key, clip);
                }
                Err(error) => {
                    tracing::warn!(%error, %url, "could not open a clip");
                    failed.insert(key);
                }
            }
        }
    }

    /// Pauses every clip and stops opening new ones (`false`), or plays them
    /// again (`true`). For a screen that is no longer shown: another tab, a
    /// Generate tab switched away from, the window hidden. The players stay,
    /// so coming back is instant; [`Self::clear`] lets go of them.
    pub fn set_active(&self, active: bool, cx: &mut App) {
        let surfaces: Vec<Entity<ClipSurface>> = {
            let mut state = self.0.borrow_mut();
            state.suspended = !active;
            for clip in state.clips.values() {
                if active {
                    clip.player.play();
                } else {
                    clip.player.pause();
                }
            }
            state.surfaces.values().cloned().collect()
        };
        if active {
            // Their ticks stopped while suspended; a redraw starts them again.
            for surface in surfaces {
                surface.update(cx, |_, cx| cx.notify());
            }
        }
    }

    /// Whether [`Self::set_active`] suspended playback.
    pub fn is_suspended(&self) -> bool {
        self.0.borrow().suspended
    }

    /// Drops every player (and its download and decoder) now.
    pub fn clear(&self) {
        let mut state = self.0.borrow_mut();
        state.clips.clear();
        state.surfaces.clear();
        state.failed.clear();
    }

    /// Whether a player is open for `key` — its tile changes every frame, so
    /// draw it uncached (the `is_live` of `render_cached`).
    pub fn is_playing(&self, key: &str) -> bool {
        self.0.borrow().clips.contains_key(key)
    }

    /// Whether the clip of `key` has drawn a frame (its poster is covered).
    pub fn has_frame(&self, key: &str) -> bool {
        self.0
            .borrow()
            .clips
            .get(key)
            .is_some_and(|clip| clip.shown)
    }

    /// The playing clip of `key` as a view of its own, to lay over its tile's
    /// poster: transparent until the first frame, then the clip covering the
    /// box. It redraws itself when a new frame is out and asks nothing of the
    /// caller — no `request_animation_frame`, no [`Self::is_active`]. `None`
    /// when no player is open for `key`.
    pub fn surface(&self, key: &str, cx: &mut App) -> Option<AnyElement> {
        let mut state = self.0.borrow_mut();
        let (key, _) = state.clips.get_key_value(key)?;
        let key = key.clone();
        let surface = state
            .surfaces
            .entry(key.clone())
            .or_insert_with(|| {
                cx.new(|_| ClipSurface {
                    players: Rc::downgrade(&self.0),
                    key,
                    armed: false,
                })
            })
            .clone();
        Some(surface.into_any_element())
    }

    /// Whether any clip wants frames; failed and timed-out clips are closed on
    /// the way.
    ///
    /// For callers that draw [`Self::frame`] and ask for every display frame
    /// while this holds. Superseded by [`Self::surface`], which redraws only
    /// the clip; that path does not need this.
    pub fn is_active(&self) -> bool {
        self.0.borrow_mut().prune()
    }

    /// The clip's current frame covering its tile, once one is decoded.
    ///
    /// Superseded by [`Self::surface`]: drawing frames here makes the caller
    /// re-render its whole grid on every display frame.
    pub fn frame(&self, key: &str) -> Option<AnyElement> {
        let frame = self.0.borrow_mut().clips.get_mut(key)?.frame()?;
        Some(frame_element(frame, ObjectFit::Cover))
    }
}

/// One playing grid clip, drawn by itself. See [`ClipPlayers::surface`].
pub struct ClipSurface {
    players: Weak<RefCell<Players>>,
    key: SharedString,
    /// A look at the player is scheduled.
    armed: bool,
}

impl ClipSurface {
    fn arm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.armed {
            return;
        }
        self.armed = true;
        let this = cx.entity().downgrade();
        window.on_next_frame(move |window, cx| tick_surface(this, window, cx));
    }
}

/// A display frame's look at a surface's player: redraw for a new frame,
/// look again next frame (or in a moment), or stop until something changes.
fn tick_surface(this: WeakEntity<ClipSurface>, window: &mut Window, cx: &mut App) {
    let Some(surface) = this.upgrade() else {
        return;
    };
    let (players, key) = {
        let surface = surface.read(cx);
        (surface.players.upgrade(), surface.key.clone())
    };
    let poll = players.map_or(Poll::Idle, |players| players.borrow_mut().poll(&key));
    match poll {
        Poll::Wait => window.on_next_frame(move |window, cx| tick_surface(this, window, cx)),
        Poll::Later => window
            .spawn(cx, async move |cx| {
                cx.background_executor().timer(STALLED_POLL).await;
                let _ = cx.update(|window, cx| tick_surface(this, window, cx));
            })
            .detach(),
        Poll::Frame | Poll::Failed(_) => surface.update(cx, |surface, cx| {
            surface.armed = false;
            cx.notify();
        }),
        Poll::Idle => surface.update(cx, |surface, _| surface.armed = false),
    }
}

impl Render for ClipSurface {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (frame, wants_frames) = self
            .players
            .upgrade()
            .and_then(|players| {
                let mut players = players.borrow_mut();
                let suspended = players.suspended;
                let clip = players.clips.get_mut(&self.key)?;
                Some((clip.frame(), !suspended && clip.wants_frames()))
            })
            .unwrap_or((None, false));
        if wants_frames {
            self.arm(window, cx);
        }
        match frame {
            Some(frame) => frame_element(frame, ObjectFit::Cover),
            None => div().size_full().into_any_element(),
        }
    }
}

// --- The viewer's player ------------------------------------------------------

pub struct ClipViewer {
    focus_handle: FocusHandle,
    url: SharedString,
    poster: ImageRequest,
    clip: Option<Clip>,
    error: Option<SharedString>,
    scrub: Entity<SliderState>,
    /// The scrub bar is being dragged: the clock follows the bar, not the clip.
    scrubbing: bool,
    /// A look at the player is scheduled.
    armed: bool,
    /// `set_active(false)` paused a playing clip; `set_active(true)` resumes it.
    resume_on_activate: bool,
    _subscription: Subscription,
}

impl ClipViewer {
    /// Opens `url` muted, looping and playing, `poster` showing until the
    /// first frame.
    pub fn new(url: SharedString, poster: ImageRequest, cx: &mut Context<Self>) -> Self {
        let (clip, error) = if PLAYBACK {
            match Clip::open(&url, Options::VIEWER) {
                Ok(clip) => (Some(clip), None),
                Err(error) => (None, Some(error.into())),
            }
        } else {
            (None, None)
        };
        // A fraction of the clip: the bar exists before the length is known.
        let scrub = cx.new(|_| SliderState::new().min(0.).max(1.).step(0.001));
        let subscription = cx.subscribe(&scrub, |this, _, event: &SliderEvent, cx| match event {
            SliderEvent::Change(value) => {
                this.scrubbing = true;
                this.seek(value.start() as f64);
                cx.notify();
            }
            SliderEvent::Release(value) => {
                this.scrubbing = false;
                this.seek(value.start() as f64);
                cx.notify();
            }
        });
        Self {
            focus_handle: cx.focus_handle(),
            url,
            poster: poster.urgent(),
            clip,
            error,
            scrub,
            scrubbing: false,
            armed: false,
            resume_on_activate: false,
            _subscription: subscription,
        }
    }

    /// Pauses the clip while the viewer is not shown (`false`) — another tab,
    /// the window hidden — and resumes it on `true` if it was playing.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        let Some(clip) = &self.clip else {
            return;
        };
        if !active {
            if clip.player.is_playing() {
                clip.player.pause();
                self.resume_on_activate = true;
            }
        } else if std::mem::take(&mut self.resume_on_activate) {
            clip.player.play();
            cx.notify();
        }
    }

    /// Seeks to `fraction` of the clip. The frame there follows when the seek
    /// lands, paused or not.
    fn seek(&self, fraction: f64) {
        if let Some(clip) = &self.clip
            && let Some(duration) = clip.player.duration()
        {
            clip.player.seek(fraction.clamp(0., 1.) * duration);
        }
    }

    fn arm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.armed {
            return;
        }
        self.armed = true;
        let this = cx.entity().downgrade();
        window.on_next_frame(move |window, cx| tick_viewer(this, window, cx));
    }

    fn toggle_play(&mut self, _: &TogglePlay, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(clip) = &self.clip {
            if clip.player.is_playing() {
                clip.player.pause();
            } else {
                clip.player.play();
            }
        }
        self.resume_on_activate = false;
        cx.notify();
    }

    fn toggle_mute(&mut self, _: &ToggleMute, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(clip) = &self.clip {
            clip.player.set_muted(!clip.player.is_muted());
        }
        cx.notify();
    }

    fn toggle_full_screen(
        &mut self,
        _: &ToggleFullScreen,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.toggle_fullscreen();
    }

    fn render_poster(&self, overlay: AnyElement) -> AnyElement {
        div()
            .relative()
            .size_full()
            .child(
                img(media_image(self.poster.clone()))
                    .size_full()
                    .object_fit(ObjectFit::Contain),
            )
            .child(
                v_flex()
                    .absolute()
                    .inset_0()
                    .items_center()
                    .justify_center()
                    .child(overlay),
            )
            .into_any_element()
    }

    fn render_controls(
        &self,
        playing: bool,
        muted: bool,
        position: f64,
        duration: Option<f64>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        h_flex()
            .gap_2()
            .px_3()
            .py_2()
            .rounded(cx.theme().radius_lg)
            .bg(cx.theme().background.opacity(0.85))
            .child(
                Button::new("clip-play")
                    .ghost()
                    .small()
                    .icon(if playing {
                        IconName::Pause
                    } else {
                        IconName::Play
                    })
                    .tooltip(if playing {
                        "Pause (Space)"
                    } else {
                        "Play (Space)"
                    })
                    .on_click(
                        cx.listener(|this, _, window, cx| {
                            this.toggle_play(&TogglePlay, window, cx)
                        }),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!(
                        "{} / {}",
                        format_time(position),
                        duration.map(format_time).unwrap_or_else(|| "–:––".into())
                    )),
            )
            .child(div().flex_1().min_w_0().child(Slider::new(&self.scrub)))
            .child(
                Button::new("clip-mute")
                    .ghost()
                    .small()
                    .icon(if muted {
                        IconName::VolumeX
                    } else {
                        IconName::Volume2
                    })
                    .tooltip(if muted { "Unmute (M)" } else { "Mute (M)" })
                    .on_click(
                        cx.listener(|this, _, window, cx| {
                            this.toggle_mute(&ToggleMute, window, cx)
                        }),
                    ),
            )
            .child(
                Button::new("clip-full-screen")
                    .ghost()
                    .small()
                    .icon(IconName::Maximize)
                    .tooltip("Full screen (F)")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_full_screen(&ToggleFullScreen, window, cx)
                    })),
            )
            .into_any_element()
    }
}

/// The viewer's per-display-frame look at its player; see [`tick_surface`].
fn tick_viewer(this: WeakEntity<ClipViewer>, window: &mut Window, cx: &mut App) {
    let Some(viewer) = this.upgrade() else {
        return;
    };
    viewer.update(cx, |viewer, cx| {
        viewer.armed = false;
        let Some(clip) = viewer.clip.as_mut() else {
            return;
        };
        match clip.poll() {
            Poll::Frame => cx.notify(),
            Poll::Wait => viewer.arm(window, cx),
            Poll::Later => {
                viewer.armed = true;
                window
                    .spawn(cx, async move |cx| {
                        cx.background_executor().timer(STALLED_POLL).await;
                        let _ = cx.update(|window, cx| tick_viewer(this, window, cx));
                    })
                    .detach();
            }
            Poll::Failed(reason) => {
                tracing::warn!(url = %clip.url, %reason, "could not play a clip");
                viewer.clip = None;
                viewer.error = Some(reason);
                cx.notify();
            }
            Poll::Idle => {}
        }
    });
}

impl Focusable for ClipViewer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for ClipViewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let base = div()
            .id("clip-viewer")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::toggle_play))
            .on_action(cx.listener(Self::toggle_mute))
            .on_action(cx.listener(Self::toggle_full_screen))
            .relative()
            .size_full();

        let Some(clip) = self.clip.as_mut() else {
            // No player here (or it would not open or play): the poster, the
            // reason, and the clip in the default player.
            let url = self.url.clone();
            let message = self.error.clone().map(|reason| {
                SharedString::from(format!(
                    "Video unavailable — the file may still be uploading, or the backend may be offline ({reason})"
                ))
            });
            let open = v_flex()
                .items_center()
                .gap_2()
                .when_some(message, |this, message| {
                    this.child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(message),
                    )
                })
                .child(
                    Button::new("clip-open")
                        .primary()
                        .icon(IconName::Play)
                        .label("Play clip")
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                )
                .into_any_element();
            return base.child(self.render_poster(open)).into_any_element();
        };

        let wants_frames = clip.wants_frames();
        let status = clip.player.status();
        let frame = (status == Status::Ready).then(|| clip.frame()).flatten();
        let (playing, muted, position, duration) = (
            clip.player.is_playing(),
            clip.player.is_muted(),
            clip.player.position(),
            clip.player.duration(),
        );
        if wants_frames {
            self.arm(window, cx);
        }
        match status {
            Status::Failed(message) => {
                let body = div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!(
                        "Video unavailable — the file may still be uploading, or the backend may be offline ({message})"
                    ))
                    .into_any_element();
                return base.child(self.render_poster(body)).into_any_element();
            }
            Status::Loading => {
                let poster = self.render_poster(Spinner::new().large().into_any_element());
                return base.child(poster).into_any_element();
            }
            Status::Ready => {}
        }

        if !self.scrubbing
            && let Some(duration) = duration
        {
            let fraction = (position / duration).clamp(0., 1.) as f32;
            self.scrub
                .update(cx, |scrub, cx| scrub.set_value(fraction, window, cx));
        }

        let picture = match frame {
            Some(frame) => frame_element(frame, ObjectFit::Contain),
            None => self.render_poster(Spinner::new().large().into_any_element()),
        };
        let controls = self.render_controls(playing, muted, position, duration, cx);
        base.child(picture)
            .child(
                div()
                    .absolute()
                    .bottom_4()
                    .left_4()
                    .right_4()
                    .child(controls),
            )
            .into_any_element()
    }
}
