//! A size-capped disk cache for media bytes.
//!
//! Objects on the media origin never change — every writer puts a timestamp,
//! random suffix, content hash or provider id in the key — so an entry is valid
//! forever and is only ever evicted for space, least recently used first. That
//! is what the browser could not do: the media CDN sends `max-age=14400` with no
//! validator, so after four hours the browser downloaded a clip again in full.
//! Only the media origin's objects are stored here (see `fetch`); a third-party
//! URL may change behind the same address.
//!
//! Files are named by the SHA-256 of their URL — clips keep their extension,
//! which AVFoundation reads a local file's container from — and a small SQLite
//! index keeps sizes and last use. Every write goes to a temporary file of its
//! own and is renamed into place, so a crash never leaves a truncated entry and
//! two writers of the same URL never write into one file.
//!
//! Every method blocks on the file system or SQLite: call them from a blocking
//! thread (`spawn_blocking`, GPUI's background executor), never from the main
//! thread or a Tokio worker.

use std::{
    collections::HashMap,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context as _;
use parking_lot::Mutex;
use rusqlite::{Connection, params};
use sha2::{Digest as _, Sha256};

/// Bumping this starts a fresh cache directory.
const LAYOUT_VERSION: &str = "v1";
/// Where writes are assembled before they are renamed into place.
const TEMPORARY_DIR: &str = "tmp";

pub struct DiskCache {
    root: PathBuf,
    index: Mutex<Connection>,
    budget_bytes: Mutex<u64>,
    /// Entries in use outside the cache (a clip a player is reading), by file
    /// name, with how many users each has. Eviction and `clear` leave them.
    pins: Mutex<HashMap<String, usize>>,
    /// Makes temporary file names unique within the process.
    next_temporary: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiskUsage {
    pub entries: u64,
    pub bytes: u64,
}

/// Keeps one entry from eviction while it lives (a clip being played from its
/// cached file).
pub struct DiskPin {
    cache: Arc<DiskCache>,
    name: String,
}

impl Drop for DiskPin {
    fn drop(&mut self) {
        let mut pins = self.cache.pins.lock();
        if let Some(count) = pins.get_mut(&self.name) {
            *count -= 1;
            if *count == 0 {
                pins.remove(&self.name);
            }
        }
    }
}

impl DiskCache {
    pub fn open(dir: &Path, budget_bytes: u64) -> anyhow::Result<Self> {
        let root = dir.join(LAYOUT_VERSION);
        fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
        let temporary = root.join(TEMPORARY_DIR);
        fs::create_dir_all(&temporary)
            .with_context(|| format!("creating {}", temporary.display()))?;
        remove_stale_temporaries(&temporary);
        let index =
            Connection::open(root.join("index.sqlite")).context("opening the cache index")?;
        index.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS entries (
                 hash TEXT PRIMARY KEY,
                 bytes INTEGER NOT NULL,
                 last_used INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS entries_by_use ON entries (last_used);",
        )?;
        Ok(Self {
            root,
            index: Mutex::new(index),
            budget_bytes: Mutex::new(budget_bytes),
            pins: Mutex::new(HashMap::new()),
            next_temporary: AtomicU64::new(0),
        })
    }

    pub fn set_budget(&self, budget_bytes: u64) -> anyhow::Result<()> {
        *self.budget_bytes.lock() = budget_bytes;
        self.evict()
    }

    /// The cached bytes for `url`, marking the entry used.
    pub fn read(&self, url: &str) -> Option<Vec<u8>> {
        let name = hash(url);
        match fs::read(self.path(&name)) {
            Ok(bytes) => {
                self.touch(&name);
                Some(bytes)
            }
            Err(_) => {
                // A file deleted behind our back: drop its row too.
                self.forget_row(&name);
                None
            }
        }
    }

    /// The path of the cached file for `url`, if present.
    ///
    /// Superseded by [`Self::open_file`]: a path is not a hold on the file, and
    /// eviction may delete it before the caller opens it. Kept for callers that
    /// have not moved yet.
    pub fn file(&self, url: &str) -> Option<PathBuf> {
        let path = self.path(&hash(url));
        path.exists().then_some(path)
    }

    /// The cached file for `url`, open for reading and marked used. An open
    /// file stays readable even if eviction deletes its name meanwhile.
    pub fn open_file(&self, url: &str) -> Option<fs::File> {
        let name = hash(url);
        match fs::File::open(self.path(&name)) {
            Ok(file) => {
                self.touch(&name);
                Some(file)
            }
            Err(_) => {
                self.forget_row(&name);
                None
            }
        }
    }

    /// Stores `bytes` for `url`, then evicts down to the budget.
    pub fn write(&self, url: &str, bytes: &[u8]) -> anyhow::Result<()> {
        let (temporary, mut file) = self.create_temporary()?;
        let written = file
            .write_all(bytes)
            .and_then(|()| file.sync_data())
            .context("writing a cache entry");
        drop(file);
        if let Err(error) = written {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        self.insert_file(&hash(url), &temporary, bytes.len() as u64)
    }

    /// Drops the entry for `url` — bytes that turned out not to decode.
    pub fn remove(&self, url: &str) -> anyhow::Result<()> {
        let name = hash(url);
        let _ = fs::remove_file(self.path(&name));
        self.index
            .lock()
            .execute("DELETE FROM entries WHERE hash = ?1", params![name])?;
        Ok(())
    }

    /// A fresh temporary path inside the cache, for a write assembled
    /// elsewhere (a clip streamed from the network) and then handed to
    /// [`Self::insert_clip`]. Nothing else uses the name.
    pub fn temporary_path(&self) -> PathBuf {
        let n = self.next_temporary.fetch_add(1, Ordering::Relaxed);
        self.root
            .join(TEMPORARY_DIR)
            .join(format!("{}-{n}.part", std::process::id()))
    }

    /// Whether a clip for `url` is cached.
    pub fn has_clip(&self, url: &str) -> bool {
        self.path(&clip_name(url)).exists()
    }

    /// The cached clip for `url` and a pin that keeps it from eviction while
    /// a player reads it. Cheap enough for the main thread: one `stat`, no
    /// SQLite (call [`Self::touch_clip`] off the main thread to mark it used).
    pub fn pin_clip(self: &Arc<Self>, url: &str) -> Option<(PathBuf, DiskPin)> {
        let name = clip_name(url);
        // Pin before looking, so eviction cannot delete it in between.
        *self.pins.lock().entry(name.clone()).or_default() += 1;
        let pin = DiskPin {
            cache: self.clone(),
            name: name.clone(),
        };
        let path = self.path(&name);
        path.exists().then_some((path, pin))
    }

    /// Marks the cached clip for `url` used.
    pub fn touch_clip(&self, url: &str) {
        self.touch(&clip_name(url));
    }

    /// Moves a finished temporary file (see [`Self::temporary_path`]) into
    /// place as the clip for `url`, then evicts down to the budget.
    pub fn insert_clip(&self, url: &str, temporary: &Path, bytes: u64) -> anyhow::Result<()> {
        self.insert_file(&clip_name(url), temporary, bytes)
    }

    pub fn usage(&self) -> DiskUsage {
        let index = self.index.lock();
        index
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM entries",
                [],
                |row| {
                    Ok(DiskUsage {
                        entries: row.get::<_, i64>(0)? as u64,
                        bytes: row.get::<_, i64>(1)? as u64,
                    })
                },
            )
            .unwrap_or_default()
    }

    /// Deletes everything except the clips being played right now.
    pub fn clear(&self) -> anyhow::Result<()> {
        let index = self.index.lock();
        let names: Vec<String> = {
            let mut statement = index.prepare("SELECT hash FROM entries")?;
            statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?
        };
        let pins = self.pins.lock();
        for name in names {
            if pins.contains_key(&name) {
                continue;
            }
            let _ = fs::remove_file(self.path(&name));
            index.execute("DELETE FROM entries WHERE hash = ?1", params![name])?;
        }
        Ok(())
    }

    fn create_temporary(&self) -> anyhow::Result<(PathBuf, fs::File)> {
        let path = self.temporary_path();
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .with_context(|| format!("creating {}", path.display()))?;
        Ok((path, file))
    }

    /// Renames `temporary` into place as entry `name` — atomically replacing
    /// an identical copy another writer may have finished first — records it
    /// and evicts down to the budget.
    fn insert_file(&self, name: &str, temporary: &Path, bytes: u64) -> anyhow::Result<()> {
        let path = self.path(name);
        let placed = path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| fs::rename(temporary, &path));
        if let Err(error) = placed {
            let _ = fs::remove_file(temporary);
            return Err(error).context("placing a cache entry");
        }
        self.index.lock().execute(
            "INSERT INTO entries (hash, bytes, last_used) VALUES (?1, ?2, ?3)
             ON CONFLICT(hash) DO UPDATE SET bytes = excluded.bytes, last_used = excluded.last_used",
            params![name, bytes as i64, now()],
        )?;
        self.evict()
    }

    fn touch(&self, name: &str) {
        let _ = self.index.lock().execute(
            "UPDATE entries SET last_used = ?1 WHERE hash = ?2",
            params![now(), name],
        );
    }

    fn forget_row(&self, name: &str) {
        let _ = self
            .index
            .lock()
            .execute("DELETE FROM entries WHERE hash = ?1", params![name]);
    }

    /// Deletes least recently used entries, skipping pinned ones, until the
    /// total is within the budget. One pass over the index, not a query per
    /// entry.
    fn evict(&self) -> anyhow::Result<()> {
        let budget = *self.budget_bytes.lock() as i64;
        let index = self.index.lock();
        let total: i64 =
            index.query_row("SELECT COALESCE(SUM(bytes), 0) FROM entries", [], |row| {
                row.get(0)
            })?;
        if total <= budget {
            return Ok(());
        }
        let pins = self.pins.lock();
        let mut excess = total - budget;
        let mut victims = Vec::new();
        {
            let mut statement =
                index.prepare("SELECT hash, bytes FROM entries ORDER BY last_used ASC")?;
            let mut rows = statement.query([])?;
            while excess > 0
                && let Some(row) = rows.next()?
            {
                let name: String = row.get(0)?;
                if pins.contains_key(&name) {
                    continue;
                }
                excess -= row.get::<_, i64>(1)?;
                victims.push(name);
            }
        }
        for name in victims {
            let _ = fs::remove_file(self.path(&name));
            index.execute("DELETE FROM entries WHERE hash = ?1", params![name])?;
        }
        Ok(())
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(&name[..2]).join(name)
    }
}

/// Writes a crash interrupted: nothing refers to them. Only old ones, in case
/// another copy of the app is writing beside this one.
fn remove_stale_temporaries(dir: &Path) {
    const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(60 * 60);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > STALE_AFTER);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn hash(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A clip's entry name: the URL's hash and the extension of its path, so a
/// player opening the file knows its container.
fn clip_name(url: &str) -> String {
    let path = url::Url::parse(url)
        .map(|url| url.path().to_owned())
        .unwrap_or_default();
    let extension = Path::new(&path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| {
            (1..=5).contains(&extension.len())
                && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .unwrap_or_else(|| "mp4".to_owned());
    format!("{}.{extension}", hash(url))
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("artsnack-media-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn round_trips_and_evicts_least_recently_used() {
        let dir = temp_dir("evict");
        let cache = DiskCache::open(&dir, 10).unwrap();
        cache.write("a", b"12345").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.write("b", b"12345").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(cache.read("a").as_deref(), Some(&b"12345"[..]));
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.write("c", b"12345").unwrap();
        assert!(cache.read("b").is_none(), "b was least recently used");
        assert!(cache.read("a").is_some());
        assert!(cache.read("c").is_some());
        assert_eq!(cache.usage().bytes, 10);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_files_and_rows() {
        let dir = temp_dir("clear");
        let cache = DiskCache::open(&dir, 1_000).unwrap();
        cache.write("a", b"x").unwrap();
        cache.clear().unwrap();
        assert!(cache.read("a").is_none());
        assert_eq!(cache.usage(), DiskUsage::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writes_of_one_url_never_share_a_file() {
        let dir = temp_dir("concurrent");
        let cache = Arc::new(DiskCache::open(&dir, 1 << 30).unwrap());
        let body = vec![7u8; 256 * 1024];
        let writers: Vec<_> = (0..8)
            .map(|_| {
                let (cache, body) = (cache.clone(), body.clone());
                std::thread::spawn(move || cache.write("same", &body).unwrap())
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(cache.read("same").as_deref(), Some(&body[..]));
        assert_eq!(cache.usage().bytes, body.len() as u64);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pinned_clip_survives_eviction_and_clear() {
        let dir = temp_dir("pin");
        let cache = Arc::new(DiskCache::open(&dir, 10).unwrap());
        let url = "https://media.example.com/clips/a.MP4";
        let temporary = cache.temporary_path();
        fs::write(&temporary, b"12345678").unwrap();
        cache.insert_clip(url, &temporary, 8).unwrap();
        let (path, pin) = cache.pin_clip(url).unwrap();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("mp4"));
        std::thread::sleep(std::time::Duration::from_millis(5));
        cache.write("b", b"12345").unwrap();
        assert!(cache.has_clip(url), "pinned: not evicted for b");
        cache.clear().unwrap();
        assert!(cache.has_clip(url), "pinned: not cleared");
        drop(pin);
        cache.clear().unwrap();
        assert!(!cache.has_clip(url));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_open_file_survives_eviction_and_removal_drops_the_row() {
        let dir = temp_dir("open");
        let cache = DiskCache::open(&dir, 1_000).unwrap();
        cache.write("a", b"bytes").unwrap();
        let mut file = cache.open_file("a").unwrap();
        cache.remove("a").unwrap();
        let mut read = String::new();
        std::io::Read::read_to_string(&mut file, &mut read).unwrap();
        assert_eq!(read, "bytes");
        assert!(cache.open_file("a").is_none());
        assert_eq!(cache.usage(), DiskUsage::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
