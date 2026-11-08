//! Image → Prompt: drop pictures, get prompts that would draw them (the web's
//! `ImageToPromptPanel`).
//!
//! Results live in this panel and nowhere else — a description is worth
//! keeping only once someone decides it is, and that is what Save (into the
//! ordinary prompt library) is for. The API tab keeps the panel alive while
//! another provider shows, so switching away and back loses nothing; quitting
//! does.
//!
//! - Each picture is prepared off the main thread to the `describe` reference
//!   profile and sent inline as a JPEG data URL: it is needed for exactly one
//!   request, so a storage upload would only add a round trip.
//! - Pictures stay on the left once added; every Describe is a new run of
//!   them on the right, one card per picture per run with the settings it ran
//!   on, so one picture can be tried on several models at once and a run in
//!   progress never holds up the next. Describe sends only the pictures not
//!   yet described with the current settings, or all of them again.
//! - Two requests per model run at a time (xAI rate-limits each model at two a
//!   second), six in all.
//! - The formats, the instruction limit and the image limits come from
//!   `packages/shared` (`image-to-prompt.ts`, `reference-profile.ts`) through
//!   the rules bridge, so the panel asks for exactly what the server accepts.
//! - The model is the user's pick from the live list `imageToPrompt.models`
//!   reads from xAI and Atlas, read once when the panel opens (see `model`).

mod item;
mod model;
mod prepare;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    rc::Rc,
    time::{Duration, Instant},
};

use anyhow::Context as _;
use artsnack_backend::{
    Backend, CallError, NoArgs,
    api::{
        image_to_prompt::{
            self, DescribeArgs, DescribeModelCatalog, DescribeModelOption, Described,
        },
        saved_prompts::{self, SaveArgs},
    },
};
use artsnack_library::open_reference_picker;
use artsnack_media::{Media, upload::ProfileLimits};
use artsnack_rules::Rules;
use artsnack_settings::{Preference, PreferenceFamily, Preferences};
use artsnack_ui::{DEFAULT_SPLIT_RATIO, SplitPane, ZoomScale, pane_zoom};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClipboardItem, Context, Entity, ExternalPaths, FocusHandle,
    Focusable, FontWeight, InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _,
    PathPromptOptions, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariants as _},
        h_flex,
        input::{InputEvent, Textarea, TextareaState},
        notification::Notification,
        scroll::ScrollableElement as _,
        searchable_list::{SearchableGroup, SearchableVec},
        select::{Select, SelectEvent, SelectState},
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};
use serde::{Deserialize, Serialize};

use item::{DescribeItem, InputImage, ItemStatus, describe_meta};
use model::{
    ModelChoice, ModelSelect, ModelView, catalog_notice, resolve_model, show_models,
    with_previous_models,
};
use prepare::NewImage;

actions!(image_to_prompt, [DescribeImages]);

const CONTEXT: &str = "ImageToPrompt";

pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-enter", DescribeImages, Some(CONTEXT)),
        KeyBinding::new(
            "cmd-enter",
            DescribeImages,
            Some(&artsnack_ui::field_in(CONTEXT)),
        ),
    ]);
}

/// Two in flight per model — xAI rate-limits each model at two requests a
/// second — and six in all. Different models run side by side.
const PER_MODEL_IN_FLIGHT: usize = 2;
const MAX_IN_FLIGHT: usize = 6;
/// Pictures waiting on the left. Past this it is a mistake more often than a
/// plan.
const MAX_INPUTS: usize = 24;
/// A second Describe this soon after the first is a double press, not a
/// second run.
const DOUBLE_PRESS: Duration = Duration::from_millis(600);

/// The settings | results split, as the web's `generate-split-describe`.
const SPLIT: PreferenceFamily<f32> =
    PreferenceFamily::new("generate.split", || DEFAULT_SPLIT_RATIO);
const SPLIT_MEMBER: &str = "describe";
/// The API tab's form zoom (the Generate screen's `generate.formZoom.api`):
/// Image → Prompt stands in for that form, so it zooms with it.
const FORM_ZOOM: PreferenceFamily<f32> = PreferenceFamily::new("generate.formZoom", || 1.0);
const FORM_ZOOM_MEMBER: &str = "api";

/// The format, the model and the extra instructions (the web's
/// `artsnack_describe_settings`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct DescribeSettings {
    /// A `DescribePresetId`; empty or unknown means the shared default.
    preset: String,
    instructions: String,
    /// A `DescribeModel` id; empty or malformed means the shared default
    /// (subscription Grok 4.6).
    model_id: String,
}

const SETTINGS: Preference<DescribeSettings> =
    Preference::new("describe.settings", DescribeSettings::default);

/// One prompt format (`DescribePreset`, without the instructions it sends).
#[derive(Clone, Debug, Deserialize)]
struct DescribePreset {
    id: String,
    label: String,
    /// One line under the picker saying which models the result suits.
    hint: String,
}

/// What the shared code decides for the panel, read once.
struct DescribeRules {
    presets: Vec<DescribePreset>,
    default_preset: String,
    max_instructions: usize,
    /// The built-in Grok models, shown until the live list arrives.
    fallback_catalog: DescribeModelCatalog,
    limits: ProfileLimits,
}

impl DescribeRules {
    fn load(cx: &App) -> anyhow::Result<Self> {
        let rules = Rules::global(cx).context("the shared rules did not load")?;
        Ok(Self {
            presets: rules.get("imageToPrompt.DESCRIBE_PRESETS")?,
            default_preset: rules.get("imageToPrompt.DEFAULT_DESCRIBE_PRESET")?,
            max_instructions: rules.get("imageToPrompt.MAX_DESCRIBE_INSTRUCTIONS")?,
            fallback_catalog: rules.get("imageToPrompt.FALLBACK_DESCRIBE_CATALOG")?,
            limits: rules.get("referenceProfile.REFERENCE_PROFILES.describe")?,
        })
    }

    /// The preset `id` names, else the default (`getDescribePreset`).
    fn preset(&self, id: &str) -> Option<&DescribePreset> {
        self.presets
            .iter()
            .find(|preset| preset.id == id)
            .or_else(|| {
                self.presets
                    .iter()
                    .find(|preset| preset.id == self.default_preset)
            })
    }
}

/// How the server counts the instructions: trimmed, in UTF-16 code units.
fn instructions_length(text: &str) -> usize {
    text.trim().encode_utf16().count()
}

/// What a run is sent with: the settings as they were when it started.
#[derive(Clone)]
pub(super) struct BatchSettings {
    preset: String,
    instructions: Option<String>,
    model_id: String,
}

impl BatchSettings {
    /// What makes two runs of one picture the same request.
    fn key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            self.preset,
            self.model_id,
            self.instructions.as_deref().unwrap_or_default()
        )
    }
}

/// Builds the API tab's switcher row (backend tabs, media toggle, providers)
/// that the panel shows at the top of its settings column, so the user can
/// switch back to a provider.
pub type HeaderBuilder = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// Owns its own settings | results split, which replaces the API tab's
/// composer and results while Image → Prompt is selected.
pub struct DescribePanel {
    header: HeaderBuilder,
    focus_handle: FocusHandle,
    rules: Result<Rc<DescribeRules>, SharedString>,
    settings: DescribeSettings,
    instructions: Entity<TextareaState>,
    /// The live model list, or the built-in one until it arrives.
    catalog: DescribeModelCatalog,
    /// The models of the last answer both vendors gave in full, which fill
    /// in a list that fails on a later read.
    last_full_models: Vec<DescribeModelOption>,
    /// Why the last read of the list failed outright.
    catalog_error: Option<SharedString>,
    /// What went wrong reading the lists, under the picker.
    catalog_notice: Option<SharedString>,
    catalog_loading: bool,
    _catalog_task: Option<Task<()>>,
    model_select: Entity<ModelSelect>,
    /// The picked model, resolved against `catalog`.
    model: Option<DescribeModelOption>,
    model_hint: SharedString,
    /// The pictures on the left, in the order added.
    inputs: Vec<InputImage>,
    /// The runs on the right, newest first.
    items: Vec<DescribeItem>,
    next_id: u64,
    /// Runs waiting for a free slot, oldest first.
    queue: VecDeque<u64>,
    /// Requests in flight, per model id.
    in_flight: HashMap<String, usize>,
    requests: Vec<Task<()>>,
    /// When Describe last queued anything.
    last_describe: Option<Instant>,
    /// A batch of pictures is being prepared; another one waits for it.
    adding: bool,
    _adding_task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl DescribePanel {
    pub fn new(header: HeaderBuilder, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let rules = DescribeRules::load(cx).map(Rc::new).map_err(|error| {
            tracing::error!(?error, "Image → Prompt could not read the shared rules");
            SharedString::from(
                "Image → Prompt could not load its formats. This is a build problem.",
            )
        });
        let mut settings = Preferences::get(cx, &SETTINGS);
        if let Ok(rules) = &rules
            && let Some(preset) = rules.preset(&settings.preset)
        {
            settings.preset = preset.id.clone();
        }
        // An empty or malformed id becomes the default, as on the web.
        if let Some(model) =
            Rules::global(cx).and_then(|bridge| resolve_model(bridge, &settings.model_id).ok())
        {
            settings.model_id = model.id;
        }
        let catalog = rules
            .as_ref()
            .map(|rules| rules.fallback_catalog.clone())
            .unwrap_or_default();
        let model_select = cx.new(|cx| {
            SelectState::new(
                SearchableVec::new(Vec::<SearchableGroup<ModelChoice>>::new()),
                None,
                window,
                cx,
            )
            .searchable(true)
        });

        let instructions = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(3, 10)
                .placeholder("e.g. Describe the pose and how she moves in detail; keep the dress colour exact; put her on a beach at sunset")
                .default_value(settings.instructions.clone())
        });
        let subscriptions = vec![
            cx.subscribe(&instructions, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.settings.instructions = state.read(cx).value().to_string();
                    Preferences::set(cx, &SETTINGS, this.settings.clone());
                    cx.notify();
                }
            }),
            cx.subscribe_in(
                &model_select,
                window,
                |this, _, event: &SelectEvent<_>, window, cx| {
                    let SelectEvent::Confirm(Some(id)) = event else {
                        return;
                    };
                    if this.settings.model_id != id.as_ref() {
                        this.settings.model_id = id.to_string();
                        Preferences::set(cx, &SETTINGS, this.settings.clone());
                        this.sync_models(window, cx);
                    }
                },
            ),
            // The split ratio and the form zoom live in preferences.
            Preferences::observe_member(cx, &FORM_ZOOM, FORM_ZOOM_MEMBER, |_, cx| cx.notify()),
            Preferences::observe_member(cx, &SPLIT, SPLIT_MEMBER, |_, cx| cx.notify()),
        ];

        let mut this = Self {
            header,
            focus_handle: cx.focus_handle(),
            rules,
            settings,
            instructions,
            catalog,
            last_full_models: Vec::new(),
            catalog_error: None,
            catalog_notice: None,
            catalog_loading: false,
            _catalog_task: None,
            model_select,
            model: None,
            model_hint: SharedString::default(),
            inputs: Vec::new(),
            items: Vec::new(),
            next_id: 0,
            queue: VecDeque::new(),
            in_flight: HashMap::new(),
            requests: Vec::new(),
            last_describe: None,
            adding: false,
            _adding_task: None,
            _subscriptions: subscriptions,
        };
        this.sync_models(window, cx);
        this.load_catalog(window, cx);
        this
    }

    // --- The model list ------------------------------------------------

    /// Reads the live list. Until it answers, and if it fails, the picker
    /// keeps what it has.
    fn load_catalog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.catalog_loading {
            return;
        }
        self.catalog_loading = true;
        cx.notify();
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(image_to_prompt::MODELS, &NoArgs {}, cx)
        });
        let window_handle = window.window_handle();
        self._catalog_task = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = window_handle.update(cx, |_, window, cx| {
                this.update(cx, |this, cx| {
                    this.catalog_loading = false;
                    match result {
                        Ok(catalog) => {
                            this.catalog_error = None;
                            if catalog.grok_error.is_none() && catalog.atlas_error.is_none() {
                                this.last_full_models = catalog.models.clone();
                                this.catalog = catalog;
                            } else {
                                this.catalog = match Rules::global(cx) {
                                    Some(bridge) => with_previous_models(
                                        bridge,
                                        catalog,
                                        &this.last_full_models,
                                    ),
                                    None => catalog,
                                };
                            }
                        }
                        Err(error) => {
                            tracing::warn!(?error, "Image → Prompt could not load its models");
                            this.catalog_error = Some(error.user_message());
                        }
                    }
                    this.sync_models(window, cx);
                })
            });
        }));
    }

    /// Lays the picker out for the list and the pick as they are now.
    fn sync_models(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bridge) = Rules::global(cx) else {
            return;
        };
        self.catalog_notice =
            match catalog_notice(bridge, &self.catalog, self.catalog_error.as_deref()) {
                Ok(notice) => notice.map(SharedString::from),
                Err(error) => {
                    tracing::error!(?error, "Image → Prompt could not word the list's notice");
                    None
                }
            };
        match ModelView::new(bridge, &self.catalog, &self.settings.model_id) {
            Ok(view) => {
                self.model = Some(view.model);
                self.model_hint = view.hint;
                show_models(
                    &self.model_select,
                    view.groups,
                    &self.settings.model_id,
                    window,
                    cx,
                );
            }
            Err(error) => {
                tracing::error!(?error, "Image → Prompt could not lay out its models");
            }
        }
        cx.notify();
    }

    /// Runs queued or in flight.
    fn active_count(&self) -> usize {
        self.items.iter().filter(|item| item.is_active()).count()
    }

    fn is_instructions_too_long(&self) -> bool {
        self.rules.as_ref().is_ok_and(|rules| {
            instructions_length(&self.settings.instructions) > rules.max_instructions
        })
    }

    // --- Adding pictures -------------------------------------------------

    fn choose_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Choose".into()),
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                let _ = window_handle.update(cx, |_, window, cx| {
                    let _ = this.update(cx, |this, cx| this.add_paths(&paths, window, cx));
                });
            }
        })
        .detach();
    }

    fn add_paths(
        &mut self,
        paths: &[std::path::PathBuf],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let images: Vec<NewImage> = paths
            .iter()
            .filter_map(|path| NewImage::file(path))
            .collect();
        let skipped = paths.len() - images.len();
        if images.is_empty() {
            window.push_notification(
                Notification::error("Choose PNG, JPG, WEBP or GIF images"),
                cx,
            );
            return;
        }
        if skipped > 0 {
            window.push_notification(
                Notification::info(format!(
                    "Skipped {skipped} that {} not PNG, JPG, WEBP or GIF",
                    if skipped == 1 { "is" } else { "are" }
                )),
                cx,
            );
        }
        self.add(images, window, cx);
    }

    fn choose_from_gallery(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        open_reference_picker(window, cx, move |picked, window, cx| {
            let image = NewImage::remote(picked.url, &picked.b2_key);
            let _ = view.update(cx, |this, cx| this.add(vec![image], window, cx));
        });
    }

    /// Prepares `images` one at a time and adds each to the left as it is
    /// ready, in the order given.
    fn add(&mut self, images: Vec<NewImage>, window: &mut Window, cx: &mut Context<Self>) {
        // The room below is counted from the list as it is now; a second drop
        // while the first is still being prepared would count against a stale
        // length.
        if self.adding {
            window.push_notification(
                Notification::info("Still preparing the last images — add these again in a moment"),
                cx,
            );
            return;
        }
        let limits = match &self.rules {
            Ok(rules) => rules.limits.clone(),
            Err(message) => {
                window.push_notification(Notification::error(message.clone()), cx);
                return;
            }
        };
        let room = MAX_INPUTS.saturating_sub(self.inputs.len());
        if room == 0 {
            window.push_notification(
                Notification::error(format!(
                    "Up to {MAX_INPUTS} images at a time — remove some first"
                )),
                cx,
            );
            return;
        }
        if images.len() > room {
            window.push_notification(
                Notification::info(format!(
                    "Only the first {room} added — {MAX_INPUTS} at most"
                )),
                cx,
            );
        }

        self.adding = true;
        cx.notify();
        let fetcher = Media::fetcher(cx);
        let window_handle = window.window_handle();
        let images: Vec<NewImage> = images.into_iter().take(room).collect();
        self._adding_task = Some(cx.spawn(async move |this, cx| {
            // One at a time, as on the web: several full-size decodes at once
            // would hold hundreds of megabytes of pixels.
            for image in images {
                let result =
                    prepare::prepare(image.origin, limits.clone(), fetcher.clone(), cx).await;
                let shown = window_handle.update(cx, |_, window, cx| {
                    this.update(cx, |this, cx| match result {
                        Ok(prepared) => this.insert_input(image.name, prepared, cx),
                        Err(message) => window.push_notification(
                            Notification::error(format!("{}: {message}", image.name)),
                            cx,
                        ),
                    })
                });
                if !matches!(shown, Ok(Ok(()))) {
                    return;
                }
            }
            let _ = this.update(cx, |this, cx| {
                this.adding = false;
                cx.notify();
            });
        }));
    }

    fn insert_input(
        &mut self,
        name: SharedString,
        prepared: prepare::Prepared,
        cx: &mut Context<Self>,
    ) {
        self.inputs.push(InputImage {
            id: self.next_id,
            name,
            preview: prepared.preview,
            data_url: prepared.data_url,
        });
        self.next_id += 1;
        cx.notify();
    }

    /// Takes a picture off the left; its runs keep their own copy.
    fn remove_input(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.inputs.iter().position(|input| input.id == id) else {
            return;
        };
        let input = self.inputs.remove(ix);
        drop_preview(input.preview, window, cx);
        cx.notify();
    }

    fn clear_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for input in std::mem::take(&mut self.inputs) {
            drop_preview(input.preview, window, cx);
        }
        cx.notify();
    }

    fn drop_files(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        self.add_paths(paths.paths(), window, cx);
    }

    // --- Describing ----------------------------------------------------

    fn run(&mut self, _: &DescribeImages, window: &mut Window, cx: &mut Context<Self>) {
        // The instructions as they stand in the field, not as last committed:
        // Cmd-Enter typed in the field is the run's, never the field's own
        // Enter, so nothing else may have read the latest keystroke.
        let instructions = self.instructions.read(cx).value().to_string();
        if instructions != self.settings.instructions {
            self.settings.instructions = instructions;
            Preferences::set(cx, &SETTINGS, self.settings.clone());
        }
        if self.adding {
            return;
        }
        // A double press would send every picture twice.
        let now = Instant::now();
        if self
            .last_describe
            .is_some_and(|last| now.duration_since(last) < DOUBLE_PRESS)
        {
            return;
        }
        let Some(batch) = self.current_batch() else {
            return;
        };
        let described = self.described_inputs(&batch.key());
        let fresh: Vec<usize> = (0..self.inputs.len())
            .filter(|ix| !described.contains(&self.inputs[*ix].id))
            .collect();
        let targets: Vec<usize> = if fresh.is_empty() {
            (0..self.inputs.len()).collect()
        } else {
            fresh
        };
        if targets.is_empty() {
            return;
        }
        self.last_describe = Some(now);
        let mut created = Vec::with_capacity(targets.len());
        for ix in targets {
            let input = &self.inputs[ix];
            let (input_id, name, preview, data_url) = (
                input.id,
                input.name.clone(),
                input.preview.clone(),
                input.data_url.clone(),
            );
            created.push(self.new_item(
                input_id,
                name,
                preview,
                data_url,
                batch.clone(),
                window,
                cx,
            ));
        }
        // Sent in the order the pictures were added; shown newest first, the
        // batch in that same order.
        self.queue.extend(created.iter().map(|item| item.id));
        for item in created.into_iter().rev() {
            self.items.insert(0, item);
        }
        self.pump(window, cx);
        cx.notify();
    }

    /// The pictures counted as described with `key`: those with a card on
    /// screen that ran (or is running) with it and has not failed. Removing
    /// or clearing a card, or a run that never got an answer, makes a picture
    /// new again, and Again and Retry count like Describe.
    fn described_inputs(&self, key: &str) -> HashSet<u64> {
        self.items
            .iter()
            .filter(|item| item.status != ItemStatus::Error && item.batch.key() == key)
            .map(|item| item.input_id)
            .collect()
    }

    /// The settings as they are now, or `None` when they cannot be sent:
    /// instructions over the limit (the form says so already), or no rules.
    fn current_batch(&self) -> Option<BatchSettings> {
        if self.is_instructions_too_long() {
            return None;
        }
        let rules = self.rules.as_ref().ok()?;
        let preset = rules.preset(&self.settings.preset)?;
        let instructions = self.settings.instructions.trim();
        Some(BatchSettings {
            preset: preset.id.clone(),
            instructions: (!instructions.is_empty()).then(|| instructions.to_string()),
            model_id: self.settings.model_id.clone(),
        })
    }

    /// "Kimi K3.1 Pro · Natural description": what a run is on.
    fn batch_label(&self, batch: &BatchSettings) -> SharedString {
        let model = self
            .catalog
            .models
            .iter()
            .find(|model| model.id == batch.model_id)
            .map(|model| model.label.clone())
            .or_else(|| {
                self.model
                    .as_ref()
                    .filter(|model| model.id == batch.model_id)
                    .map(|model| model.label.clone())
            })
            .unwrap_or_else(|| batch.model_id.clone());
        let preset = self
            .rules
            .as_ref()
            .ok()
            .and_then(|rules| rules.preset(&batch.preset))
            .map_or_else(|| batch.preset.clone(), |preset| preset.label.clone());
        format!("{model} · {preset}").into()
    }

    /// A waiting run of a picture with `batch`; the caller queues it.
    #[allow(clippy::too_many_arguments)]
    fn new_item(
        &mut self,
        input_id: u64,
        name: SharedString,
        preview: std::sync::Arc<gpui_kit::RenderImage>,
        data_url: std::sync::Arc<str>,
        batch: BatchSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> DescribeItem {
        let text = cx.new(|cx| TextareaState::new(window, cx).auto_grow(4, 16));
        // Save compares the text with what was saved; an edit re-enables it.
        let text_changed = cx.subscribe(&text, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        let item = DescribeItem {
            id: self.next_id,
            input_id,
            name,
            preview,
            data_url,
            label: self.batch_label(&batch),
            batch,
            status: ItemStatus::Waiting,
            attempt: 0,
            text,
            error: None,
            meta: None,
            fallback_reason: None,
            saved_text: None,
            saving: false,
            _text_changed: text_changed,
        };
        self.next_id += 1;
        item
    }

    /// A new card for the same picture with the current settings; the old
    /// one stays.
    fn run_again(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(batch) = self.current_batch() else {
            return;
        };
        let Some(source) = self.items.iter().find(|item| item.id == id) else {
            return;
        };
        let (input_id, name, preview, data_url) = (
            source.input_id,
            source.name.clone(),
            source.preview.clone(),
            source.data_url.clone(),
        );
        let item = self.new_item(input_id, name, preview, data_url, batch, window, cx);
        self.queue.push_back(item.id);
        self.items.insert(0, item);
        self.pump(window, cx);
        cx.notify();
    }

    /// A failed card tries again in place, with the current settings.
    fn retry(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(batch) = self.current_batch() else {
            return;
        };
        let label = self.batch_label(&batch);
        let Some(item) = self
            .items
            .iter_mut()
            .find(|item| item.id == id && item.status == ItemStatus::Error)
        else {
            return;
        };
        item.batch = batch;
        item.label = label;
        item.status = ItemStatus::Waiting;
        item.error = None;
        self.queue.push_back(id);
        self.pump(window, cx);
        cx.notify();
    }

    /// Starts waiting runs, oldest first, while their model and the total
    /// have room.
    fn pump(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.requests.retain(|task| !task.is_ready());
        let mut total: usize = self.in_flight.values().sum();
        let mut ix = 0;
        while ix < self.queue.len() && total < MAX_IN_FLIGHT {
            let id = self.queue[ix];
            // Removed while it waited: never sent.
            let Some(item) = self
                .items
                .iter_mut()
                .find(|item| item.id == id && item.status == ItemStatus::Waiting)
            else {
                self.queue.remove(ix);
                continue;
            };
            let running = self
                .in_flight
                .get(&item.batch.model_id)
                .copied()
                .unwrap_or(0);
            if running >= PER_MODEL_IN_FLIGHT {
                ix += 1;
                continue;
            }
            self.queue.remove(ix);
            item.status = ItemStatus::Running;
            item.attempt += 1;
            let attempt = item.attempt;
            let model_id = item.batch.model_id.clone();
            let preset = item.batch.preset.clone();
            let args = DescribeArgs {
                image: item.data_url.to_string(),
                preset: item.batch.preset.clone(),
                instructions: item.batch.instructions.clone(),
                model_id: (!model_id.is_empty()).then(|| model_id.clone()),
            };
            self.in_flight.insert(model_id.clone(), running + 1);
            total += 1;

            let request = Backend::global(cx).update(cx, |backend, cx| {
                backend.act(image_to_prompt::DESCRIBE, &args, cx)
            });
            let window_handle = window.window_handle();
            self.requests.push(cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = window_handle.update(cx, |_, window, cx| {
                    this.update(cx, |this, cx| {
                        this.finish(id, attempt, &model_id, &preset, result, window, cx)
                    })
                });
            }));
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        &mut self,
        id: u64,
        attempt: u32,
        model_id: &str,
        preset: &str,
        result: Result<Described, CallError>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(count) = self.in_flight.get_mut(model_id) {
            *count = count.saturating_sub(1);
        }
        let preset_label = self
            .rules
            .as_ref()
            .ok()
            .and_then(|rules| rules.preset(preset))
            .map(|preset| preset.label.clone())
            .unwrap_or_else(|| preset.to_string());
        if let Some(item) = self
            .items
            .iter_mut()
            .find(|item| item.id == id && item.attempt == attempt)
        {
            match result {
                Ok(described) => {
                    // The list's name where it has one: the server names a
                    // model it has never seen listed by its slug.
                    let model_label = self
                        .catalog
                        .models
                        .iter()
                        .find(|model| model.id == described.model.id)
                        .map(|model| model.label.clone())
                        .unwrap_or_else(|| described.model.label.clone());
                    item.status = ItemStatus::Done;
                    item.meta = Some(describe_meta(&preset_label, &model_label, &described).into());
                    item.fallback_reason = described
                        .fell_back
                        .then(|| described.reason.clone().map(SharedString::from))
                        .flatten();
                    item.saved_text = None;
                    item.text
                        .update(cx, |text, cx| text.set_value(described.text, window, cx));
                }
                Err(error) => {
                    item.status = ItemStatus::Error;
                    item.error = Some(error.user_message());
                }
            }
        }
        self.pump(window, cx);
        cx.notify();
    }

    // --- Card commands ------------------------------------------------

    fn save(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.items.iter_mut().find(|item| item.id == id) else {
            return;
        };
        let text = item.text.read(cx).value().trim().to_string();
        if text.is_empty() || item.saving {
            return;
        }
        item.saving = true;
        cx.notify();
        let args = SaveArgs {
            text: text.clone(),
            ..SaveArgs::default()
        };
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(saved_prompts::SAVE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = window_handle.update(cx, |_, window, cx| {
                let saved = result.is_ok();
                let _ = this.update(cx, |this, cx| {
                    if let Some(item) = this.items.iter_mut().find(|item| item.id == id) {
                        item.saving = false;
                        if saved {
                            item.saved_text = Some(text);
                        }
                    }
                    cx.notify();
                });
                let notification = match result {
                    Ok(saved) if saved.duplicate => Notification::success("Already saved"),
                    Ok(_) => Notification::success("Prompt saved"),
                    Err(error) => Notification::error(error.user_message()),
                };
                window.push_notification(notification, cx);
            });
        })
        .detach();
    }

    fn copy(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.items.iter().find(|item| item.id == id) else {
            return;
        };
        let text = item.text.read(cx).value().trim().to_string();
        if text.is_empty() {
            return;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        window.push_notification(Notification::success("Prompt copied"), cx);
    }

    /// Takes a card away. A waiting run is never sent; a running one
    /// finishes (and is billed) unseen.
    fn remove(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.items.iter().position(|item| item.id == id) else {
            return;
        };
        let item = self.items.remove(ix);
        drop_preview(item.preview, window, cx);
        self.queue.retain(|queued| *queued != id);
        cx.notify();
    }

    /// Removes every card but those whose request is in flight — those are
    /// answered (and billed) anyway — and cancels everything unsent.
    fn clear_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (kept, removed): (Vec<_>, Vec<_>) = self
            .items
            .drain(..)
            .partition(|item| item.status == ItemStatus::Running);
        self.items = kept;
        for item in removed {
            drop_preview(item.preview, window, cx);
        }
        self.queue.clear();
        cx.notify();
    }

    // --- Rendering ------------------------------------------------------

    /// The pictures added so far, which stay for the next Describe.
    fn render_inputs(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let count = self.inputs.len();
        let described = self
            .current_batch()
            .map(|batch| self.described_inputs(&batch.key()))
            .unwrap_or_default();
        let thumbs: Vec<AnyElement> = self
            .inputs
            .iter()
            .map(|input| {
                self.render_input(input, described.contains(&input.id), cx)
                    .into_any_element()
            })
            .collect();
        v_flex()
            .gap_2()
            .p_3()
            .border_b_1()
            .border_dashed()
            .border_color(border)
            .child(
                h_flex()
                    .justify_between()
                    .gap_2()
                    .text_xs()
                    .text_color(muted)
                    .child(format!(
                        "{count} image{} — they stay here; each Describe is a new run",
                        if count == 1 { "" } else { "s" }
                    ))
                    .child(
                        Button::new("clear-inputs")
                            .ghost()
                            .xsmall()
                            .label("Clear")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.clear_inputs(window, cx)),
                            ),
                    ),
            )
            // Room above and to the right for each thumbnail's remove button.
            .child(h_flex().flex_wrap().gap_3().pt_1().children(thumbs))
            .into_any_element()
    }

    fn render_drop_zone(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let has_inputs = !self.inputs.is_empty();
        let inputs = has_inputs.then(|| self.render_inputs(cx));
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        v_flex()
            .id("describe-drop")
            .rounded(theme.radius_lg)
            .border_1()
            .border_dashed()
            .border_color(theme.border)
            .drag_over::<ExternalPaths>(|style, _, _, cx| {
                style
                    .border_color(cx.theme().drag_border)
                    .bg(cx.theme().drop_target)
            })
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.drop_files(paths, window, cx)
            }))
            .children(inputs)
            .child(
                v_flex()
                    .id("describe-drop-area")
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .px_4()
                    .when(has_inputs, |this| this.py_3())
                    .when(!has_inputs, |this| this.py_6())
                    .text_color(muted)
                    .hover(|style| style.text_color(cx.theme().foreground))
                    .on_click(cx.listener(|this, _, window, cx| this.choose_files(window, cx)))
                    .child(if self.adding {
                        Spinner::new().into_any_element()
                    } else {
                        Icon::new(IconName::Upload).into_any_element()
                    })
                    .child(div().text_sm().child(if self.adding {
                        "Preparing images…"
                    } else if has_inputs {
                        "Drop or click to add more"
                    } else {
                        "Drop images here or click to choose"
                    }))
                    .when(!has_inputs, |this| {
                        this.child(
                            div()
                                .text_xs()
                                .child("Several at once — each gets its own prompt"),
                        )
                    }),
            )
            .child(
                h_flex()
                    .justify_center()
                    .gap_1()
                    .py_1()
                    .border_t_1()
                    .border_dashed()
                    .border_color(theme.border)
                    .child(
                        Button::new("choose-files")
                            .ghost()
                            .small()
                            .icon(IconName::Upload)
                            .label("Choose files…")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.choose_files(window, cx)),
                            ),
                    )
                    .child(
                        Button::new("from-gallery")
                            .ghost()
                            .small()
                            .icon(IconName::ImagePlus)
                            .label("From gallery…")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.choose_from_gallery(window, cx)
                            })),
                    ),
            )
    }

    fn render_format(&self, rules: &DescribeRules, cx: &mut Context<Self>) -> impl IntoElement {
        let current = rules.preset(&self.settings.preset);
        let current_id = current.map(|preset| preset.id.clone()).unwrap_or_default();
        let presets = rules.presets.clone();
        v_flex()
            .gap_1p5()
            .child(section_label("Prompt format"))
            .child(
                ButtonGroup::new("describe-format")
                    .small()
                    .outline()
                    .w_full()
                    .children(rules.presets.iter().map(|preset| {
                        Button::new(SharedString::from(preset.id.clone()))
                            .flex_1()
                            .label(preset.label.clone())
                            .selected(preset.id == current_id)
                    }))
                    .on_click(cx.listener(move |this, selected: &Vec<usize>, _, cx| {
                        if let Some(preset) = selected.first().and_then(|ix| presets.get(*ix)) {
                            this.settings.preset = preset.id.clone();
                            Preferences::set(cx, &SETTINGS, this.settings.clone());
                            cx.notify();
                        }
                    })),
            )
            .when_some(current, |this, preset| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(preset.hint.clone()),
                )
            })
    }

    fn render_instructions(
        &self,
        rules: &DescribeRules,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let length = instructions_length(&self.settings.instructions);
        let too_long = length > rules.max_instructions;
        v_flex()
            .gap_1p5()
            .child(
                h_flex()
                    .justify_between()
                    .child(
                        h_flex()
                            .gap_1()
                            .child(section_label("Extra instructions"))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("(optional)"),
                            ),
                    )
                    .when(length > 0, |this| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(if too_long {
                                    theme.danger
                                } else {
                                    theme.muted_foreground
                                })
                                .child(format!("{length}/{}", rules.max_instructions)),
                        )
                    }),
            )
            .child(Textarea::new(&self.instructions).aria_label("Extra instructions"))
            .when(too_long, |this| {
                this.child(div().text_xs().text_color(theme.danger).child(format!(
                    "Shorten the instructions to {} characters to describe.",
                    rules.max_instructions
                )))
            })
    }

    fn render_model(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let notice = self.catalog_notice.clone();
        v_flex()
            .gap_1p5()
            .child(
                h_flex()
                    .justify_between()
                    .child(section_label("Model"))
                    .when(notice.is_some() || self.catalog_loading, |this| {
                        this.child(
                            Button::new("reload-models")
                                .ghost()
                                .xsmall()
                                .label(if self.catalog_loading {
                                    "Loading models…"
                                } else {
                                    "Reload list"
                                })
                                .loading(self.catalog_loading)
                                .disabled(self.catalog_loading)
                                .on_click(
                                    cx.listener(|this, _, window, cx| {
                                        this.load_catalog(window, cx)
                                    }),
                                ),
                        )
                    }),
            )
            .child(
                Select::new(&self.model_select)
                    .placeholder("Choose a model…")
                    .search_placeholder("Search models…")
                    .accessibility_label("Model")
                    .menu_max_h(gpui_kit::rems(24.)),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child(self.model_hint.clone()),
            )
            .when_some(notice, |this, notice| {
                this.child(div().text_xs().text_color(muted).child(notice))
            })
    }

    fn render_settings(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let header = self.header.clone();
        let zoom = ZoomScale::PANE.clamp(Preferences::get_member(cx, &FORM_ZOOM, FORM_ZOOM_MEMBER));
        let described = self
            .current_batch()
            .map(|batch| self.described_inputs(&batch.key()))
            .unwrap_or_default();
        let fresh = self
            .inputs
            .iter()
            .filter(|input| !described.contains(&input.id))
            .count();
        let total = self.inputs.len();

        let form: AnyElement = match &self.rules {
            Ok(rules) => {
                let rules = rules.clone();
                v_flex()
                    .p_4()
                    .gap_4()
                    .child(self.render_drop_zone(cx))
                    .child(self.render_format(&rules, cx))
                    .child(self.render_model(cx))
                    .child(self.render_instructions(&rules, cx))
                    .into_any_element()
            }
            Err(message) => div()
                .p_4()
                .text_sm()
                .text_color(cx.theme().danger)
                .child(message.clone())
                .into_any_element(),
        };

        // Never held by a run in progress: each press is a new run.
        let label: SharedString = if total == 0 {
            "Add images to describe".into()
        } else if fresh > 0 {
            format!(
                "Describe {fresh} image{}",
                if fresh == 1 { "" } else { "s" }
            )
            .into()
        } else if total == 1 {
            "Describe it again".into()
        } else {
            format!("Describe all {total} again").into()
        };
        let disabled =
            total == 0 || self.adding || self.is_instructions_too_long() || self.rules.is_err();

        v_flex()
            .size_full()
            .child(header(window, cx))
            .child(
                div().flex_1().min_h_0().child(pane_zoom(
                    zoom,
                    v_flex()
                        .id("describe-form")
                        .size_full()
                        .overflow_y_scrollbar()
                        .child(form),
                )),
            )
            .child(
                div()
                    .p_4()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(
                        Button::new("describe-images")
                            .primary()
                            .large()
                            .w_full()
                            .icon(IconName::ScanText)
                            .label(label)
                            .disabled(disabled)
                            .tooltip_with_action("Describe", &DescribeImages, Some(CONTEXT))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.run(&DescribeImages, window, cx)
                            })),
                    ),
            )
            .into_any_element()
    }

    fn render_results(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        if self.items.is_empty() {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .px_4()
                .text_color(theme.muted_foreground)
                .child(Icon::new(IconName::ScanText).large())
                .child(
                    div()
                        .text_sm()
                        .child("Prompts for the images you add will appear here."),
                )
                .child(
                    div()
                        .text_xs()
                        .child("Run one picture on several models to compare them; edit, copy or save what you like."),
                )
                .into_any_element();
        }

        let count = self.items.len();
        let active = self.active_count();
        let all_running = self
            .items
            .iter()
            .all(|item| item.status == ItemStatus::Running);
        let cards: Vec<AnyElement> = self
            .items
            .iter()
            .map(|item| self.render_card(item, cx).into_any_element())
            .collect();

        v_flex()
            .size_full()
            .child(
                h_flex()
                    .px_4()
                    .py_2()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!(
                                "{count} result{}{}",
                                if count == 1 { "" } else { "s" },
                                if active > 0 {
                                    format!(" · {active} in progress")
                                } else {
                                    String::new()
                                }
                            )),
                    )
                    .child(
                        Button::new("clear-all")
                            .ghost()
                            .small()
                            .label("Clear all")
                            .disabled(all_running)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.clear_all(window, cx)),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .id("describe-results")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .child(v_flex().p_4().gap_3().children(cards)),
            )
            .into_any_element()
    }
}

/// Frees a thumbnail's GPU copy once nothing shows it: a picture and the
/// runs made from it share one decoded image.
fn drop_preview(preview: std::sync::Arc<gpui_kit::RenderImage>, window: &mut Window, cx: &mut App) {
    if std::sync::Arc::strong_count(&preview) == 1 {
        cx.drop_image(preview, Some(window));
    }
}

fn section_label(text: &'static str) -> impl IntoElement {
    div().text_sm().font_weight(FontWeight::MEDIUM).child(text)
}

impl Focusable for DescribePanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for DescribePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ratio = Preferences::get_member(cx, &SPLIT, SPLIT_MEMBER);
        let settings = self.render_settings(window, cx);
        let results = self.render_results(cx);
        div()
            .id("image-to-prompt")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::run))
            .size_full()
            .child(
                SplitPane::new("describe-split", ratio, settings, results).on_resize(
                    |ratio, _, cx| Preferences::set_member(cx, &SPLIT, SPLIT_MEMBER, ratio),
                ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_are_counted_as_the_server_counts_them() {
        assert_eq!(instructions_length("  abc \n"), 3);
        // An emoji is two UTF-16 code units, as `String.length` sees it.
        assert_eq!(instructions_length("😀"), 2);
    }

    #[test]
    fn settings_survive_a_missing_field() {
        let settings: DescribeSettings =
            serde_json::from_value(serde_json::json!({ "preset": "sd-tags" })).unwrap();
        assert_eq!(settings.preset, "sd-tags");
        assert_eq!(settings.instructions, "");
        assert_eq!(settings.model_id, "");
    }
}
