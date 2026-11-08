//! "Download" saves the original to ~/Downloads under a name that does not
//! overwrite anything, with no Save dialog — what the Electron shell did with
//! every download — and says so in a notification.
//!
//! The file is assembled under a hidden temporary name of its own and only
//! then published under its final name, without replacing anything: two
//! downloads of `image.png` at once end up as `image.png` and `image (2).png`,
//! and a failed or cancelled one leaves nothing behind.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context as _, bail};
use gpui_kit::{
    App, SharedString, Window,
    component::{WindowExt as _, notification::Notification},
};
use tokio::io::AsyncWriteExt as _;

use crate::{Media, fetch::Fetcher};

/// How long the server may take to start answering.
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
/// Silence between body chunks after which a download is abandoned.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Saves `url` into ~/Downloads as `name` (or `name (2)`, …), then reports it
/// in `window`. A copy already in the disk cache is used without downloading.
pub fn download(
    url: impl Into<String>,
    name: impl Into<String>,
    window: &mut Window,
    cx: &mut App,
) {
    let (url, name) = (url.into(), name.into());
    let fetcher = Media::fetcher(cx);
    let task = artsnack_runtime::spawn_result(cx, async move { save(fetcher, &url, &name).await });
    let window = window.window_handle();
    cx.spawn(async move |cx| {
        let outcome = task.await;
        let notification = match outcome {
            Ok(path) => Notification::success(format!("Saved {} to Downloads", file_name(&path))),
            Err(error) => {
                tracing::warn!(?error, "download failed");
                Notification::error(format!("Download failed: {error}"))
            }
        };
        let _ = window.update(cx, |_, window, cx| {
            window.push_notification(notification, cx)
        });
    })
    .detach();
}

/// The file name a media key is saved under: its last path segment.
pub fn name_for_key(key: &str) -> SharedString {
    key.rsplit('/').next().unwrap_or(key).to_string().into()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn downloads_dir() -> anyhow::Result<PathBuf> {
    dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
        .context("no Downloads folder")
}

/// `name`, then `stem (2).ext`, `stem (3).ext`, … in `dir`.
fn candidates(dir: &Path, name: &str) -> impl Iterator<Item = PathBuf> {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    let first = dir.join(name);
    let dir = dir.to_owned();
    std::iter::once(first)
        .chain((2u32..).map(move |n| dir.join(format!("{stem} ({n}){extension}"))))
}

/// A hidden name beside the target, unique to this download.
fn temporary_path(dir: &Path, name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{name}.{}-{n}.download", std::process::id()))
}

/// Gives `temporary` the first free name of [`candidates`], never replacing a
/// file: a hard link fails if the name is taken, and the next is tried. Where
/// the file system has no hard links, the name is reserved with an exclusive
/// create and the file renamed over the reservation.
fn publish(temporary: &Path, dir: &Path, name: &str) -> io::Result<PathBuf> {
    for candidate in candidates(dir, name).take(10_000) {
        match fs::hard_link(temporary, &candidate) {
            Ok(()) => {
                let _ = fs::remove_file(temporary);
                return Ok(candidate);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&candidate)
                {
                    Ok(_) => {
                        fs::rename(temporary, &candidate)?;
                        return Ok(candidate);
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free file name",
    ))
}

/// Deletes the temporary file on every way out — an error, or the task being
/// cancelled — unless it was published.
struct Temporary(Option<PathBuf>);

impl Drop for Temporary {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// Runs on the I/O runtime.
async fn save(fetcher: Arc<Fetcher>, url: &str, name: &str) -> anyhow::Result<PathBuf> {
    let dir = downloads_dir()?;
    let mut temporary = Temporary(Some(temporary_path(&dir, name)));
    let partial = temporary.0.clone().expect("just set");

    // An open handle on the cached copy: eviction may delete its name, but
    // not the file this download reads.
    let cached = match fetcher.disk().cloned() {
        Some(disk) if fetcher.is_persistent(url) => {
            let url = url.to_owned();
            tokio::task::spawn_blocking(move || disk.open_file(&url)).await?
        }
        _ => None,
    };
    match cached {
        Some(file) => {
            let mut source = tokio::fs::File::from_std(file);
            let mut target = tokio::fs::File::create(&partial)
                .await
                .context("creating the file")?;
            tokio::io::copy(&mut source, &mut target)
                .await
                .context("copying from the cache")?;
            target.flush().await?;
        }
        // Streamed: a clip can be hundreds of megabytes.
        None => stream(&fetcher, url, &partial).await?,
    }

    let published = {
        let (partial, dir, name) = (partial.clone(), dir.clone(), name.to_owned());
        tokio::task::spawn_blocking(move || publish(&partial, &dir, &name)).await?
    }
    .context("saving the file")?;
    temporary.0 = None;
    Ok(published)
}

async fn stream(fetcher: &Fetcher, url: &str, partial: &Path) -> anyhow::Result<()> {
    let mut response = tokio::time::timeout(HEADER_TIMEOUT, fetcher.http().get(url).send())
        .await
        .context("the server did not answer")?
        .with_context(|| format!("requesting {url}"))?;
    let status = response.status();
    if !status.is_success() {
        bail!("the server answered HTTP {status}");
    }
    let mut file = tokio::fs::File::create(partial)
        .await
        .context("creating the file")?;
    while let Some(chunk) = tokio::time::timeout(IDLE_TIMEOUT, response.chunk())
        .await
        .context("the download stalled")?
        .context("reading the download")?
    {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_file_after_its_key() {
        assert_eq!(name_for_key("grok/2026/abc.png").as_ref(), "abc.png");
        assert_eq!(name_for_key("plain.jpg").as_ref(), "plain.jpg");
    }

    #[test]
    fn publishing_never_replaces_and_temporaries_never_collide() {
        let dir = std::env::temp_dir().join(format!("artsnack-downloads-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // image.png and image.jpg once shared one ".download" path.
        assert_ne!(
            temporary_path(&dir, "image.png"),
            temporary_path(&dir, "image.jpg")
        );
        assert_ne!(
            temporary_path(&dir, "image.png"),
            temporary_path(&dir, "image.png")
        );
        let mut published = Vec::new();
        for body in ["one", "two", "three"] {
            let temporary = temporary_path(&dir, "image.png");
            fs::write(&temporary, body).unwrap();
            published.push(publish(&temporary, &dir, "image.png").unwrap());
            assert!(!temporary.exists());
        }
        let names: Vec<_> = published.iter().map(|path| file_name(path)).collect();
        assert_eq!(names, ["image.png", "image (2).png", "image (3).png"]);
        assert_eq!(fs::read_to_string(&published[0]).unwrap(), "one");
        assert_eq!(fs::read_to_string(&published[2]).unwrap(), "three");
        let _ = fs::remove_dir_all(&dir);
    }
}
