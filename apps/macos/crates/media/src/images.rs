//! Images for views: `img(media_image(request))`.
//!
//! What GPUI leaves to the app, done here:
//! - **Leases, not guesses.** Every element drawing a request keeps a lease in
//!   its element state, and GPUI keeps an element's state exactly as long as
//!   the element is drawn in consecutive frames — a cached view's reused frame
//!   included, a second window included. So "is anyone showing this?" has an
//!   exact answer, whether or not the view happens to re-render: a request
//!   nobody holds any more is dropped from the queue, or cancelled (download
//!   and all) if it is running, at the next trim.
//! - **Visible first, viewer first.** Requests queue newest first and a few run
//!   at once; [`ImageRequest::urgent`] ones (the viewer's) go ahead of the
//!   grid's and have slots of their own.
//! - **A memory budget.** Decoded images are kept least-recently-used within a
//!   budget, and only an image no element holds is ever evicted — one on screen
//!   stays, however long it has been since it was drawn. A load starts only if
//!   its estimated size fits beside what is decoded and what running loads have
//!   reserved; otherwise it waits for leases to lapse (one at a time still
//!   runs, so a screen larger than the budget fills). An evicted image is also
//!   dropped from every window's texture atlas. Decoding is bounded by
//!   estimated bytes too (see `decode`).
//! - **Retries.** A failed image someone still shows is tried again with
//!   backoff (5 s, 15 s, 45 s, … up to 5 min) on a timer, not on the next
//!   frame that happens to draw it. Bytes from the disk cache that do not
//!   decode are dropped from it and fetched once more from the network.
//! - **Repaint on arrival.** The view that asked is notified when its image is
//!   ready, the way GPUI's own loader does it.
//! - **Local images.** Previews decoded on the device ([`local_image`]) are
//!   dropped from the texture atlas once nothing holds them any more.

use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    rc::{Rc, Weak},
    sync::Arc,
    time::{Duration, Instant},
};

use gpui_kit::{
    App, AppContext as _, AsyncApp, BackgroundExecutor, Context, ElementId, Entity, EntityId,
    Global, ImageCacheError, ImageSource, RenderImage, SharedString, Task, Window,
};
use smallvec::SmallVec;

use crate::{
    decode,
    fetch::{Fetcher, Source},
};

/// Downloads at once. Enough to fill a screen quickly over HTTP/2 without
/// crowding out the Convex socket.
const MAX_RUNNING: usize = 6;
/// Extra slots only urgent (viewer) requests may use.
const URGENT_SLOTS: usize = 2;
/// How often queued work, leases and the budget are looked at while there is
/// anything to look at.
const TRIM_INTERVAL: Duration = Duration::from_millis(250);
/// How often local images are looked at when nothing else needs a trim.
const LOCAL_SWEEP_INTERVAL: Duration = Duration::from_secs(2);
/// The first retry of a failed image; each next one waits three times longer.
const FIRST_RETRY: Duration = Duration::from_secs(5);
const MAX_RETRY: Duration = Duration::from_secs(300);
/// A failure nobody has shown for this long is forgotten.
const FORGET_FAILURE_AFTER: Duration = Duration::from_secs(600);
/// What a full-size original is assumed to take decoded, before it is.
const ORIGINAL_ESTIMATE: usize = 4096 * 4096 * 4;

/// Which image, at what size. Equal requests share one load and one decoded
/// image; [`Self::urgent`] is a scheduling hint and not part of the identity.
#[derive(Clone, Debug)]
pub struct ImageRequest {
    url: SharedString,
    /// Longest side in device pixels to decode to; `None` keeps the original.
    max_dimension: Option<u32>,
    urgent: bool,
}

impl PartialEq for ImageRequest {
    fn eq(&self, other: &Self) -> bool {
        self.url == other.url && self.max_dimension == other.max_dimension
    }
}

impl Eq for ImageRequest {}

impl Hash for ImageRequest {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.url.hash(state);
        self.max_dimension.hash(state);
    }
}

impl ImageRequest {
    pub fn new(url: impl Into<SharedString>) -> Self {
        Self {
            url: url.into(),
            max_dimension: None,
            urgent: false,
        }
    }

    /// Decode to at most `pixels` on the longer side.
    pub fn max_dimension(mut self, pixels: u32) -> Self {
        self.max_dimension = Some(pixels.max(1));
        self
    }

    /// Loads ahead of the grids' requests, in slots of its own: what the
    /// viewer shows.
    pub fn urgent(mut self) -> Self {
        self.urgent = true;
        self
    }

    pub fn url(&self) -> &SharedString {
        &self.url
    }

    /// Bytes the decoded image is assumed to take until it is decoded.
    fn estimate(&self) -> usize {
        self.max_dimension.map_or(ORIGINAL_ESTIMATE, |side| {
            (side as usize)
                .saturating_mul(side as usize)
                .saturating_mul(4)
        })
    }
}

struct Decoded {
    image: Arc<RenderImage>,
    bytes: usize,
    last_used: Instant,
}

struct Pending {
    waiters: SmallVec<[EntityId; 2]>,
    urgent: bool,
    /// Failed attempts so far.
    attempts: u32,
    /// The last failure, shown (as the fallback) while a retry runs.
    retrying: Option<SharedString>,
    /// While it runs; dropping it cancels the download and the decode.
    task: Option<Task<()>>,
    /// Budget bytes held for it while it runs.
    reserved: usize,
}

struct Failure {
    message: SharedString,
    waiters: SmallVec<[EntityId; 2]>,
    urgent: bool,
    attempts: u32,
    retry_at: Instant,
    failed_at: Instant,
}

/// What an element drawing a request keeps in its element state; the
/// request is leased while any of these hold its token.
struct ImageLease {
    _token: Rc<()>,
}

pub struct MediaImages {
    fetcher: Arc<Fetcher>,
    decoded: HashMap<ImageRequest, Decoded>,
    decoded_bytes: usize,
    /// Estimated bytes of the loads running now.
    reserved_bytes: usize,
    budget_bytes: usize,
    /// Every request someone draws, by a token the drawing elements hold.
    leases: HashMap<ImageRequest, Weak<()>>,
    pending: HashMap<ImageRequest, Pending>,
    /// Waiting to start, newest last; workers take from the end.
    queue: Vec<ImageRequest>,
    urgent_queue: Vec<ImageRequest>,
    running: usize,
    failed: HashMap<ImageRequest, Failure>,
    /// Width ÷ height of every image decoded so far, by URL, kept after the
    /// pixels are evicted (the web's module-level dimension cache): a grid
    /// whose rows do not say how big their images are sizes tiles from it.
    aspects: HashMap<SharedString, f32>,
    /// Images decoded on the device ([`local_image`]); the atlas copy goes
    /// once this is the last holder.
    local: Vec<Arc<RenderImage>>,
    /// The interval of the trim timer running now, if one is.
    ticking: Option<Duration>,
    /// Identifies the current trim timer; an older one stops at its next tick.
    tick_generation: u64,
}

struct GlobalMediaImages(Entity<MediaImages>);

impl Global for GlobalMediaImages {}

pub(crate) fn init(fetcher: Arc<Fetcher>, budget_bytes: usize, cx: &mut App) {
    let images = cx.new(|_| MediaImages {
        fetcher,
        decoded: HashMap::new(),
        decoded_bytes: 0,
        reserved_bytes: 0,
        budget_bytes,
        leases: HashMap::new(),
        pending: HashMap::new(),
        queue: Vec::new(),
        urgent_queue: Vec::new(),
        running: 0,
        failed: HashMap::new(),
        aspects: HashMap::new(),
        local: Vec::new(),
        ticking: None,
        tick_generation: 0,
    });
    cx.set_global(GlobalMediaImages(images));
}

/// An image source for `img()` that loads through the media pipeline.
pub fn media_image(request: ImageRequest) -> ImageSource {
    ImageSource::Custom(Arc::new(move |window: &mut Window, cx: &mut App| {
        let images = cx.global::<GlobalMediaImages>().0.clone();
        images.update(cx, |images, cx| images.load(&request, window, cx))
    }))
}

/// Registers an image decoded on the device (a reference preview, a picked
/// file) and hands it back for `ImageSource::Render`. GPUI never drops such an
/// image's texture by itself; this does, from every window, once the returned
/// `Arc` and all its clones are gone. Keep the `Arc` with the state that shows
/// the image — when that state lets go (the reference is removed or replaced)
/// and the view re-renders without it, the texture follows within seconds.
pub fn local_image(image: impl Into<Arc<RenderImage>>, cx: &mut App) -> Arc<RenderImage> {
    let image = image.into();
    let images = cx.global::<GlobalMediaImages>().0.clone();
    images.update(cx, |images, cx| {
        images.local.push(image.clone());
        images.ensure_ticking(cx);
    });
    image
}

impl MediaImages {
    pub fn global(cx: &App) -> Entity<MediaImages> {
        cx.global::<GlobalMediaImages>().0.clone()
    }

    /// Bytes held by decoded images now.
    pub fn decoded_bytes(&self) -> usize {
        self.decoded_bytes
    }

    /// Width ÷ height of the image at `url`, once any request for it has
    /// decoded. The view that drew it is notified then, so a grid reading this
    /// in `render` lays out again with the real shape.
    pub fn aspect(cx: &App, url: &str) -> Option<f32> {
        cx.global::<GlobalMediaImages>()
            .0
            .read(cx)
            .aspects
            .get(url)
            .copied()
    }

    fn load(
        &mut self,
        request: &ImageRequest,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Result<Arc<RenderImage>, ImageCacheError>> {
        self.hold(request, window);
        let now = Instant::now();
        if let Some(decoded) = self.decoded.get_mut(request) {
            decoded.last_used = now;
            return Some(Ok(decoded.image.clone()));
        }

        let view = window.current_view();
        if let Some(failure) = self.failed.get_mut(request) {
            add_waiter(&mut failure.waiters, view);
            failure.urgent |= request.urgent;
            if failure.retry_at > now {
                let message = failure.message.clone();
                self.ensure_ticking(cx);
                return Some(Err(ImageCacheError::Asset(message)));
            }
            self.retry(request.clone());
        }

        let shown = match self.pending.get_mut(request) {
            Some(pending) => {
                add_waiter(&mut pending.waiters, view);
                if request.urgent && !pending.urgent {
                    pending.urgent = true;
                    if pending.task.is_none() {
                        self.queue.retain(|queued| queued != request);
                        self.urgent_queue.push(request.clone());
                    }
                } else if pending.task.is_none() {
                    // Asked again: to the front of its line.
                    let queue = if pending.urgent {
                        &mut self.urgent_queue
                    } else {
                        &mut self.queue
                    };
                    if let Some(ix) = queue.iter().position(|queued| queued == request) {
                        let queued = queue.remove(ix);
                        queue.push(queued);
                    }
                }
                pending.retrying.clone()
            }
            None => {
                self.pending.insert(
                    request.clone(),
                    Pending {
                        waiters: SmallVec::from_elem(view, 1),
                        urgent: request.urgent,
                        attempts: 0,
                        retrying: None,
                        task: None,
                        reserved: 0,
                    },
                );
                self.queue_for(request.urgent).push(request.clone());
                None
            }
        };
        self.pump(Some(window), cx);
        self.ensure_ticking(cx);
        // A retry keeps showing the fallback until it succeeds.
        shown.map(|message| Err(ImageCacheError::Asset(message)))
    }

    /// Records that the element being drawn shows `request`: a lease in its
    /// element state, which lapses when the element is no longer drawn.
    fn hold(&mut self, request: &ImageRequest, window: &mut Window) {
        let token = match self.leases.get(request).and_then(Weak::upgrade) {
            Some(token) => token,
            None => {
                let token = Rc::new(());
                self.leases.insert(request.clone(), Rc::downgrade(&token));
                token
            }
        };
        let mut hasher = std::hash::DefaultHasher::new();
        request.hash(&mut hasher);
        let id = ElementId::from(("media-image-lease", hasher.finish()));
        window.with_global_id(id, |global_id, window| {
            window.with_element_state(global_id, |lease: Option<ImageLease>, _| {
                ((), lease.unwrap_or(ImageLease { _token: token }))
            })
        });
    }

    fn is_leased(&self, request: &ImageRequest) -> bool {
        self.leases
            .get(request)
            .is_some_and(|token| token.strong_count() > 0)
    }

    fn queue_for(&mut self, urgent: bool) -> &mut Vec<ImageRequest> {
        if urgent {
            &mut self.urgent_queue
        } else {
            &mut self.queue
        }
    }

    /// Moves a failure back into the queue, keeping its waiters and count.
    fn retry(&mut self, request: ImageRequest) {
        let Some(failure) = self.failed.remove(&request) else {
            return;
        };
        self.pending.insert(
            request.clone(),
            Pending {
                waiters: failure.waiters,
                urgent: failure.urgent,
                attempts: failure.attempts,
                retrying: Some(failure.message),
                task: None,
                reserved: 0,
            },
        );
        self.queue_for(failure.urgent).push(request);
    }

    /// Starts queued loads while there are slots and memory for them. A
    /// queued request nobody holds is dropped instead. `window` is the window
    /// being drawn, if any: GPUI takes it out of the app while it draws, so
    /// an eviction must name it to reach its texture atlas.
    fn pump(&mut self, mut window: Option<&mut Window>, cx: &mut Context<Self>) {
        loop {
            let urgent = !self.urgent_queue.is_empty();
            let Some(request) = self.queue_for(urgent).last().cloned() else {
                break;
            };
            if !self.is_leased(&request) {
                self.queue_for(urgent).pop();
                self.pending.remove(&request);
                continue;
            }
            let slots = MAX_RUNNING + if urgent { URGENT_SLOTS } else { 0 };
            if self.running >= slots {
                break;
            }
            let estimate = request.estimate();
            if !self.admit(estimate, window.as_deref_mut(), cx) {
                break;
            }
            self.queue_for(urgent).pop();
            let task = self.start(request.clone(), cx);
            if let Some(pending) = self.pending.get_mut(&request) {
                pending.task = Some(task);
                pending.reserved = estimate;
                self.reserved_bytes += estimate;
                self.running += 1;
            }
        }
    }

    /// Whether a load of `estimate` bytes fits the budget now, evicting what
    /// no one shows to make room. With nothing running it always fits, so a
    /// screen whose images exceed the budget still fills, one at a time.
    fn admit(
        &mut self,
        estimate: usize,
        window: Option<&mut Window>,
        cx: &mut Context<Self>,
    ) -> bool {
        let fits =
            |this: &Self| this.decoded_bytes + this.reserved_bytes + estimate <= this.budget_bytes;
        if fits(self) {
            return true;
        }
        let target = self
            .budget_bytes
            .saturating_sub(self.reserved_bytes + estimate);
        self.evict_to(target, window, cx);
        fits(self) || self.running == 0
    }

    fn start(&mut self, request: ImageRequest, cx: &mut Context<Self>) -> Task<()> {
        let fetcher = self.fetcher.clone();
        let executor = cx.background_executor().clone();
        cx.spawn(async move |this, cx| {
            let result = load_image(
                fetcher,
                request.url.to_string(),
                request.max_dimension,
                executor,
                cx,
            )
            .await;
            let _ = this.update(cx, |this, cx| this.finish(request, result, cx));
        })
    }

    fn finish(
        &mut self,
        request: ImageRequest,
        result: anyhow::Result<RenderImage>,
        cx: &mut Context<Self>,
    ) {
        let Some(pending) = self.pending.remove(&request) else {
            return;
        };
        self.running = self.running.saturating_sub(1);
        self.reserved_bytes = self.reserved_bytes.saturating_sub(pending.reserved);
        match result {
            Ok(image) => {
                let size = image.size(0);
                if size.width.0 > 0 && size.height.0 > 0 {
                    self.aspects.insert(
                        request.url.clone(),
                        size.width.0 as f32 / size.height.0 as f32,
                    );
                }
                let bytes = decode::decoded_size(&image);
                self.decoded_bytes += bytes;
                self.decoded.insert(
                    request,
                    Decoded {
                        image: Arc::new(image),
                        bytes,
                        last_used: Instant::now(),
                    },
                );
                self.evict_to(self.budget_bytes, None, cx);
            }
            Err(error) => {
                tracing::debug!(url = %request.url, %error, "image failed to load");
                let attempts = pending.attempts + 1;
                let backoff = FIRST_RETRY
                    .saturating_mul(3u32.saturating_pow(attempts - 1))
                    .min(MAX_RETRY);
                let now = Instant::now();
                self.failed.insert(
                    request,
                    Failure {
                        message: error.to_string().into(),
                        waiters: pending.waiters.clone(),
                        urgent: pending.urgent,
                        attempts,
                        retry_at: now + backoff,
                        failed_at: now,
                    },
                );
            }
        }
        // `Context::notify` notifies this entity; the waiters are other views.
        let app: &mut App = cx;
        for view in pending.waiters {
            app.notify(view);
        }
        self.pump(None, cx);
    }

    /// Drops least-recently-used images no element holds until the decoded
    /// bytes are within `target`. An image on screen is never dropped.
    fn evict_to(&mut self, target: usize, mut window: Option<&mut Window>, cx: &mut Context<Self>) {
        if self.decoded_bytes <= target {
            return;
        }
        let mut by_age: Vec<(Instant, ImageRequest)> = self
            .decoded
            .iter()
            .filter(|(request, _)| !self.is_leased(request))
            .map(|(request, decoded)| (decoded.last_used, request.clone()))
            .collect();
        by_age.sort_by_key(|(last_used, _)| *last_used);
        for (_, request) in by_age {
            if self.decoded_bytes <= target {
                break;
            }
            if let Some(decoded) = self.decoded.remove(&request) {
                self.decoded_bytes -= decoded.bytes;
                cx.drop_image(decoded.image, window.as_deref_mut());
            }
        }
    }

    /// Keeps a trim timer running, at least every [`TRIM_INTERVAL`], while
    /// there is anything for it to do.
    fn ensure_ticking(&mut self, cx: &mut Context<Self>) {
        if self
            .ticking
            .is_some_and(|interval| interval <= TRIM_INTERVAL)
        {
            return;
        }
        // A slower timer (local images only) gives way to this one.
        self.tick_generation += 1;
        let generation = self.tick_generation;
        self.ticking = Some(TRIM_INTERVAL);
        let timer = cx.background_executor().clone();
        cx.spawn(async move |this, cx| {
            let mut interval = TRIM_INTERVAL;
            loop {
                timer.timer(interval).await;
                let next = this.update(cx, |this, cx| {
                    if this.tick_generation != generation {
                        return None;
                    }
                    let next = this.trim(cx);
                    this.ticking = next;
                    next
                });
                match next {
                    Ok(Some(next)) => interval = next,
                    _ => break,
                }
            }
        })
        .detach();
    }

    /// The periodic look at leases: drops or cancels work nobody holds,
    /// retries failures someone shows, evicts down to the budget, starts
    /// what now fits and lets go of unused local images. Returns when to look
    /// again, if there is still something to look at.
    fn trim(&mut self, cx: &mut Context<Self>) -> Option<Duration> {
        let now = Instant::now();
        self.leases.retain(|_, token| token.strong_count() > 0);

        // Queued and running loads nobody shows any more.
        let abandoned: Vec<ImageRequest> = self
            .pending
            .keys()
            .filter(|request| !self.is_leased(request))
            .cloned()
            .collect();
        for request in abandoned {
            if let Some(pending) = self.pending.remove(&request) {
                if pending.task.is_some() {
                    // Dropping the task cancels the download and the decode.
                    self.running = self.running.saturating_sub(1);
                    self.reserved_bytes = self.reserved_bytes.saturating_sub(pending.reserved);
                }
                self.queue.retain(|queued| *queued != request);
                self.urgent_queue.retain(|queued| *queued != request);
            }
        }

        // Failures due for another try, if someone still shows them.
        let due: Vec<ImageRequest> = self
            .failed
            .iter()
            .filter(|(request, failure)| failure.retry_at <= now && self.is_leased(request))
            .map(|(request, _)| request.clone())
            .collect();
        for request in due {
            self.retry(request);
        }
        self.failed.retain(|request, failure| {
            now.duration_since(failure.failed_at) < FORGET_FAILURE_AFTER
                || self.leases.contains_key(request)
        });

        self.evict_to(self.budget_bytes, None, cx);
        self.pump(None, cx);

        let before = self.local.len();
        self.local.retain(|image| {
            let unused = Arc::strong_count(image) == 1;
            if unused {
                cx.drop_image(image.clone(), None);
            }
            !unused
        });
        if self.local.len() != before {
            tracing::trace!(dropped = before - self.local.len(), "local images released");
        }

        let busy = !self.pending.is_empty()
            || self.decoded_bytes > self.budget_bytes
            || self
                .failed
                .keys()
                .any(|request| self.leases.contains_key(request));
        if busy {
            Some(TRIM_INTERVAL)
        } else if !self.local.is_empty() {
            Some(LOCAL_SWEEP_INTERVAL)
        } else {
            None
        }
    }
}

fn add_waiter(waiters: &mut SmallVec<[EntityId; 2]>, view: EntityId) {
    if !waiters.contains(&view) {
        waiters.push(view);
    }
}

/// Downloads (or reads) and decodes one image. Bytes that do not decode are
/// dropped from the disk cache; if they came from it, the image is fetched
/// once more from the network.
async fn load_image(
    fetcher: Arc<Fetcher>,
    url: String,
    max_dimension: Option<u32>,
    executor: BackgroundExecutor,
    cx: &AsyncApp,
) -> anyhow::Result<RenderImage> {
    let fetched = fetch(&fetcher, &url, Source::CacheOrNetwork, cx).await?;
    let error = match decode::decode_bounded(fetched.bytes, max_dimension, &executor).await {
        Ok(image) => return Ok(image),
        Err(error) => error,
    };
    forget(&fetcher, &url, cx);
    if !fetched.from_disk {
        return Err(error);
    }
    tracing::debug!(%url, %error, "a cached image did not decode; fetching it again");
    let fetched = fetch(&fetcher, &url, Source::Network, cx).await?;
    decode::decode_bounded(fetched.bytes, max_dimension, &executor)
        .await
        .inspect_err(|_| forget(&fetcher, &url, cx))
}

async fn fetch(
    fetcher: &Arc<Fetcher>,
    url: &str,
    source: Source,
    cx: &AsyncApp,
) -> anyhow::Result<crate::fetch::FetchedImage> {
    let (fetcher, url) = (fetcher.clone(), url.to_owned());
    artsnack_runtime::spawn_result(cx, async move { fetcher.image(&url, source).await }).await
}

fn forget(fetcher: &Arc<Fetcher>, url: &str, cx: &AsyncApp) {
    let (fetcher, url) = (fetcher.clone(), url.to_owned());
    artsnack_runtime::spawn(cx, async move { fetcher.forget(&url).await }).detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urgency_is_not_part_of_a_requests_identity() {
        let plain = ImageRequest::new("https://media.example.com/a.png").max_dimension(512);
        let urgent = plain.clone().urgent();
        assert_eq!(plain, urgent);
        let [a, b] = [plain, urgent].map(|request| {
            let mut hasher = std::hash::DefaultHasher::new();
            request.hash(&mut hasher);
            hasher.finish()
        });
        assert_eq!(a, b);
    }

    #[test]
    fn estimates_by_the_decode_size() {
        assert_eq!(
            ImageRequest::new("a").max_dimension(512).estimate(),
            512 * 512 * 4
        );
        assert_eq!(ImageRequest::new("a").estimate(), ORIGINAL_ESTIMATE);
    }
}
