//! Device-local preferences: the native counterpart of the web app's
//! `localStorage` keys (zoom, split ratios, preview density, saved form state).
//!
//! Everything lives in one JSON object on disk. Each feature declares its keys as
//! typed [`Preference`] constants next to the code that uses them, so the store
//! itself knows nothing about features. Reads are in-memory.
//!
//! - **Observing.** [`Preferences::observe`] (and its family variants) wakes a
//!   view only for its own keys. `observe_global::<Preferences>` still works
//!   but wakes for every write of every key that is not [`Preference::quiet`] —
//!   a keystroke in a saved prompt, a dragged split.
//! - **Saving.** Writes reach the disk after a short debounce, and at once when
//!   the app quits. One snapshot is committed at a time, each through its own
//!   temporary file renamed into place, and a snapshot older than the one on
//!   disk is dropped, so saves never interleave or go back in time.

use std::{
    cell::{Cell, RefCell},
    marker::PhantomData,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    thread::JoinHandle,
    time::Duration,
};

use anyhow::Context as _;
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, Global, SharedString, Subscription, Task,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};

mod paths;

pub use paths::{app_support_dir, cache_dir};

/// How long a burst of writes (a dragged split handle, held zoom keys) waits
/// before the file is rewritten.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);

/// A typed key into [`Preferences`] with the value used when it is unset or
/// unreadable.
pub struct Preference<T> {
    key: &'static str,
    default: fn() -> T,
    quiet: bool,
    _value: PhantomData<fn() -> T>,
}

impl<T> Preference<T> {
    /// Declares a preference. `key` is the stable on-disk name; never reuse one
    /// for a value of a different shape.
    pub const fn new(key: &'static str, default: fn() -> T) -> Self {
        Self {
            key,
            default,
            quiet: false,
            _value: PhantomData,
        }
    }

    /// Writes to this preference do not wake `observe_global::<Preferences>`
    /// observers, only [`Preferences::observe`] for this key. For values that
    /// change often and that no form renders from: the window's place, the
    /// screen last shown.
    pub const fn quiet(self) -> Self {
        Self {
            quiet: true,
            ..self
        }
    }

    pub fn key(&self) -> &'static str {
        self.key
    }
}

/// A family of preferences keyed by a runtime suffix, such as one split ratio
/// per composer: `generate.split.models`, `generate.split.api`, ….
pub struct PreferenceFamily<T> {
    prefix: &'static str,
    default: fn() -> T,
    quiet: bool,
    _value: PhantomData<fn() -> T>,
}

impl<T> PreferenceFamily<T> {
    pub const fn new(prefix: &'static str, default: fn() -> T) -> Self {
        Self {
            prefix,
            default,
            quiet: false,
            _value: PhantomData,
        }
    }

    /// Writes to members do not wake `observe_global::<Preferences>`
    /// observers; see [`Preference::quiet`].
    pub const fn quiet(self) -> Self {
        Self {
            quiet: true,
            ..self
        }
    }

    fn key(&self, member: &str) -> String {
        format!("{}.{member}", self.prefix)
    }
}

/// Whether `key` is a member of the family named `prefix`.
fn in_family(prefix: &str, key: &str) -> bool {
    key.strip_prefix(prefix)
        .is_some_and(|rest| rest.starts_with('.'))
}

/// The preference store, installed as a GPUI global by [`init`].
pub struct Preferences {
    /// Interior mutability so a quiet write does not go through
    /// `global_mut`, which wakes every `observe_global` observer.
    values: RefCell<Map<String, Value>>,
    /// Bumped by every change; the disk only ever moves forward.
    revision: Cell<u64>,
    /// `None` when there is nowhere to save (no data directory).
    writer: Option<Arc<Writer>>,
}

impl Global for Preferences {}

/// The debounced save, kept outside [`Preferences`]: replacing it must not
/// notify the store's observers.
struct PendingSave(#[allow(dead_code)] Option<Task<()>>);

impl Global for PendingSave {}

/// Emits a [`PreferenceChanged`] for every write, for keyed observers.
struct PreferenceEvents;

struct PreferenceChanged {
    key: SharedString,
}

impl EventEmitter<PreferenceChanged> for PreferenceEvents {}

struct PreferenceChanges(Entity<PreferenceEvents>);

impl Global for PreferenceChanges {}

/// The preferences file as read from disk.
struct Loaded {
    path: Option<PathBuf>,
    values: Map<String, Value>,
}

/// The preferences file, read on a thread of its own: start it first thing,
/// before the platform, and hand it to [`init_loaded`].
pub struct PreferencesLoad(Option<JoinHandle<Loaded>>);

/// Starts reading the preferences file in the background.
pub fn load_in_background() -> PreferencesLoad {
    let reader = std::thread::Builder::new()
        .name("artsnack-preferences".into())
        .spawn(read_file);
    match reader {
        Ok(handle) => PreferencesLoad(Some(handle)),
        Err(error) => {
            tracing::warn!(%error, "could not start reading preferences in the background");
            PreferencesLoad(None)
        }
    }
}

/// Loads the store from disk. A missing or corrupt file starts empty rather
/// than failing the launch; a corrupt one is kept aside for inspection.
pub fn init(cx: &mut App) {
    install(read_file(), cx);
}

/// [`init`] with a file read by [`load_in_background`]; waits for it if the
/// read is not done yet.
pub fn init_loaded(load: PreferencesLoad, cx: &mut App) {
    let loaded = load
        .0
        .and_then(|reader| reader.join().ok())
        .unwrap_or_else(read_file);
    install(loaded, cx);
}

fn install(loaded: Loaded, cx: &mut App) {
    cx.set_global(Preferences {
        values: RefCell::new(loaded.values),
        revision: Cell::new(0),
        writer: loaded.path.map(|path| Arc::new(Writer::new(path))),
    });
    let events = cx.new(|_| PreferenceEvents);
    cx.set_global(PreferenceChanges(events));
    // Changes from the last debounce window would otherwise be lost on Cmd-Q.
    cx.on_app_quit(Preferences::flush).detach();
}

fn read_file() -> Loaded {
    let path = app_support_dir().map(|dir| dir.join("preferences.json"));
    let values = path.as_deref().map(load).unwrap_or_default();
    Loaded { path, values }
}

fn load(path: &Path) -> Map<String, Value> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Map::new(),
        Err(error) => {
            tracing::warn!(?error, path = %path.display(), "could not read preferences");
            return Map::new();
        }
    };
    match serde_json::from_slice::<Map<String, Value>>(&bytes) {
        Ok(values) => values,
        Err(error) => {
            tracing::warn!(
                ?error,
                "preferences file is corrupt; starting from defaults"
            );
            let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
            Map::new()
        }
    }
}

impl Preferences {
    /// The value of `preference`, or its default when unset or of the wrong shape.
    pub fn get<T: DeserializeOwned>(cx: &App, preference: &Preference<T>) -> T {
        cx.global::<Self>()
            .read_key(preference.key, preference.default)
    }

    /// The value of one member of `family`.
    pub fn get_member<T: DeserializeOwned>(
        cx: &App,
        family: &PreferenceFamily<T>,
        member: &str,
    ) -> T {
        cx.global::<Self>()
            .read_key(&family.key(member), family.default)
    }

    /// Stores `value` and schedules a save. Observers are notified only when
    /// the stored value actually changes.
    pub fn set<T: Serialize>(cx: &mut App, preference: &Preference<T>, value: T) {
        Self::write_key(cx, preference.key.to_string(), value, preference.quiet);
    }

    pub fn set_member<T: Serialize>(
        cx: &mut App,
        family: &PreferenceFamily<T>,
        member: &str,
        value: T,
    ) {
        Self::write_key(cx, family.key(member), value, family.quiet);
    }

    /// Removes a stored value so the default applies again.
    pub fn reset<T>(cx: &mut App, preference: &Preference<T>) {
        {
            let store = cx.global::<Self>();
            if store.values.borrow_mut().remove(preference.key).is_none() {
                return;
            }
            store.bump();
        }
        Self::changed(cx, preference.key.into(), preference.quiet);
    }

    /// Calls `on_change` after `preference` changes — and for no other key,
    /// unlike `observe_global::<Preferences>`.
    pub fn observe<T, V: 'static>(
        cx: &mut Context<V>,
        preference: &Preference<T>,
        on_change: impl FnMut(&mut V, &mut Context<V>) + 'static,
    ) -> Subscription {
        let key = preference.key;
        Self::observe_keys(cx, move |changed| changed == key, on_change)
    }

    /// Calls `on_change` after one member of `family` changes.
    pub fn observe_member<T, V: 'static>(
        cx: &mut Context<V>,
        family: &PreferenceFamily<T>,
        member: &str,
        on_change: impl FnMut(&mut V, &mut Context<V>) + 'static,
    ) -> Subscription {
        let key = family.key(member);
        Self::observe_keys(cx, move |changed| changed == key, on_change)
    }

    /// Calls `on_change` after any member of `family` changes.
    pub fn observe_family<T, V: 'static>(
        cx: &mut Context<V>,
        family: &PreferenceFamily<T>,
        on_change: impl FnMut(&mut V, &mut Context<V>) + 'static,
    ) -> Subscription {
        let prefix = family.prefix;
        Self::observe_keys(cx, move |changed| in_family(prefix, changed), on_change)
    }

    fn observe_keys<V: 'static>(
        cx: &mut Context<V>,
        matches: impl Fn(&str) -> bool + 'static,
        mut on_change: impl FnMut(&mut V, &mut Context<V>) + 'static,
    ) -> Subscription {
        let events = cx.global::<PreferenceChanges>().0.clone();
        cx.subscribe(&events, move |this, _, changed: &PreferenceChanged, cx| {
            if matches(&changed.key) {
                on_change(this, cx);
            }
        })
    }

    /// Writes everything not yet on disk now, instead of after the debounce.
    /// Runs when the app quits.
    pub fn flush(cx: &mut App) -> Task<()> {
        if cx.has_global::<PendingSave>() {
            cx.set_global(PendingSave(None));
        }
        let Some(job) = Self::save_job(cx).filter(|job| !job.is_committed()) else {
            return Task::ready(());
        };
        cx.background_spawn(async move {
            if let Err(error) = job.run() {
                tracing::warn!(?error, "could not save preferences");
            }
        })
    }

    fn read_key<T: DeserializeOwned>(&self, key: &str, default: fn() -> T) -> T {
        self.values
            .borrow()
            .get(key)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_else(default)
    }

    fn bump(&self) {
        self.revision.set(self.revision.get() + 1);
    }

    fn write_key<T: Serialize>(cx: &mut App, key: String, value: T, quiet: bool) {
        let value = match serde_json::to_value(value) {
            Ok(value) => value,
            Err(error) => {
                tracing::error!(?error, key, "preference value does not serialize");
                return;
            }
        };
        {
            let store = cx.global::<Self>();
            let mut values = store.values.borrow_mut();
            if values.get(&key) == Some(&value) {
                return;
            }
            values.insert(key.clone(), value);
            store.bump();
        }
        Self::changed(cx, key.into(), quiet);
    }

    /// Tells observers about a change to `key` and schedules a save.
    fn changed(cx: &mut App, key: SharedString, quiet: bool) {
        if !quiet {
            // `global_mut` is what wakes `observe_global::<Preferences>`.
            cx.global_mut::<Self>();
        }
        let events = cx.global::<PreferenceChanges>().0.clone();
        events.update(cx, |_, cx| cx.emit(PreferenceChanged { key }));
        Self::schedule_save(cx);
    }

    fn schedule_save(cx: &mut App) {
        // Replacing the task drops (cancels) the previous debounce.
        let task = cx.spawn(async move |cx| {
            cx.background_executor().timer(SAVE_DEBOUNCE).await;
            let Some(job) = cx.update(Self::save_job) else {
                return;
            };
            let written = cx.background_spawn(async move { job.run() }).await;
            if let Err(error) = written {
                tracing::warn!(?error, "could not save preferences");
            }
        });
        cx.set_global(PendingSave(Some(task)));
    }

    /// A snapshot of the store to write, if there is anywhere to write it.
    fn save_job(cx: &mut App) -> Option<SaveJob> {
        let store = cx.global::<Self>();
        Some(SaveJob {
            writer: store.writer.clone()?,
            revision: store.revision.get(),
            values: Value::Object(store.values.borrow().clone()),
        })
    }
}

/// One snapshot on its way to disk.
struct SaveJob {
    writer: Arc<Writer>,
    revision: u64,
    values: Value,
}

impl SaveJob {
    fn is_committed(&self) -> bool {
        self.writer.committed() >= self.revision
    }

    fn run(&self) -> anyhow::Result<()> {
        self.writer.commit(self.revision, &self.values)
    }
}

/// Commits snapshots to the preferences file, one at a time.
struct Writer {
    path: PathBuf,
    /// The revision the file holds; the one loaded at launch is 0.
    committed: Mutex<u64>,
}

impl Writer {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: Mutex::new(0),
        }
    }

    fn committed(&self) -> u64 {
        *self
            .committed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Writes `values` as `revision`, unless the file already holds that
    /// revision or a later one. The lock is held for the whole write.
    fn commit(&self, revision: u64, values: &Value) -> anyhow::Result<()> {
        let mut committed = self
            .committed
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if revision <= *committed {
            return Ok(());
        }
        save(&self.path, revision, values)?;
        *committed = revision;
        Ok(())
    }
}

fn save(path: &Path, revision: u64, values: &Value) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("creating the preferences directory")?;
    }
    let bytes = serde_json::to_vec_pretty(values)?;
    // Unique per process and revision: no other write can be using it.
    let temporary = path.with_extension(format!("json.{}-{revision}.tmp", std::process::id()));
    let written = std::fs::write(&temporary, bytes)
        .context("writing preferences")
        .and_then(|()| std::fs::rename(&temporary, path).context("replacing preferences"));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_file(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("artsnack-settings-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("preferences.json")
    }

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn an_older_snapshot_never_overwrites_a_newer_one() {
        let path = scratch_file("order");
        let writer = Writer::new(path.clone());
        writer.commit(2, &serde_json::json!({ "v": 2 })).unwrap();
        writer.commit(1, &serde_json::json!({ "v": 1 })).unwrap();
        assert_eq!(read(&path), serde_json::json!({ "v": 2 }));
        assert_eq!(writer.committed(), 2);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_save_leaves_no_temporary_file() {
        let path = scratch_file("temporary");
        let writer = Writer::new(path.clone());
        writer.commit(1, &serde_json::json!({ "v": 1 })).unwrap();
        let dir = path.parent().unwrap();
        let names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("preferences.json")]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn family_membership_needs_the_separator() {
        assert!(in_family("generate.split", "generate.split.api"));
        assert!(!in_family("generate.split", "generate.splitter"));
        assert!(!in_family("generate.split", "generate.split"));
    }
}
