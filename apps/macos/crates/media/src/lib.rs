//! Media from the CDN.
//!
//! - [`MediaUrls`]: the same URLs as the web and iOS apps.
//! - [`disk::DiskCache`]: originals, previews and played clips kept on disk,
//!   size-capped. It opens off the main thread after startup; until it has,
//!   everything comes from the network.
//! - [`media_image`]: an `img()` source with visible-first loading, decoding at
//!   display size off the main thread, and a memory budget.
//! - [`clips`]: where a player opens a clip — the cached file once it has been
//!   played before.
//! - [`local_image`]: previews decoded on the device, released from the GPU
//!   when nothing holds them.

pub mod clips;
pub mod decode;
pub mod disk;
pub mod downloads;
pub mod fetch;
mod images;
pub mod upload;
mod urls;

use std::sync::Arc;

use artsnack_settings::{Preference, Preferences};
use gpui_kit::{App, AppContext as _, Global};

pub use images::{ImageRequest, MediaImages, local_image, media_image};
pub use urls::{MediaUrls, THUMB_WIDTH};

/// Default disk budget. The web's media worker allowed 20 GB; a laptop disk
/// is a tighter place for a cache, and Settings can raise it.
pub const DEFAULT_DISK_BUDGET: u64 = 5 * 1024 * 1024 * 1024;

/// The disk budget chosen in Settings, in bytes.
pub const DISK_BUDGET: Preference<u64> =
    Preference::new("media.diskBudgetBytes", || DEFAULT_DISK_BUDGET);
/// Decoded images in memory (and on the GPU): about 500 grid thumbnails.
const DECODED_BUDGET: usize = 768 * 1024 * 1024;

/// The media origin's URLs, available to every view.
pub struct Media {
    urls: MediaUrls,
    fetcher: Arc<fetch::Fetcher>,
}

impl Global for Media {}

impl Media {
    pub fn urls(cx: &App) -> &MediaUrls {
        &cx.global::<Media>().urls
    }

    /// The CDN client, for downloads that are not displayed images.
    pub fn fetcher(cx: &App) -> Arc<fetch::Fetcher> {
        cx.global::<Media>().fetcher.clone()
    }

    /// The disk cache, once it has opened. Its methods block: call them on
    /// the background executor (`cx.background_spawn`) or `spawn_blocking`,
    /// never on the main thread or one of the I/O runtime's two workers.
    pub fn disk(cx: &App) -> Option<Arc<disk::DiskCache>> {
        cx.global::<Media>().fetcher.disk().cloned()
    }

    /// Changes the disk budget, evicting down to it in the background.
    pub fn set_disk_budget(cx: &mut App, bytes: u64) {
        Preferences::set(cx, &DISK_BUDGET, bytes);
        if let Some(disk) = Self::disk(cx) {
            // Eviction is file deletes and SQLite: a blocking thread, not one
            // of the two I/O workers every request shares.
            cx.background_spawn(async move {
                if let Err(error) = disk.set_budget(bytes) {
                    tracing::warn!(?error, "could not apply the media cache budget");
                }
            })
            .detach();
        }
    }
}

/// Starts the media pipeline for `origin` (the media CDN). Opening
/// the disk cache (directories, SQLite, its journal) happens on a background
/// thread, so it never holds up the first window.
pub fn init(origin: &url::Url, cx: &mut App) {
    let urls = MediaUrls::new(origin);
    let fetcher = match fetch::Fetcher::new(None) {
        Ok(fetcher) => Arc::new(fetcher.with_persistent_origin(urls.origin())),
        Err(error) => {
            tracing::error!(?error, "could not create the media HTTP client");
            return;
        }
    };
    if let Some(dir) = artsnack_settings::cache_dir().map(|dir| dir.join("media")) {
        let budget = Preferences::get(cx, &DISK_BUDGET);
        let fetcher = fetcher.clone();
        cx.background_spawn(async move {
            match disk::DiskCache::open(&dir, budget) {
                Ok(cache) => fetcher.set_disk(Arc::new(cache)),
                Err(error) => tracing::warn!(
                    ?error,
                    "media disk cache unavailable; using the network only"
                ),
            }
        })
        .detach();
    }
    images::init(fetcher.clone(), DECODED_BUDGET, cx);
    clips::init(fetcher.clone(), artsnack_runtime::handle(cx));
    cx.set_global(Media { urls, fetcher });
}
