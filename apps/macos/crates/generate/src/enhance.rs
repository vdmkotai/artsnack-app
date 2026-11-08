//! Enhance: Img2Img, Upscale, Refine and Face Fix on the self-hosted pod.
//!
//! The source goes to Convex storage first (the pod needs bytes, not a URL),
//! then `enhanceProcessor.enhance` runs and saves the result — the iOS app's
//! path, with no cookie-authenticated `/api/enhance`. Runs are fire-and-forget:
//! several can be in flight, and the results header counts them; the button
//! is held only while one press is being sent, by that run alone.
//!
//! - A picked file is previewed from a copy decoded off the main thread at
//!   display size, never through GPUI's own loader, which would decode the
//!   whole original and keep it for the life of the app (a 12000 px square is
//!   576 MB). The preview leaves the texture atlas when the input changes; the
//!   run still uploads the original bytes.
//! - Enhance (and Cmd+Enter, which reaches the form before a field sees Enter
//!   or loses focus) takes in every value still being typed first.
//! - Reproduce from another screen fetches the row first; its answer restores
//!   the settings only if nothing was changed meanwhile and no newer Reproduce
//!   was asked for.

use std::{collections::HashSet, path::PathBuf, sync::Arc};

use artsnack_library::{Feed, release_after_grace};

use artsnack_backend::{
    Backend, LiveQuery, NoArgs,
    api::{
        enhancements::{
            self, ENHANCE_DEADLINE, EnhanceArgs, EnhanceMode, Enhanced, Enhancement, FaceDetail,
            FaceDetector, RemoveArgs,
        },
        favorites::ToggleArgs,
        generations::FormState,
    },
};
use artsnack_library::FavoriteHearts;
use artsnack_media::{ImageRequest, Media, upload};
use artsnack_settings::{PreferenceFamily, Preferences};
use artsnack_ui::{
    DEFAULT_SPLIT_RATIO, Lightbox, LightboxEvent, LightboxItem, MediaGridState, MediaTile,
    SplitPane, TileAction, TileMedia, ZoomControl, ZoomScale, pane_zoom,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, ClipboardItem, Context, Entity, EventEmitter,
    ExternalPaths, FocusHandle, Focusable, FontWeight, ImageSource, InteractiveElement as _,
    IntoElement, KeyBinding, ObjectFit, ParentElement as _, PathPromptOptions, Render, RenderImage,
    SharedString, StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription,
    Task, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariant, ButtonVariants as _},
        h_flex,
        notification::Notification,
        skeleton::Skeleton,
        spinner::Spinner,
        switch::Switch,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
};
use serde_json::Value;

use crate::{
    backend_status::{BackendReady, BackendStatus, OpenBackendManager},
    controls::{NumberChanged, NumberField, NumberSpec},
    self_hosted::{ComposerKind, SelfHostedComposer},
};

actions!(enhance, [RunEnhancement]);

const CONTEXT: &str = "Enhance";

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-enter", RunEnhancement, Some(CONTEXT)),
        // Inside a text field too, ahead of the field's own Cmd+Enter (which
        // would also insert a newline): see `artsnack_ui::field_in`.
        KeyBinding::new(
            "cmd-enter",
            RunEnhancement,
            Some(&artsnack_ui::field_in(CONTEXT)),
        ),
    ]);
}

const REFINE_DENOISE: NumberSpec = NumberSpec {
    min: 0.1,
    max: 1.0,
    step: 0.05,
    decimals: 2,
    fallback: 0.3,
};
const FACE_STRENGTH: NumberSpec = NumberSpec {
    min: 0.15,
    max: 0.8,
    step: 0.05,
    decimals: 2,
    fallback: 0.4,
};
const SPLIT: PreferenceFamily<f32> = PreferenceFamily::new("enhance.split", || DEFAULT_SPLIT_RATIO);
/// The input preview's longest side in device pixels, as for a URL source.
const PREVIEW_PIXELS: u32 = 1024;
const FORM_ZOOM: PreferenceFamily<f32> = PreferenceFamily::new("enhance.formZoom", || 1.0);

/// Where the image to enhance came from.
#[derive(Clone, Debug, PartialEq)]
enum Source {
    File(PathBuf),
    /// A result elsewhere in the app ("Send to Enhance").
    Url {
        url: SharedString,
        b2_key: Option<String>,
        /// The self-hosted form that drew it: Refine and Face Fix re-render
        /// with its checkpoint, prompt and LoRAs, as the web's
        /// `sourceFormState` does.
        form_state: Option<Box<FormState>>,
    },
}

/// A picked file's preview: decoding, decoded, or unreadable.
enum FilePreview {
    Decoding,
    Ready(Arc<RenderImage>),
    Failed(SharedString),
}

/// Asks the shell to route something elsewhere.
#[derive(Clone, Debug)]
pub enum EnhanceEvent {
    OpenBackendManager,
    UseAsReference { image_url: SharedString },
}

pub struct EnhanceView {
    focus_handle: FocusHandle,
    mode: EnhanceMode,
    img2img: Entity<SelfHostedComposer>,
    scale: &'static str,
    refine_denoise: Entity<NumberField>,
    face_detail: FaceDetail,
    face_strength: Entity<NumberField>,
    face_detector: FaceDetector,
    refine_eyes: bool,
    source: Option<Source>,
    /// The preview of a file source, and its decoding (dropped with a newer
    /// source).
    preview: Option<FilePreview>,
    _decode: Option<Task<()>>,
    /// Runs in flight.
    running: usize,
    /// The run whose press is being sent: the button is held until that run,
    /// and only that one, has taken its bytes.
    sending: Option<u64>,
    runs: u64,
    /// Bumped by every change of the settings made here, so a Reproduce that
    /// answers late can tell the form moved on.
    edits: u64,
    /// The newest Reproduce asked for; an older answer is dropped.
    reproduce_request: u64,
    _reproduce: Option<Task<()>>,
    backend_status: Entity<BackendStatus>,
    /// The results; released while the screen stays hidden.
    results: Feed<LiveQuery<Vec<Enhancement>>>,
    /// The results as the query last delivered them.
    live_rows: Arc<Vec<Enhancement>>,
    /// `live_rows` less [`Self::removing`]: what the grid shows.
    rows: Arc<Vec<Enhancement>>,
    /// Deleted here and maybe still listed: off the grid until the query
    /// drops them, or back if the delete fails.
    removing: HashSet<String>,
    hearts: Entity<FavoriteHearts>,
    grid: MediaGridState,
    lightbox: Option<(Entity<Lightbox>, Subscription)>,
    refine_value: f64,
    face_strength_value: f64,
    active: bool,
    _release: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<EnhanceEvent> for EnhanceView {}

impl EnhanceView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let img2img = cx.new(|cx| SelfHostedComposer::new(ComposerKind::Img2Img, window, cx));
        let refine_denoise =
            cx.new(|cx| NumberField::new(REFINE_DENOISE.fallback, REFINE_DENOISE, window, cx));
        let face_strength =
            cx.new(|cx| NumberField::new(FACE_STRENGTH.fallback, FACE_STRENGTH, window, cx));
        let backend_status = cx.new(BackendStatus::new);
        let hearts = cx.new(FavoriteHearts::new);
        let subscriptions = vec![
            cx.subscribe(&refine_denoise, |this, _, NumberChanged(value), cx| {
                this.refine_value = *value;
                this.edits += 1;
                cx.notify();
            }),
            cx.subscribe(&face_strength, |this, _, NumberChanged(value), cx| {
                this.face_strength_value = *value;
                this.edits += 1;
                cx.notify();
            }),
            cx.subscribe(&backend_status, |_, _, _: &OpenBackendManager, cx| {
                cx.emit(EnhanceEvent::OpenBackendManager)
            }),
            cx.subscribe_in(
                &backend_status,
                window,
                |this, _, _: &BackendReady, window, cx| {
                    this.img2img
                        .update(cx, |composer, cx| composer.refresh_catalog(window, cx));
                },
            ),
            cx.observe(&hearts, |_, _, cx| cx.notify()),
            Preferences::observe_member(cx, &FORM_ZOOM, "enhance", |_, cx| cx.notify()),
            Preferences::observe_member(cx, &SPLIT, "enhance", |_, cx| cx.notify()),
        ];
        let mut this = Self {
            focus_handle: cx.focus_handle(),
            mode: EnhanceMode::Img2img,
            img2img,
            scale: "4",
            refine_denoise,
            face_detail: FaceDetail::High,
            face_strength,
            face_detector: FaceDetector::Accurate,
            refine_eyes: false,
            source: None,
            preview: None,
            _decode: None,
            running: 0,
            sending: None,
            runs: 0,
            edits: 0,
            reproduce_request: 0,
            _reproduce: None,
            backend_status,
            results: Feed::default(),
            live_rows: Arc::default(),
            rows: Arc::default(),
            removing: HashSet::new(),
            hearts,
            grid: MediaGridState::new(),
            lightbox: None,
            refine_value: REFINE_DENOISE.fallback,
            face_strength_value: FACE_STRENGTH.fallback,
            active: true,
            _release: None,
            _subscriptions: subscriptions,
        };
        this.connect(cx);
        this
    }

    /// Subscribes to the results, starting from the ones last delivered.
    fn connect(&mut self, cx: &mut Context<Self>) {
        self.results.connect(
            |cx| LiveQuery::new(enhancements::LIST, &NoArgs {}, cx),
            Self::results_changed,
            cx,
        );
        self.results_changed(cx);
    }

    /// Whether the screen is shown (the shell says so). Hidden, it keeps its
    /// results and lets go of their subscriptions after a grace period; shown
    /// again, it subscribes from where it was. Runs in flight carry on.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if active == self.active {
            return;
        }
        self.active = active;
        self.hearts
            .update(cx, |hearts, cx| hearts.set_active(active, cx));
        if active {
            self._release = None;
            self.connect(cx);
        } else {
            self._release = Some(release_after_grace(cx, |this, _| {
                this.results.release();
            }));
        }
    }

    fn rows(&self) -> Arc<Vec<Enhancement>> {
        self.rows.clone()
    }

    fn results_changed(&mut self, cx: &mut Context<Self>) {
        let Some(live_rows) = self
            .results
            .get()
            .and_then(|results| results.read(cx).data().cloned())
        else {
            return;
        };
        self.removing
            .retain(|id| live_rows.iter().any(|row| &row.id == id));
        self.live_rows = live_rows;
        self.show_rows(cx);
    }

    fn show_rows(&mut self, cx: &mut Context<Self>) {
        self.rows = if self.removing.is_empty() {
            self.live_rows.clone()
        } else {
            Arc::new(
                self.live_rows
                    .iter()
                    .filter(|row| !self.removing.contains(&row.id))
                    .cloned()
                    .collect(),
            )
        };
        if let Some((lightbox, _)) = &self.lightbox {
            let urls = Media::urls(cx).clone();
            let items: Vec<LightboxItem> = self
                .rows
                .iter()
                .map(|row| lightbox_item(row, &urls))
                .collect();
            lightbox.update(cx, |lightbox, cx| lightbox.set_items(items, false, cx));
        }
        cx.notify();
    }

    /// Makes `source` the input. A file is decoded for its preview off the
    /// main thread; the previous preview leaves the texture atlas.
    fn set_source(&mut self, source: Option<Source>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(FilePreview::Ready(image)) = self.preview.take() {
            cx.drop_image(image, Some(window));
        }
        if let Some(Source::File(path)) = &source {
            let path = path.clone();
            let decode = cx.background_spawn(async move {
                std::fs::read(&path)
                    .map_err(|error| error.to_string())
                    .and_then(|bytes| {
                        artsnack_media::decode::decode(&bytes, Some(PREVIEW_PIXELS))
                            .map_err(|error| error.to_string())
                    })
            });
            self._decode = Some(cx.spawn(async move |this, cx| {
                let decoded = decode.await;
                let _ = this.update(cx, |this, cx| {
                    this.preview = Some(match decoded {
                        Ok(image) => FilePreview::Ready(Arc::new(image)),
                        Err(error) => {
                            FilePreview::Failed(format!("Could not read the image: {error}").into())
                        }
                    });
                    cx.notify();
                });
            }));
            self.preview = Some(FilePreview::Decoding);
        } else {
            self._decode = None;
        }
        self.source = source;
        cx.notify();
    }

    /// "Send to Enhance" from another screen: this image becomes the input, and
    /// a self-hosted source's form fills Img2Img.
    pub fn set_source_url(
        &mut self,
        url: SharedString,
        form_state: Option<&Value>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let b2_key = Media::urls(cx).key_of(&url).map(str::to_string);
        let source = Source::Url {
            url,
            b2_key,
            form_state: form_state
                .and_then(|form| serde_json::from_value(form.clone()).ok())
                .map(Box::new),
        };
        self.set_source(Some(source), window, cx);
        if let Some(form) = form_state {
            self.img2img
                .update(cx, |composer, cx| composer.merge_saved(form, window, cx));
        }
        window.push_notification(Notification::success("Image set as input"), cx);
        cx.notify();
    }

    fn pick_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Choose".into()),
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await
                && let Some(path) = paths.into_iter().next()
            {
                let _ = window_handle.update(cx, |_, window, cx| {
                    let _ = this.update(cx, |this, cx| {
                        this.set_source(Some(Source::File(path)), window, cx)
                    });
                });
            }
        })
        .detach();
    }

    fn drop_files(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let image = paths.paths().iter().find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_lowercase().as_str(),
                        "png" | "jpg" | "jpeg" | "webp"
                    )
                })
        });
        match image {
            Some(path) => self.set_source(Some(Source::File(path.clone())), window, cx),
            None => {
                window.push_notification(Notification::error("Drop a PNG, JPG or WEBP image"), cx)
            }
        }
    }

    /// Takes in every value still being typed, as Enter or leaving the field
    /// would: Cmd+Enter runs before either.
    fn commit_drafts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.img2img
            .update(cx, |composer, cx| composer.commit_drafts(window, cx));
        self.refine_value = self
            .refine_denoise
            .update(cx, |field, cx| field.commit(window, cx));
        self.face_strength_value = self
            .face_strength
            .update(cx, |field, cx| field.commit(window, cx));
    }

    fn run(&mut self, _: &RunEnhancement, window: &mut Window, cx: &mut Context<Self>) {
        if self.sending.is_some() {
            return;
        }
        let Some(source) = self.source.clone() else {
            window.push_notification(Notification::error("Please upload an image first"), cx);
            return;
        };
        self.commit_drafts(window, cx);
        let mut args = self.build_args(&source, cx);
        let mode = self.mode;
        self.runs += 1;
        let run = self.runs;
        self.sending = Some(run);
        self.running += 1;
        cx.notify();

        let fetcher = Media::fetcher(cx);
        let backend = Backend::global(cx);
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result: Result<Enhanced, SharedString> = async {
                // 1. The bytes, from the file or the CDN.
                let bytes = match &source {
                    Source::File(path) => {
                        let path = path.clone();
                        cx.background_executor()
                            .spawn(async move { std::fs::read(&path) })
                            .await
                            .map_err(|error| {
                                SharedString::from(format!("Could not read the image: {error}"))
                            })?
                    }
                    Source::Url { url, .. } => {
                        let url = url.to_string();
                        let fetcher = fetcher.clone();
                        let task = cx.update(|cx| {
                            artsnack_runtime::spawn_result(cx, async move {
                                fetcher.image_bytes(&url).await
                            })
                        });
                        task.await
                            .map_err(|error| SharedString::from(error.to_string()))?
                    }
                };
                let _ = this.update(cx, |this, cx| this.sent(run, cx));
                // 2. Upload to Convex storage.
                let upload_url = cx
                    .update(|cx| {
                        backend.update(cx, |backend, cx| {
                            backend.mutate(enhancements::UPLOAD_URL, &NoArgs {}, cx)
                        })
                    })
                    .await
                    .map_err(|error| error.user_message())?;
                let content_type = upload::image_content_type(&bytes);
                let task = cx.update(|cx| {
                    artsnack_runtime::spawn_result(cx, async move {
                        upload::upload_bytes(&upload_url, bytes, content_type).await
                    })
                });
                args.source_storage_id = task
                    .await
                    .map_err(|error| SharedString::from(error.to_string()))?;
                // 3. Enhance; resolves when the result is saved.
                cx.update(|cx| {
                    backend.update(cx, |backend, cx| {
                        backend.act_within(enhancements::ENHANCE, &args, ENHANCE_DEADLINE, cx)
                    })
                })
                .await
                .map_err(|error| error.user_message())
            }
            .await;

            let _ = this.update(cx, |this, cx| {
                this.sent(run, cx);
                this.running = this.running.saturating_sub(1);
                cx.notify();
            });
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(enhanced) => match enhanced.warning {
                    Some(warning) => window.push_notification(Notification::warning(warning), cx),
                    None => window.push_notification(
                        Notification::success(format!("{} complete", mode.label())),
                        cx,
                    ),
                },
                Err(message) => window.push_notification(Notification::error(message), cx),
            });
        })
        .detach();
    }

    /// Run `run`'s press is accepted: another run may start now. A run that
    /// finishes after a newer press leaves that press's hold alone.
    fn sent(&mut self, run: u64, cx: &mut Context<Self>) {
        if self.sending == Some(run) {
            self.sending = None;
            cx.notify();
        }
    }

    fn build_args(&self, source: &Source, cx: &App) -> EnhanceArgs {
        let mut args = EnhanceArgs {
            mode: self.mode,
            ..EnhanceArgs::default()
        };
        if let Source::Url {
            b2_key, form_state, ..
        } = source
        {
            args.source_b2_key = b2_key.clone();
            // Refine and Face Fix have no form of their own: they re-render
            // with what drew the source.
            if let (EnhanceMode::Refine | EnhanceMode::Facefix, Some(form)) =
                (self.mode, form_state)
            {
                args.checkpoint =
                    Some(form.checkpoint.clone()).filter(|checkpoint| !checkpoint.is_empty());
                args.prompt = Some(form.prompt.clone()).filter(|prompt| !prompt.is_empty());
                args.negative_prompt =
                    Some(form.negative_prompt.clone()).filter(|prompt| !prompt.is_empty());
                let loras: Vec<_> = form
                    .loras
                    .iter()
                    .filter(|slot| slot.enabled && !slot.lora_name.is_empty())
                    .cloned()
                    .collect();
                args.loras = (!loras.is_empty()).then_some(loras);
            }
        }
        match self.mode {
            EnhanceMode::Img2img => {
                let form = self.img2img.read(cx).form().clone();
                args.prompt = Some(form.prompt);
                args.negative_prompt = Some(form.negative_prompt);
                args.checkpoint = Some(form.checkpoint).filter(|checkpoint| !checkpoint.is_empty());
                args.sampler = Some(form.sampler).filter(|sampler| !sampler.is_empty());
                args.scheduler = Some(form.scheduler).filter(|scheduler| !scheduler.is_empty());
                args.steps = Some(form.steps);
                args.cfg = Some(form.cfg);
                args.seed = Some(form.seed);
                args.denoise = Some(form.denoise);
                let loras: Vec<_> = form
                    .loras
                    .into_iter()
                    .filter(|slot| slot.enabled && !slot.lora_name.is_empty())
                    .collect();
                args.loras = (!loras.is_empty()).then_some(loras);
            }
            EnhanceMode::Upscale => args.scale = Some(self.scale.to_string()),
            EnhanceMode::Refine => args.denoise = Some(self.refine_value),
            EnhanceMode::Facefix => {
                args.denoise = Some(self.face_strength_value);
                args.face_detail = Some(self.face_detail);
                args.face_detector = Some(self.face_detector);
                args.refine_eyes = Some(self.refine_eyes);
            }
        }
        args
    }

    /// Reproduce from another screen (a favourited enhancement): fetches the
    /// row, then restores its settings — unless a newer Reproduce was asked
    /// for, or the settings were changed here, while it loaded.
    pub fn reproduce_by_id(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.reproduce_request += 1;
        let request = self.reproduce_request;
        let edits = self.edits;
        let form = self.img2img.read(cx).form().clone();
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.query(enhancements::GET_BY_ID, &enhancements::ByIdArgs { id }, cx)
        });
        let window_handle = window.window_handle();
        // Replacing the task drops the previous hand-off.
        self._reproduce = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = window_handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    if this.reproduce_request != request {
                        return;
                    }
                    match result {
                        Ok(Some(_))
                            if this.edits != edits || *this.img2img.read(cx).form() != form =>
                        {
                            window.push_notification(
                                Notification::warning(
                                    "The settings changed while that enhancement loaded, so they were kept.",
                                ),
                                cx,
                            )
                        }
                        Ok(Some(enhancement)) => this.reproduce(&enhancement, window, cx),
                        Ok(None) => window.push_notification(
                            Notification::error("That enhancement no longer exists"),
                            cx,
                        ),
                        Err(error) => {
                            window.push_notification(Notification::error(error.user_message()), cx)
                        }
                    }
                });
            });
        }));
    }

    /// Restores a saved enhancement's settings (not its source image).
    fn reproduce(
        &mut self,
        enhancement: &Enhancement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(mode) = EnhanceMode::parse(&enhancement.mode) else {
            window.push_notification(
                Notification::error("That enhancement is no longer available"),
                cx,
            );
            return;
        };
        // A pending Reproduce from elsewhere must not land over this one.
        self.reproduce_request += 1;
        self.mode = mode;
        let params = enhancement.params.clone().unwrap_or(Value::Null);
        match mode {
            EnhanceMode::Img2img => {
                self.img2img
                    .update(cx, |composer, cx| composer.reproduce(&params, window, cx));
                return;
            }
            EnhanceMode::Upscale => {
                // Stored as a number by the web and as "2"/"4" by iOS.
                let scale = params.get("scale").map(|scale| match scale {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                });
                self.scale = if scale.as_deref() == Some("2") {
                    "2"
                } else {
                    "4"
                };
            }
            EnhanceMode::Refine => {
                if let Some(denoise) = params.get("denoise").and_then(Value::as_f64) {
                    self.refine_denoise
                        .update(cx, |field, cx| field.set_value(denoise, window, cx));
                    self.refine_value = self.refine_denoise.read(cx).value();
                }
            }
            // Face Fix stores its strength as `denoise` (filled in with the
            // default when the run left it out).
            EnhanceMode::Facefix => {
                if let Some(strength) = params.get("denoise").and_then(Value::as_f64) {
                    self.face_strength
                        .update(cx, |field, cx| field.set_value(strength, window, cx));
                    self.face_strength_value = self.face_strength.read(cx).value();
                }
            }
        }
        window.push_notification(Notification::success("Settings restored"), cx);
        cx.notify();
    }

    fn confirm_delete(&self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let id = id.clone();
            let view = view.clone();
            alert
                .title("Delete this enhanced image?")
                .description("The result goes with it.")
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let id = id.clone();
                    let _ = view.update(cx, |this, cx| this.delete(id, window, cx));
                    true
                })
        });
    }

    /// Takes the result off the grid now; a failed delete puts it back.
    fn delete(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.removing.insert(id.clone());
        self.show_rows(cx);
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(enhancements::REMOVE, &RemoveArgs { id: id.clone() }, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            if let Err(error) = task.await {
                let _ = this.update(cx, |this, cx| {
                    this.removing.remove(&id);
                    this.show_rows(cx);
                });
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(
                        Notification::error(format!(
                            "Couldn\u{2019}t delete the enhanced image. {}",
                            error.user_message()
                        )),
                        cx,
                    )
                });
            }
        })
        .detach();
    }

    fn toggle_args(row: &Enhancement) -> ToggleArgs {
        ToggleArgs {
            enhancement_id: Some(row.id.clone()),
            b2_key: row.result_b2_key.clone(),
            ..ToggleArgs::default()
        }
    }

    fn actions_for(&self, row: &Enhancement, cx: &mut Context<Self>) -> Vec<TileAction> {
        let urls = Media::urls(cx).clone();
        let view = cx.entity().downgrade();
        let mut actions = Vec::new();
        {
            let view = view.clone();
            let row = row.clone();
            actions.push(TileAction::new(
                "reproduce",
                IconName::RefreshCw,
                "Reproduce",
                move |window, cx| {
                    let _ = view.update(cx, |this, cx| this.reproduce(&row, window, cx));
                },
            ));
        }
        {
            let view = view.clone();
            let url: SharedString = urls.original(&row.result_b2_key).into();
            actions.push(TileAction::new(
                "enhance-again",
                IconName::Zap,
                "Send to Enhance",
                move |window, cx| {
                    let url = url.clone();
                    let _ = view.update(cx, |this, cx| this.set_source_url(url, None, window, cx));
                },
            ));
        }
        {
            let view = view.clone();
            let url: SharedString = urls.original(&row.result_b2_key).into();
            actions.push(TileAction::new(
                "reference",
                IconName::Sparkles,
                "Send to API as reference",
                move |_, cx| {
                    let image_url = url.clone();
                    let _ = view.update(cx, |_, cx| {
                        cx.emit(EnhanceEvent::UseAsReference { image_url })
                    });
                },
            ));
        }
        if let Some(prompt) = row.prompt().map(str::to_string) {
            actions.push(TileAction::new(
                "copy-prompt",
                IconName::Copy,
                "Copy prompt",
                move |window, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(prompt.clone()));
                    window.push_notification(Notification::success("Prompt copied"), cx);
                },
            ));
        }
        actions
    }

    fn open_lightbox(&mut self, key: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let urls = Media::urls(cx).clone();
        let items = self
            .rows()
            .iter()
            .map(|row| lightbox_item(row, &urls))
            .collect();
        let view = cx.entity().downgrade();
        let lightbox = Lightbox::new(
            items,
            key,
            false,
            move |item, _, cx| {
                view.upgrade()
                    .map(|view| {
                        view.update(cx, |this, cx| {
                            let rows = this.rows();
                            let Some(row) = rows.iter().find(|row| row.id == item.key.as_ref())
                            else {
                                return Vec::new();
                            };
                            // The heart once favourites are known: the
                            // server toggles.
                            let mut actions: Vec<TileAction> = FavoriteHearts::viewer_action(
                                &this.hearts,
                                Self::toggle_args(row),
                                cx,
                            )
                            .into_iter()
                            .collect();
                            actions.extend(this.actions_for(row, cx));
                            actions.push(TileAction::download(&row.result_b2_key, cx));
                            let id = row.id.clone();
                            let delete_view = cx.entity().downgrade();
                            actions.push(TileAction::new(
                                "delete",
                                IconName::Trash,
                                "Delete",
                                move |window, cx| {
                                    let id = id.clone();
                                    let _ = delete_view
                                        .update(cx, |this, cx| this.confirm_delete(id, window, cx));
                                },
                            ));
                            actions
                        })
                    })
                    .unwrap_or_default()
            },
            |_, _, _| None,
            cx,
        );
        let subscription = cx.subscribe_in(&lightbox, window, |this, _, event, window, cx| {
            if *event == LightboxEvent::Closed {
                this.lightbox = None;
                this.focus_handle.focus(window, cx);
                cx.notify();
            }
        });
        lightbox.read(cx).focus_handle(cx).focus(window, cx);
        self.lightbox = Some((lightbox, subscription));
        cx.notify();
    }

    // --- Rendering ----------------------------------------------------------

    fn render_input(&self, cx: &mut Context<Self>) -> AnyElement {
        match &self.source {
            None => v_flex()
                .id("enhance-input")
                .items_center()
                .justify_center()
                .gap_2()
                .h_48()
                .rounded(cx.theme().radius_lg)
                .border_2()
                .border_dashed()
                .border_color(cx.theme().border)
                .cursor_pointer()
                .hover(|style| style.border_color(cx.theme().ring))
                .drag_over::<ExternalPaths>(|style, _, _, cx| {
                    style.border_color(cx.theme().primary).bg(cx.theme().accent)
                })
                .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                    this.drop_files(paths, window, cx)
                }))
                .on_click(cx.listener(|this, _, window, cx| this.pick_file(window, cx)))
                .child(gpui_kit::component::Icon::new(IconName::Upload))
                .child(div().text_sm().child("Click or drag to upload"))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("PNG, JPG, or WEBP"),
                )
                .into_any_element(),
            Some(source) => {
                div()
                    .id("enhance-input")
                    .relative()
                    .h_64()
                    .rounded(cx.theme().radius_lg)
                    .border_1()
                    .border_color(cx.theme().border)
                    .overflow_hidden()
                    .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                        this.drop_files(paths, window, cx)
                    }))
                    .child(self.render_preview(source, cx))
                    .child(
                        div().absolute().top_2().right_2().child(
                            Button::new("clear-input")
                                .icon(IconName::X)
                                .xsmall()
                                .tooltip("Remove image")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.set_source(None, window, cx)
                                })),
                        ),
                    )
                    .into_any_element()
            }
        }
    }

    /// The input: a URL through the media pipeline, a file from its own
    /// bounded preview.
    fn render_preview(&self, source: &Source, cx: &App) -> AnyElement {
        let image = |source: ImageSource| {
            img(source)
                .size_full()
                .object_fit(ObjectFit::Contain)
                .into_any_element()
        };
        let centered = |child: AnyElement| {
            v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .child(child)
                .into_any_element()
        };
        match (source, &self.preview) {
            (Source::Url { url, .. }, _) => image(artsnack_media::media_image(
                ImageRequest::new(url.clone()).max_dimension(PREVIEW_PIXELS),
            )),
            (Source::File(_), Some(FilePreview::Ready(preview))) => {
                image(ImageSource::Render(preview.clone()))
            }
            (Source::File(_), Some(FilePreview::Failed(message))) => centered(
                div()
                    .px_4()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(message.clone())
                    .into_any_element(),
            ),
            (Source::File(_), _) => centered(Spinner::new().into_any_element()),
        }
    }

    fn render_mode_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        match self.mode {
            EnhanceMode::Img2img => self.img2img.clone().into_any_element(),
            EnhanceMode::Upscale => v_flex()
                .p_4()
                .gap_2()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child("Upscale factor"),
                )
                .child(
                    ButtonGroup::new("upscale")
                        .outline()
                        .child(Button::new("2x").label("2×").selected(self.scale == "2"))
                        .child(Button::new("4x").label("4×").selected(self.scale == "4"))
                        .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                            this.edits += 1;
                            this.scale = if selected.first() == Some(&0) {
                                "2"
                            } else {
                                "4"
                            };
                            cx.notify();
                        })),
                )
                .into_any_element(),
            EnhanceMode::Refine => v_flex()
                .p_4()
                .gap_2()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child("Denoise"),
                )
                .child(self.refine_denoise.clone())
                .into_any_element(),
            EnhanceMode::Facefix => {
                let detail = self.face_detail;
                let detector = self.face_detector;
                v_flex()
                    .p_4()
                    .gap_4()
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child("Re-renders faces with the source picture's own checkpoint, prompt and LoRAs when it came from a self-hosted generation, else with the realism fallback checkpoint."),
                    )
                    .child(
                        v_flex()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Face resolution"))
                            .child(
                                ButtonGroup::new("face-detail")
                                    .outline()
                                    .small()
                                    .child(Button::new("standard").label("Standard").tooltip("512 px").selected(detail == FaceDetail::Standard))
                                    .child(Button::new("high").label("High").tooltip("640 px").selected(detail == FaceDetail::High))
                                    .child(Button::new("max").label("Max").tooltip("768 px").selected(detail == FaceDetail::Max))
                                    .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                                        this.edits += 1;
                                        this.face_detail = match selected.first() {
                                            Some(0) => FaceDetail::Standard,
                                            Some(2) => FaceDetail::Max,
                                            _ => FaceDetail::High,
                                        };
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        v_flex()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Strength"))
                            .child(self.face_strength.clone()),
                    )
                    .child(
                        v_flex()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("Detector"))
                            .child(
                                ButtonGroup::new("face-detector")
                                    .outline()
                                    .small()
                                    .child(Button::new("accurate").label("Accurate").selected(detector == FaceDetector::Accurate))
                                    .child(Button::new("fast").label("Fast").selected(detector == FaceDetector::Fast))
                                    .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                                        this.edits += 1;
                                        this.face_detector = if selected.first() == Some(&1) { FaceDetector::Fast } else { FaceDetector::Accurate };
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Switch::new("refine-eyes")
                                    .checked(self.refine_eyes)
                                    .on_change(cx.listener(|this, checked: &bool, _, cx| {
                                        this.edits += 1;
                                        this.refine_eyes = *checked;
                                        cx.notify();
                                    })),
                            )
                            .child(div().text_sm().child("Second pass on the eyes")),
                    )
                    .into_any_element()
            }
        }
    }

    fn render_left(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let zoom = ZoomScale::PANE.clamp(Preferences::get_member(cx, &FORM_ZOOM, "enhance"));
        let mode = self.mode;
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .p_3()
                    .gap_2()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Enhance"),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                ZoomControl::new("form-zoom", zoom, ZoomScale::PANE, "form")
                                    .on_change(|factor, _, cx| {
                                        Preferences::set_member(cx, &FORM_ZOOM, "enhance", factor)
                                    }),
                            )
                            .child(self.backend_status.clone()),
                    ),
            )
            .child(
                div().flex_1().min_h_0().child(pane_zoom(
                    zoom,
                    v_flex()
                        .id("enhance-form")
                        .size_full()
                        .overflow_y_scroll()
                        .child(
                            v_flex().p_4().gap_3().child(self.render_input(cx)).child(
                                ButtonGroup::new("enhance-mode")
                                    .outline()
                                    .small()
                                    .children(EnhanceMode::ALL.iter().map(|candidate| {
                                        Button::new(candidate.label())
                                            .label(candidate.label())
                                            .selected(*candidate == mode)
                                    }))
                                    .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                                        if let Some(mode) = selected
                                            .first()
                                            .and_then(|ix| EnhanceMode::ALL.get(*ix))
                                        {
                                            this.edits += 1;
                                            this.mode = *mode;
                                            cx.notify();
                                        }
                                    })),
                            ),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_h_0()
                                .child(self.render_mode_controls(cx)),
                        ),
                )),
            )
            .child(
                div()
                    .p_4()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(
                        Button::new("run-enhancement")
                            .primary()
                            .large()
                            .w_full()
                            .icon(IconName::Zap)
                            .label(if self.sending.is_some() {
                                "Sending..."
                            } else {
                                "Enhance"
                            })
                            .loading(self.sending.is_some())
                            .disabled(self.sending.is_some())
                            .tooltip_with_action("Enhance", &RunEnhancement, Some(CONTEXT))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run(&RunEnhancement, window, cx)
                            })),
                    ),
            )
    }

    fn render_results(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows();
        let running = self.running;
        let header = h_flex()
            .p_3()
            .gap_2()
            .justify_between()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Results"),
            )
            .when(running > 0, |this| {
                this.child(
                    h_flex().gap_2().child(Spinner::new().xsmall()).child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!("{running} enhancing...")),
                    ),
                )
            });

        let body: AnyElement = if rows.is_empty() && running == 0 {
            v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .gap_1()
                .text_color(cx.theme().muted_foreground)
                .child("No results yet")
                .child("Enhanced images will appear here")
                .into_any_element()
        } else {
            // Runs in flight first, as square placeholders (the web's 280 px
            // cards); then results, shaped like their thumbnails once decoded.
            let urls = Media::urls(cx).clone();
            let keys = (0..running)
                .map(|ix| SharedString::from(format!("running-{ix}")))
                .chain(rows.iter().map(|row| SharedString::from(row.id.clone())))
                .collect();
            let aspects = std::iter::repeat_n(1.0, running)
                .chain(rows.iter().map(|row| {
                    artsnack_media::MediaImages::aspect(cx, &urls.thumb(&row.result_b2_key))
                        .unwrap_or(1.0)
                }))
                .collect();
            self.grid.sync(keys, aspects, 1.0, window);
            let view = cx.entity();
            let hearts = self.hearts.clone();
            div()
                .flex_1()
                .min_h_0()
                .p_3()
                .child(self.grid.render(view.entity_id(), move |ix, size, _, cx| {
                    if ix < running {
                        return running_tile(size, cx);
                    }
                    let Some(row) = rows.get(ix - running).cloned() else {
                        return div().into_any_element();
                    };
                    let actions = view.update(cx, |this, cx| this.actions_for(&row, cx));
                    let click_view = view.downgrade();
                    let key: SharedString = row.id.clone().into();
                    let mut tile = MediaTile::new(
                        key.clone(),
                        ImageRequest::new(urls.thumb(&row.result_b2_key)).max_dimension(768),
                        size,
                    )
                    .original(
                        ImageRequest::new(urls.original(&row.result_b2_key)).max_dimension(2048),
                    )
                    .badge(
                        EnhanceMode::parse(&row.mode)
                            .map(|mode| mode.label())
                            .unwrap_or("Enhanced"),
                    )
                    .on_click(move |_: &ClickEvent, window, cx| {
                        let key = key.clone();
                        let _ =
                            click_view.update(cx, |this, cx| this.open_lightbox(key, window, cx));
                    });
                    // The heart once favourites are known: the server toggles.
                    if let Some(favorited) = hearts.read(cx).favorited(&row.result_b2_key) {
                        let hearts = hearts.clone();
                        let args = Self::toggle_args(&row);
                        tile = tile.favorite(favorited, move |window, cx| {
                            hearts.update(cx, |hearts, cx| hearts.toggle(args.clone(), window, cx));
                        });
                    }
                    for action in actions {
                        tile = tile.action(action);
                    }
                    tile.into_any_element()
                }))
                .into_any_element()
        };
        v_flex().size_full().child(header).child(body)
    }
}

/// An enhancement still running: there is nothing to show of it yet.
fn running_tile(size: gpui_kit::Size<gpui_kit::Pixels>, cx: &App) -> AnyElement {
    div()
        .relative()
        .w(size.width)
        .h(size.height)
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
        .overflow_hidden()
        .child(Skeleton::new().absolute().size_full())
        .child(
            v_flex()
                .relative()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .child(Spinner::new().large().color(cx.theme().primary))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("Enhancing…"),
                ),
        )
        .into_any_element()
}

fn lightbox_item(row: &Enhancement, urls: &artsnack_media::MediaUrls) -> LightboxItem {
    LightboxItem {
        key: row.id.clone().into(),
        preview: ImageRequest::new(urls.thumb(&row.result_b2_key)).max_dimension(768),
        original: ImageRequest::new(urls.original(&row.result_b2_key)).max_dimension(4096),
        media: TileMedia::Image,
        video_url: None,
    }
}

impl Focusable for EnhanceView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for EnhanceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ratio = Preferences::get_member(cx, &SPLIT, "enhance");
        let results = self.render_results(window, cx).into_any_element();
        let lightbox = self.lightbox.as_ref().map(|(lightbox, _)| lightbox.clone());
        div()
            .id("enhance")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::run))
            .relative()
            .size_full()
            .child(
                SplitPane::new("enhance-split", ratio, self.render_left(cx), results).on_resize(
                    |ratio, _, cx| Preferences::set_member(cx, &SPLIT, "enhance", ratio),
                ),
            )
            .children(lightbox)
    }
}
