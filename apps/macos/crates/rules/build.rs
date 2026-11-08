//! Bundles the shared TypeScript the app runs with Bun into scripts embedded in
//! the binary: js/entry.ts (small rules, UI thread) and js/composer.ts (the API
//! composer and the Atlas catalogue, on a worker thread). Bun must be on PATH
//! (it is the repo's package manager; `bun install` at the repo root first).
//!
//! Cargo is told to rebuild from Bun's own list of what each bundle read (its
//! metafile), not from a guess at directories: composer.ts reaches into
//! apps/web/components/api for the result labels, and any new import from
//! anywhere is picked up the same way.

use std::{env, path::PathBuf, process::Command};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest
        .join("../../../..")
        .canonicalize()
        .expect("repo root");
    println!("cargo:rerun-if-env-changed=BUN");
    let bun = env::var("BUN").unwrap_or_else(|_| "bun".into());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    // shared.js loads on the UI thread at startup, so it carries only small
    // modules; composer.js holds the Atlas catalogue and loads on a worker.
    for (entry, out) in [
        ("js/entry.ts", "shared.js"),
        ("js/composer.ts", "composer.js"),
    ] {
        let entry = manifest.join(entry);
        // Watched before the build, so a failed build is retried after an edit.
        println!("cargo:rerun-if-changed={}", entry.display());
        let metafile = out_dir.join(format!("{out}.meta.json"));
        let status = Command::new(&bun)
            .current_dir(&repo)
            .args(["build", "--target=browser", "--format=iife", "--minify", "--outfile"])
            .arg(out_dir.join(out))
            .arg(format!("--metafile={}", metafile.display()))
            .arg(&entry)
            .status()
            .unwrap_or_else(|error| {
                panic!("could not run `{bun}` to bundle packages/shared ({error}); install Bun or set BUN=/path/to/bun")
            });
        assert!(status.success(), "bun build of {} failed", entry.display());
        for input in bundle_inputs(&metafile) {
            // Paths are relative to the directory Bun ran in.
            let path = repo.join(input);
            if path.exists() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

/// Every source file a bundle was built from, as Bun's metafile lists them.
fn bundle_inputs(metafile: &std::path::Path) -> Vec<String> {
    let text = std::fs::read_to_string(metafile)
        .unwrap_or_else(|error| panic!("reading {}: {error}", metafile.display()));
    let meta: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("parsing {}: {error}", metafile.display()));
    meta["inputs"]
        .as_object()
        .map(|inputs| inputs.keys().cloned().collect())
        .unwrap_or_default()
}
