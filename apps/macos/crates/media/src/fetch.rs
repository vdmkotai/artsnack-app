//! Downloads from the media CDN, straight from its origin — there is no CORS to
//! work around natively, so nothing goes through Vercel's slow `/media` proxy.
//! Every request has deadlines, as the web's media worker learned it must.
//!
//! - **One download per URL.** Concurrent requests for the same image — two
//!   decode sizes, a grid and the viewer — share a single download; when every
//!   requester has gone, the download is cancelled.
//! - **Only immutable objects are kept.** The media origin's objects never
//!   change, so their bytes go to the disk cache for good. A third-party URL
//!   (a pasted reference) may serve different bytes tomorrow and is never
//!   stored: it is fetched again each session.
//! - **Only images are kept.** A response that is not an image (an error page,
//!   a clip) is refused before its body is read, a body is capped, and bytes
//!   are stored only if they start like an image.
//! - **Writes are bounded.** At most two cache writes run at once and at most
//!   [`MAX_QUEUED_WRITE_BYTES`] wait; past that a write is skipped (it is a
//!   cache), so a burst of downloads cannot pile up copies in memory.

use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context as _, anyhow, bail};
use futures::{
    FutureExt as _,
    future::{BoxFuture, Shared, WeakShared},
};
use parking_lot::Mutex;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use tokio::sync::Semaphore;

use crate::{disk::DiskCache, urls::is_under};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Whole-request ceiling for an image; clips stream separately.
const IMAGE_TIMEOUT: Duration = Duration::from_secs(60);
/// `format=auto` transformations answer with the best format the client
/// accepts. Ask for WebP or JPEG: GPUI's decoders have no AVIF.
const IMAGE_ACCEPT: &str = "image/webp,image/jpeg;q=0.9,image/png;q=0.8,*/*;q=0.5";
/// The largest image body accepted.
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// Cache writes that may wait at once, in bytes.
const MAX_QUEUED_WRITE_BYTES: usize = 64 * 1024 * 1024;
const CONCURRENT_WRITES: usize = 2;

/// Where [`Fetcher::image`] may take the bytes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The disk cache if it has them, else the network.
    CacheOrNetwork,
    /// The network: the cached copy did not decode.
    Network,
}

/// An image's bytes and where they came from.
#[derive(Clone)]
pub struct FetchedImage {
    pub bytes: Arc<[u8]>,
    /// Read from the disk cache rather than downloaded.
    pub from_disk: bool,
}

type Download = Shared<BoxFuture<'static, Result<Arc<[u8]>, Arc<anyhow::Error>>>>;
type WeakDownload = WeakShared<BoxFuture<'static, Result<Arc<[u8]>, Arc<anyhow::Error>>>>;

pub struct Fetcher {
    http: reqwest::Client,
    /// Set once the cache has opened (off the main thread, after startup);
    /// until then every image comes from the network.
    disk: OnceLock<Arc<DiskCache>>,
    /// Objects under this origin never change and are kept on disk.
    persistent_origin: Option<String>,
    downloads: Mutex<HashMap<String, WeakDownload>>,
    writes: Arc<WriteQueue>,
}

impl Fetcher {
    /// A client with `disk` as its cache. Nothing is stored on disk until
    /// [`Self::with_persistent_origin`] names the origin whose objects never
    /// change.
    pub fn new(disk: Option<Arc<DiskCache>>) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent(concat!("ArtSnack-macOS/", env!("CARGO_PKG_VERSION")))
            .build()?;
        let cell = OnceLock::new();
        if let Some(disk) = disk {
            let _ = cell.set(disk);
        }
        Ok(Self {
            http,
            disk: cell,
            persistent_origin: None,
            downloads: Mutex::new(HashMap::new()),
            writes: Arc::new(WriteQueue {
                slots: Semaphore::new(CONCURRENT_WRITES),
                queued_bytes: AtomicUsize::new(0),
            }),
        })
    }

    /// Objects under `origin` (the media CDN) are immutable: they are
    /// read from and written to the disk cache. Nothing else is.
    pub fn with_persistent_origin(mut self, origin: impl Into<String>) -> Self {
        self.persistent_origin = Some(origin.into().trim_end_matches('/').to_owned());
        self
    }

    /// Attaches the disk cache once it has opened. Only the first call counts.
    pub fn set_disk(&self, disk: Arc<DiskCache>) {
        let _ = self.disk.set(disk);
    }

    /// The disk cache, once it has opened.
    pub fn disk(&self) -> Option<&Arc<DiskCache>> {
        self.disk.get()
    }

    /// The shared client, for downloads that are not images (they stream).
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Whether `url` is an immutable object of the media origin, kept on disk.
    pub fn is_persistent(&self, url: &str) -> bool {
        self.persistent_origin
            .as_deref()
            .is_some_and(|origin| is_under(origin, url))
    }

    /// The bytes of an image, from the disk cache or the network (then cached).
    /// Runs on the I/O runtime.
    pub async fn image_bytes(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        Ok(self
            .image(url, Source::CacheOrNetwork)
            .await?
            .bytes
            .to_vec())
    }

    /// The bytes of an image and where they came from. Runs on the I/O
    /// runtime. Requests for one URL share a download.
    pub async fn image(&self, url: &str, source: Source) -> anyhow::Result<FetchedImage> {
        let persistent = self.is_persistent(url);
        let disk = self.disk().filter(|_| persistent).cloned();
        if source == Source::CacheOrNetwork
            && let Some(disk) = disk.clone()
        {
            let key = url.to_owned();
            let cached = tokio::task::spawn_blocking(move || disk.read(&key)).await?;
            if let Some(bytes) = cached {
                return Ok(FetchedImage {
                    bytes: bytes.into(),
                    from_disk: true,
                });
            }
        }
        let bytes = self
            .download(url, disk)
            .await
            .map_err(|error| anyhow!("{error:#}"))?;
        Ok(FetchedImage {
            bytes,
            from_disk: false,
        })
    }

    /// Drops the cached copy of `url` — bytes that did not decode. Runs on
    /// the I/O runtime.
    pub async fn forget(&self, url: &str) {
        let Some(disk) = self.disk().cloned() else {
            return;
        };
        let key = url.to_owned();
        let removed = tokio::task::spawn_blocking(move || disk.remove(&key)).await;
        if let Ok(Err(error)) = removed {
            tracing::debug!(?error, "could not drop a cache entry");
        }
    }

    /// The download of `url` in flight, or a new one. It writes its bytes to
    /// `disk` itself, once, however many requesters share it.
    fn download(&self, url: &str, disk: Option<Arc<DiskCache>>) -> Download {
        let mut downloads = self.downloads.lock();
        if let Some(download) = downloads.get(url).and_then(WeakDownload::upgrade) {
            return download;
        }
        downloads.retain(|_, download| download.upgrade().is_some());
        let (http, key, writes) = (self.http.clone(), url.to_owned(), self.writes.clone());
        let download = async move {
            let bytes = download_image(&http, &key).await.map_err(Arc::new)?;
            if let Some(disk) = disk
                && image::guess_format(&bytes).is_ok()
            {
                writes.persist(disk, key, bytes.clone());
            }
            Ok(bytes)
        }
        .boxed()
        .shared();
        if let Some(weak) = download.downgrade() {
            downloads.insert(url.to_owned(), weak);
        }
        download
    }
}

/// GETs `url` as an image: refused unless the server says it is one (or does
/// not say), and capped at [`MAX_IMAGE_BYTES`].
async fn download_image(http: &reqwest::Client, url: &str) -> anyhow::Result<Arc<[u8]>> {
    let mut response = http
        .get(url)
        .header(ACCEPT, IMAGE_ACCEPT)
        .timeout(IMAGE_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("requesting {url}"))?;
    let status = response.status();
    if !status.is_success() {
        bail!("{url} answered HTTP {status}");
    }
    if let Some(content_type) = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        && !is_image_type(content_type)
    {
        bail!("{url} is not an image ({content_type})");
    }
    if let Some(length) = response.content_length()
        && length > MAX_IMAGE_BYTES as u64
    {
        bail!("{url} is too large for an image ({length} bytes)");
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .map_or(0, |length| length as usize),
    );
    while let Some(chunk) = response.chunk().await.context("reading the image")? {
        if body.len() + chunk.len() > MAX_IMAGE_BYTES {
            bail!("{url} is too large for an image");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.into())
}

/// `image/*`, or a generic binary type a bucket may serve images as.
fn is_image_type(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence.starts_with("image/")
        || essence == "application/octet-stream"
        || essence == "binary/octet-stream"
}

struct WriteQueue {
    slots: Semaphore,
    queued_bytes: AtomicUsize,
}

impl WriteQueue {
    /// Writes `bytes` for `url` in the background, or skips it if too much is
    /// already waiting. Must be called on the I/O runtime.
    fn persist(self: &Arc<Self>, disk: Arc<DiskCache>, url: String, bytes: Arc<[u8]>) {
        let size = bytes.len();
        let queued = self.queued_bytes.fetch_add(size, Ordering::AcqRel) + size;
        let runtime = tokio::runtime::Handle::try_current();
        if queued > MAX_QUEUED_WRITE_BYTES || runtime.is_err() {
            self.queued_bytes.fetch_sub(size, Ordering::AcqRel);
            tracing::debug!(%url, "skipping a cache write; too many are waiting");
            return;
        }
        let queue = self.clone();
        runtime.expect("checked above").spawn(async move {
            if let Ok(_slot) = queue.slots.acquire().await {
                let written = tokio::task::spawn_blocking(move || disk.write(&url, &bytes)).await;
                if let Ok(Err(error)) = written {
                    tracing::warn!(?error, "could not cache an image on disk");
                }
            }
            queue.queued_bytes.fetch_sub(size, Ordering::AcqRel);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_image_types_and_refuses_the_rest() {
        assert!(is_image_type("image/webp"));
        assert!(is_image_type("IMAGE/JPEG; charset=binary"));
        assert!(is_image_type("application/octet-stream"));
        assert!(!is_image_type("video/mp4"));
        assert!(!is_image_type("text/html; charset=utf-8"));
    }

    #[test]
    fn stores_only_the_media_origin() {
        let fetcher = Fetcher::new(None)
            .unwrap()
            .with_persistent_origin("https://media.example.com/");
        assert!(fetcher.is_persistent("https://media.example.com/a/b.png"));
        assert!(!fetcher.is_persistent("https://media.example.com.evil.test/a.png"));
        assert!(!fetcher.is_persistent("https://cdn.example.com/a.png"));
        assert!(
            !Fetcher::new(None)
                .unwrap()
                .is_persistent("https://media.example.com/a.png")
        );
    }
}
