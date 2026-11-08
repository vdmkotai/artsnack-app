//! The web app's shared TypeScript, run natively.
//!
//! `packages/shared` holds the rules both clients must agree on — the model
//! registry, form normalisation, pricing, recipe text. Porting them by hand
//! would mean every web change needs a Rust twin. Instead the build bundles
//! the modules listed in `js/entry.ts` and they run here in QuickJS, called
//! with JSON in and JSON out. Calls are synchronous and meant for small, fast
//! functions; anything that walks thousands of items belongs in Rust.

mod worker;

use anyhow::{Context as _, anyhow};
use gpui_kit::{App, Global};
use rquickjs::{Context, Ctx, Function, Object, Runtime};
use serde::{Serialize, de::DeserializeOwned};

pub use worker::JsWorker;

const BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/shared.js"));
/// The API composer's rules and the Atlas catalogue (js/composer.ts).
const COMPOSER_BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/composer.js"));

/// The worker running [`COMPOSER_BUNDLE`].
pub struct ComposerRules(JsWorker);

impl Global for ComposerRules {}

/// The API composer's rules, on their own thread.
pub fn composer(cx: &App) -> &JsWorker {
    &cx.global::<ComposerRules>().0
}

/// The shared code, loaded once per app.
pub struct Rules {
    // Field order matters: the context must drop before its runtime.
    context: Context,
    _runtime: Runtime,
}

impl Global for Rules {}

/// Loads the bundle. A broken bundle is a build bug, so it is reported loudly
/// and every later call fails with the same message.
pub fn init(cx: &mut App) {
    match Rules::load() {
        Ok(rules) => cx.set_global(rules),
        Err(error) => tracing::error!(?error, "could not load the shared TypeScript"),
    }
    // Started now so the catalogue is loaded by the time the API tab opens.
    cx.set_global(ComposerRules(JsWorker::spawn("composer", COMPOSER_BUNDLE)));
}

impl Rules {
    fn load() -> anyhow::Result<Self> {
        let runtime = Runtime::new().context("starting QuickJS")?;
        let context = Context::full(&runtime).context("creating a QuickJS context")?;
        context.with(|ctx| -> anyhow::Result<()> {
            ctx.eval::<(), _>(BUNDLE)
                .map_err(|error| js_error(&ctx, error))
                .context("evaluating the shared bundle")
        })?;
        Ok(Self {
            context,
            _runtime: runtime,
        })
    }

    pub fn global(cx: &App) -> Option<&Rules> {
        cx.try_global::<Rules>()
    }

    /// Reads an exported value, e.g. `promptEnhance.ENHANCE_MODELS`.
    pub fn get<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        let json = self.context.with(|ctx| -> anyhow::Result<String> {
            let shared = namespace(&ctx)?;
            let get: Function = shared.get("__get").map_err(|error| js_error(&ctx, error))?;
            get.call((path,)).map_err(|error| js_error(&ctx, error))
        })?;
        serde_json::from_str(&json).with_context(|| format!("decoding {path}"))
    }

    /// Calls an exported function with `args` (serialized as the arguments
    /// array, so pass a tuple or a `Vec`).
    pub fn call<A: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        args: &A,
    ) -> anyhow::Result<T> {
        let args = serde_json::to_string(args).context("encoding arguments")?;
        let json = self.context.with(|ctx| call_json(&ctx, path, args))?;
        serde_json::from_str(&json).with_context(|| format!("decoding the result of {path}"))
    }
}

/// `ArtsnackShared.__call(path, args)` in `ctx`, JSON in and out.
fn call_json(ctx: &Ctx<'_>, path: &str, args: String) -> anyhow::Result<String> {
    let shared = namespace(ctx)?;
    let call: Function = shared.get("__call").map_err(|error| js_error(ctx, error))?;
    call.call((path, args))
        .map_err(|error| js_error(ctx, error))
}

fn namespace<'js>(ctx: &Ctx<'js>) -> anyhow::Result<Object<'js>> {
    ctx.globals()
        .get("ArtsnackShared")
        .map_err(|error| js_error(ctx, error))
}

/// Turns a QuickJS exception into its message.
fn js_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> anyhow::Error {
    if matches!(error, rquickjs::Error::Exception) {
        let exception = ctx.catch();
        if let Some(exception) = exception.as_exception() {
            return anyhow!(
                "{}",
                exception
                    .message()
                    .unwrap_or_else(|| "JavaScript exception".into())
            );
        }
        return anyhow!("JavaScript threw {exception:?}");
    }
    anyhow!(error)
}

#[cfg(test)]
mod tests {
    use super::{BUNDLE, COMPOSER_BUNDLE, Rules};

    #[test]
    fn the_bundle_loads_and_exposes_the_registry() {
        let rules = Rules::load().expect("bundle loads");
        let models: Vec<serde_json::Value> = rules.get("promptEnhance.ENHANCE_MODELS").unwrap();
        assert!(!models.is_empty());
        let id: String = rules.get("promptEnhance.DEFAULT_ENHANCE_MODEL_ID").unwrap();
        assert!(models.iter().any(|model| model["id"] == id.as_str()));
        assert!(
            rules
                .get::<serde_json::Value>("promptEnhance.NOPE")
                .is_err()
        );
    }

    /// composer.ts end to end on its worker: a step takes the prompt apart
    /// from the form, and the view names the model its controls are for.
    #[test]
    fn the_composer_steps_a_form_on_its_worker() {
        use futures::executor::block_on;
        use serde_json::{Value, json};

        let worker = super::JsWorker::spawn("composer-test", COMPOSER_BUNDLE);
        let form: Value = block_on(worker.call_owned("composer.defaults", json!([]))).unwrap();
        let context = json!({ "refs": [], "quotes": {}, "hiddenProviders": [], "favorites": [] });
        let step: Value = block_on(worker.call_owned(
            "composer.step",
            (
                form,
                "a red fox",
                json!({ "kind": "provider", "provider": "atlas" }),
                context.clone(),
            ),
        ))
        .unwrap();
        assert_eq!(step["form"]["provider"], "atlas");
        assert_eq!(step["form"]["prompt"], "a red fox");
        let identity = step["view"]["identity"].as_str().unwrap();
        assert!(identity.starts_with("atlas:image:"), "{identity}");
        assert!(!step["view"]["fields"].as_array().unwrap().is_empty());

        let catalog: Value = block_on(worker.call_owned("composer.catalog", ("image",))).unwrap();
        assert!(catalog["rows"].as_array().unwrap().len() > 10);
        let again: Value = block_on(worker.call_owned("composer.catalog", ("image",))).unwrap();
        assert_eq!(catalog, again);
    }

    /// The web globals globals.ts provides exist in both bundles, and only
    /// there (QuickJS itself has none of them).
    #[test]
    fn both_bundles_have_the_web_globals() {
        for bundle in [BUNDLE, COMPOSER_BUNDLE] {
            let runtime = rquickjs::Runtime::new().unwrap();
            let context = rquickjs::Context::full(&runtime).unwrap();
            let read = |source: &str| -> String {
                context.with(|ctx| ctx.eval::<String, _>(source).unwrap())
            };
            assert_eq!(read("typeof URL"), "undefined");
            context.with(|ctx| ctx.eval::<(), _>(bundle).unwrap());
            assert_eq!(
                read("new URL('../b?x=1#y', 'https://Example.com/a/c').href"),
                "https://example.com/b?x=1#y"
            );
            assert_eq!(read("new URLSearchParams('a=1&b=x+y').get('b')"), "x y");
            assert_eq!(read("String(new TextEncoder().encode('é🙂').length)"), "6");
        }
    }
}
