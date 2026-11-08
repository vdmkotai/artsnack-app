//! Clips through the disk cache, without ever holding up first playback.
//!
//! A player streams a clip from the network the first time: it starts within
//! the first few hundred kilobytes, and waiting for a whole file first would
//! be slower. Once a clip has been shown, [`remember_played`] copies it into
//! the disk cache in the background — one at a time, a few waiting at most,
//! and only clips under [`MAX_CLIP_BYTES`] — so the next time it is shown
//! (scrolled back to, opened in the viewer, a later session) [`source`] hands
//! the player the local file instead, pinned so eviction cannot delete it
//! while it plays.
//!
//! Players have no GPUI context when they open or close (`ClipPlayers::sync`
//! runs without one), so the cache is reached through a process-wide handle
//! set by `artsnack_media::init`; before that, or without a disk cache, every
//! clip streams.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};

use anyhow::{Context as _, bail};
use parking_lot::Mutex;
use tokio::{io::AsyncWriteExt as _, sync::Semaphore};

use crate::{
    disk::{DiskCache, DiskPin},
    fetch::Fetcher,
};

/// Clips larger than this are streamed every time.
pub const MAX_CLIP_BYTES: u64 = 64 * 1024 * 1024;
/// Clips copied into the cache at once.
const CONCURRENT_FILLS: usize = 1;
/// Clips waiting to be copied; more are dropped (they are a cache).
const MAX_WAITING_FILLS: usize = 8;
const HEADER_TIMEOUT: Duration = Duration::from_secs(15);
/// Silence between body chunks after which a copy is abandoned.
const IDLE_TIMEOUT: Duration = Duration::from_secs(20);

static CLIPS: OnceLock<Arc<ClipCache>> = OnceLock::new();

struct ClipCache {
    fetcher: Arc<Fetcher>,
    runtime: tokio::runtime::Handle,
    /// URLs being copied or waiting to be.
    filling: Mutex<HashSet<String>>,
    slots: Arc<Semaphore>,
}

pub(crate) fn init(fetcher: Arc<Fetcher>, runtime: tokio::runtime::Handle) {
    let _ = CLIPS.set(Arc::new(ClipCache {
        fetcher,
        runtime,
        filling: Mutex::new(HashSet::new()),
        slots: Arc::new(Semaphore::new(CONCURRENT_FILLS)),
    }));
}

/// Where a player should open a clip: the cached file if there is one, else
/// the network URL. Holding it keeps the cached file from eviction.
pub struct ClipSource {
    url: String,
    pin: Option<DiskPin>,
}

impl ClipSource {
    /// A `file://` URL of the cached copy, or the clip's own URL.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Whether the clip plays from the disk cache.
    pub fn is_cached(&self) -> bool {
        self.pin.is_some()
    }
}

/// The source to open `url` from. Cheap enough for the main thread (one
/// `stat`; marking the entry used happens in the background).
pub fn source(url: &str) -> ClipSource {
    let network = || ClipSource {
        url: url.to_owned(),
        pin: None,
    };
    let Some(cache) = CLIPS.get() else {
        return network();
    };
    let Some(disk) = cache
        .fetcher
        .disk()
        .filter(|_| cache.fetcher.is_persistent(url))
    else {
        return network();
    };
    let Some((path, pin)) = disk.pin_clip(url) else {
        return network();
    };
    let Ok(file_url) = url::Url::from_file_path(&path) else {
        return network();
    };
    let (disk, key) = (disk.clone(), url.to_owned());
    cache.runtime.spawn_blocking(move || disk.touch_clip(&key));
    ClipSource {
        url: file_url.to_string(),
        pin: Some(pin),
    }
}

/// `url` was shown from the network: copy it into the disk cache in the
/// background, if it is ours, small enough and not there yet.
pub fn remember_played(url: &str) {
    if let Some(cache) = CLIPS.get() {
        cache.fill(url);
    }
}

impl ClipCache {
    fn fill(self: &Arc<Self>, url: &str) {
        if !self.fetcher.is_persistent(url) {
            return;
        }
        let Some(disk) = self.fetcher.disk().cloned() else {
            return;
        };
        {
            let mut filling = self.filling.lock();
            if filling.len() >= MAX_WAITING_FILLS || !filling.insert(url.to_owned()) {
                return;
            }
        }
        let (cache, url) = (self.clone(), url.to_owned());
        self.runtime.spawn(async move {
            if let Ok(_slot) = cache.slots.clone().acquire_owned().await {
                let has = {
                    let (disk, url) = (disk.clone(), url.clone());
                    tokio::task::spawn_blocking(move || disk.has_clip(&url))
                        .await
                        .unwrap_or(false)
                };
                if !has && let Err(error) = copy_clip(cache.fetcher.http(), &disk, &url).await {
                    tracing::debug!(%url, ?error, "could not cache a clip");
                }
            }
            cache.filling.lock().remove(&url);
        });
    }
}

/// Deletes a temporary file unless it was handed over.
struct Temporary(Option<PathBuf>);

impl Drop for Temporary {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

async fn copy_clip(http: &reqwest::Client, disk: &Arc<DiskCache>, url: &str) -> anyhow::Result<()> {
    let response = tokio::time::timeout(HEADER_TIMEOUT, http.get(url).send())
        .await
        .context("no answer")??;
    let status = response.status();
    if !status.is_success() {
        bail!("HTTP {status}");
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CLIP_BYTES)
    {
        return Ok(());
    }
    let mut temporary = Temporary(Some(disk.temporary_path()));
    let path = temporary.0.clone().expect("just set");
    let bytes = stream_to(response, &path).await?;
    let (disk, url) = (disk.clone(), url.to_owned());
    let handed = path.clone();
    temporary.0 = None;
    tokio::task::spawn_blocking(move || disk.insert_clip(&url, &handed, bytes)).await?
}

/// Writes the body to `path`, giving up past [`MAX_CLIP_BYTES`] or after
/// [`IDLE_TIMEOUT`] without data. Returns the length.
async fn stream_to(mut response: reqwest::Response, path: &Path) -> anyhow::Result<u64> {
    let mut file = tokio::fs::File::create(path).await?;
    let mut written = 0u64;
    while let Some(chunk) = tokio::time::timeout(IDLE_TIMEOUT, response.chunk())
        .await
        .context("the download stalled")??
    {
        written += chunk.len() as u64;
        if written > MAX_CLIP_BYTES {
            bail!("larger than the clip cache takes");
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    file.sync_data().await?;
    Ok(written)
}
