use std::path::PathBuf;

/// The folder name under Application Support and Caches. Distinct from the
/// Electron app's "ArtSnack" so the two can run side by side.
const APP_DIR: &str = "ArtSnack Native";

/// `~/Library/Application Support/ArtSnack Native` on macOS
/// (`~/.local/share/ArtSnack Native` on Linux).
pub fn app_support_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(APP_DIR))
}

/// `~/Library/Caches/ArtSnack Native` on macOS (`~/.cache/ArtSnack Native` on
/// Linux): everything here can be deleted at any time and is re-downloaded.
pub fn cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|dir| dir.join(APP_DIR))
}
