//! The tab's form (the composer column of the web's `VideoPanel`, and its
//! `LtxComposer`): the family switch, "Run on", each family's settings, the
//! input images, and Generate.
//!
//! - **Two forms, one tab.** MiniMax H3 and LTX 2.3 each keep their own form
//!   (persisted on every change); the input images, the pods, the queue and
//!   the results are shared. The prompt field shows the open family's prompt.
//! - **The model lists** come from `podCatalog.videoCatalog` — every ready pod
//!   merged, or the one picked in "Run on". They are re-read when the tab
//!   opens, when a "To pod" download lands, when the window shows again, and
//!   otherwise every 90 s, one read at a time and never while the window is
//!   hidden. A failed read — the pod answering that it cannot be reached
//!   included — keeps the last good lists: one failure in a row is ignored,
//!   from the second the error is shown beside them. The lists belong to the
//!   target they were read for (a pod, or every ready pod on Auto): after
//!   "Run on" changes, Generate waits for the new target's lists, so no model
//!   of pod A is sent to pod B.
//! - **Input images** are slots: the first and last frames, H3's references,
//!   and LTX's reference sheet — one image of its own, not one of the
//!   references. A batch is cut to what fits before anything is read, and
//!   prepared a few at a time. Each slot (and each Reproduce) has a revision,
//!   so an image that finishes late never replaces a newer one.
//! - **Rules.** Bounds, defaults, normalisation, frame counts and sizes are the
//!   shared TypeScript's ([`crate::rules`]), called on a change; what the web
//!   keeps in its components (recommended settings, advice) is in
//!   [`crate::form`].

mod h3;
mod ltx;

use std::{collections::HashMap, path::PathBuf, rc::Rc, sync::Arc, time::Duration};

use futures::StreamExt as _;

use artsnack_api_tab::{PromptMentions, TagInserted, TaggableReferences, VideoRole};
use artsnack_backend::{
    Backend, CallError, NoArgs,
    api::{
        comfy_video_jobs::{
            self, H3Mode, H3Settings, InputRole, LtxMode, LtxSettings, SparseAttention, StartArgs,
            VideoInput, VideoLora,
        },
        grok_generations::{self, ApiGeneration},
        pod_catalog::{self, LtxCatalog, VideoCatalogArgs, VideoPodCatalog},
        runpod_backend_store::RunpodBackend,
        runpod_backends::BackendState,
    },
};
use artsnack_media::{Media, fetch::Fetcher, upload};
use artsnack_pods::{PodCatalogVersion, Poller};
use artsnack_prompts::{ContextReader, PromptEnhance, PromptLibrary, PromptReader, PromptWriter};
use artsnack_rules::Rules;
use artsnack_settings::Preferences;
use gpui_kit::{
    AnyElement, AnyWindowHandle, App, AppContext as _, AsyncApp, Context, Entity, FocusHandle,
    Focusable, FontWeight, InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _,
    PathPromptOptions, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState, NumberInput, Paste, TextareaState},
        notification::Notification,
        searchable_list::SearchableVec,
        select::{SelectEvent, SelectState},
        slider::{SliderEvent, SliderState},
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};
use serde_json::{Value, json};

use crate::{
    controls::{
        Field, ModelChoice, NumberSpec, choice, hint, number_state, parse_number, section_title,
    },
    form::{
        self, CUSTOM, FAMILY, Family, H3Form, InputCounts, LtxForm, MAX_CLIPS, SHEET_ENHANCE_TARGET,
    },
    inputs::{self, InputImage, Pasted, Prepared},
    loras::{LoraStack, LorasChanged},
    pods::{VideoPods, is_b300, video_pod_label},
    rules::{self, VideoRules},
};

actions!(video_composer, [Submit]);

pub(crate) const CONTEXT: &str = "VideoComposer";

pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-enter", Submit, Some(CONTEXT)),
        KeyBinding::new("cmd-enter", Submit, Some(&artsnack_ui::field_in(CONTEXT))),
        // A paste while the form itself has focus (not one of its fields)
        // still reaches the form, so an image can land in a slot.
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-v", Paste, Some(CONTEXT)),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-v", Paste, Some(CONTEXT)),
    ]);
}

/// The fallback re-read of the pods' model lists. A "To pod" download
/// announces itself and the tab re-reads on return, so this only catches
/// changes made from somewhere else.
const CATALOG_POLL: Duration = Duration::from_secs(90);
/// Images read and prepared at once. Each holds its file, its decoded pixels
/// and a JPEG while it is worked on, so a dropped folder must not run all of
/// them side by side.
const PREPARE_CONCURRENCY: usize = 3;

type NameSelect = SelectState<SearchableVec<SharedString>>;
type ModelSelect = SelectState<SearchableVec<ModelChoice>>;

/// What the catalogue is read for. `version` changes whenever a re-read is
/// due at once, which the poller turns into a read.
#[derive(Clone, Debug, PartialEq)]
struct CatalogKey {
    backend_id: Option<String>,
    version: u64,
}

/// The typed numbers of both forms.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Num {
    H3Steps,
    H3ShiftVideo,
    H3ShiftAudio,
    H3Sparse,
    H3EasyCache,
    H3Width,
    H3Height,
    LtxSteps,
    LtxCfg,
    LtxWidth,
    LtxHeight,
}

const NUMS: [Num; 11] = [
    Num::H3Steps,
    Num::H3ShiftVideo,
    Num::H3ShiftAudio,
    Num::H3Sparse,
    Num::H3EasyCache,
    Num::H3Width,
    Num::H3Height,
    Num::LtxSteps,
    Num::LtxCfg,
    Num::LtxWidth,
    Num::LtxHeight,
];

fn num_spec(num: Num, h3: &H3Settings, rules: &VideoRules) -> NumberSpec {
    let h = &rules.h3_limits;
    let l = &rules.ltx_limits;
    match num {
        Num::H3Steps => NumberSpec::new(h.steps.min, h.steps.max, 1.0, 0),
        Num::H3ShiftVideo | Num::H3ShiftAudio => NumberSpec::new(h.shift.min, h.shift.max, 0.5, 2),
        Num::H3Sparse if h3.sparse_attention == SparseAttention::Vsa => {
            NumberSpec::new(h.sparse_keep_percent.min, h.sparse_keep_percent.max, 0.5, 1)
        }
        Num::H3Sparse => NumberSpec::new(h.sparse_tau.min, h.sparse_tau.max, 0.05, 2),
        Num::H3EasyCache => NumberSpec::new(
            h.easy_cache_threshold.min,
            h.easy_cache_threshold.max,
            0.05,
            2,
        ),
        Num::H3Width | Num::H3Height => NumberSpec::new(h.dimension.min, h.dimension.max, 32.0, 0),
        Num::LtxSteps => NumberSpec::new(l.steps.min, l.steps.max, 1.0, 0),
        Num::LtxCfg => NumberSpec::new(l.cfg.min, l.cfg.max, 0.5, 1),
        Num::LtxWidth | Num::LtxHeight => {
            NumberSpec::new(l.dimension.min, l.dimension.max, 64.0, 0)
        }
    }
}

fn num_value(num: Num, h3: &H3Settings, ltx: &LtxSettings) -> f64 {
    match num {
        Num::H3Steps => h3.steps,
        Num::H3ShiftVideo => h3.shift_video,
        Num::H3ShiftAudio => h3.shift_audio,
        Num::H3Sparse => h3.sparse_value,
        Num::H3EasyCache => h3.easy_cache_threshold,
        Num::H3Width => h3.width,
        Num::H3Height => h3.height,
        Num::LtxSteps => ltx.steps,
        Num::LtxCfg => ltx.cfg,
        Num::LtxWidth => ltx.width,
        Num::LtxHeight => ltx.height,
    }
}

/// The sliders of both forms.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Slide {
    H3Duration,
    LtxDuration,
    LtxImageStrength,
    LtxImageCompression,
    LtxSheetStrength,
}

const SLIDES: [Slide; 5] = [
    Slide::H3Duration,
    Slide::LtxDuration,
    Slide::LtxImageStrength,
    Slide::LtxImageCompression,
    Slide::LtxSheetStrength,
];

fn slide_spec(slide: Slide, rules: &VideoRules) -> NumberSpec {
    let h = &rules.h3_limits;
    let l = &rules.ltx_limits;
    match slide {
        Slide::H3Duration => {
            NumberSpec::new(h.duration_seconds.min, h.duration_seconds.max, 1.0, 0)
        }
        Slide::LtxDuration => {
            NumberSpec::new(l.duration_seconds.min, l.duration_seconds.max, 1.0, 0)
        }
        Slide::LtxImageStrength => NumberSpec::new(0.0, 1.0, 0.05, 2),
        Slide::LtxImageCompression => {
            NumberSpec::new(l.image_compression.min, l.image_compression.max, 1.0, 0)
        }
        Slide::LtxSheetStrength => {
            NumberSpec::new(l.sheet_strength.min, l.sheet_strength.max, 0.05, 2)
        }
    }
}

fn slide_value(slide: Slide, h3: &H3Settings, ltx: &LtxSettings) -> f64 {
    match slide {
        Slide::H3Duration => h3.duration_seconds,
        Slide::LtxDuration => ltx.duration_seconds,
        Slide::LtxImageStrength => ltx.image_strength,
        Slide::LtxImageCompression => ltx.image_compression,
        Slide::LtxSheetStrength => ltx.sheet_strength.unwrap_or(1.0),
    }
}

/// Values worked out from the forms (and the pods' lists) by the shared rules,
/// refreshed on a change rather than read while rendering.
#[derive(Default)]
struct Derived {
    h3_frames: Option<u32>,
    ltx_frames: Option<u32>,
    /// An `@imageN` past the references (H3 Reference mode only).
    tag_problem: Option<String>,
    /// The LoRA the LTX checkpoint is built to run with.
    ltx_companion: Option<VideoLora>,
    /// The line under LTX's checkpoint picker.
    ltx_checkpoint_advice: Option<form::Advice>,
}

/// Where an attached image goes. H3's references and LTX's reference sheet
/// are uploaded with the same role, but they are separate slots: the sheet is
/// one image of its own, never counted against H3's references nor hidden
/// behind them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Slot {
    First,
    Last,
    Reference,
    Sheet,
}

impl Slot {
    fn role(self) -> InputRole {
        match self {
            Slot::First => InputRole::First,
            Slot::Last => InputRole::Last,
            Slot::Reference | Slot::Sheet => InputRole::Reference,
        }
    }

    /// Holds one image, which a new one replaces.
    fn is_single(self) -> bool {
        self != Slot::Reference
    }
}

/// What an image being prepared was meant for, to tell when it arrives
/// whether that still holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ticket {
    /// The input set's revision: a Reproduce replaces the set.
    inputs: u64,
    /// A single slot's revision: a later image for the slot replaces this one.
    slot: Option<u64>,
}

/// Where an image comes from before it is prepared.
enum Source {
    File(PathBuf),
    Pasted(Pasted),
    Url {
        url: String,
        source_key: Option<String>,
    },
}

/// The mode the open family is in, as the input slots read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InputMode {
    Text,
    Frames,
    Reference,
    Sheet,
}

pub(crate) struct VideoComposer {
    rules: Rc<VideoRules>,
    focus_handle: FocusHandle,
    window: AnyWindowHandle,
    family: Family,
    h3: H3Form,
    ltx: LtxForm,
    derived: Derived,
    /// First and last frames and H3's references.
    inputs: Vec<InputImage>,
    /// LTX's reference sheet.
    sheet: Option<InputImage>,
    /// Images being prepared, by the slot each will take.
    preparing: Vec<Slot>,
    /// Bumped by each Reproduce, which replaces the whole set: images still
    /// being prepared for the old set are dropped.
    inputs_revision: u64,
    /// Bumped by each image started for a single slot.
    slot_revisions: HashMap<Slot, u64>,
    fal_limits: Option<upload::ProfileLimits>,
    pods: VideoPods,
    /// The pod picked in "Run on"; `None` is Auto.
    run_on: Option<String>,
    catalog: Option<VideoPodCatalog>,
    /// What the lists were read for: a pod's id, or `None` for every ready
    /// pod (Auto). `None` here: nothing read yet.
    catalog_origin: Option<Option<String>>,
    catalog_failures: u32,
    catalog_version: u64,
    /// Whether the tab is on screen; the catalogue is only read while it is.
    active: bool,
    catalog_poller: Poller<CatalogKey>,
    /// While a submit runs: what it is doing.
    submitting: Option<SharedString>,
    prompt: Entity<TextareaState>,
    /// The prompt field with its `@image` menu and tag tokens.
    mentions: Entity<PromptMentions>,
    library: Entity<PromptLibrary>,
    enhancer: Entity<PromptEnhance>,
    negative_prompt: Entity<InputState>,
    h3_checkpoint: Entity<ModelSelect>,
    ltx_checkpoint: Entity<ModelSelect>,
    sampler: Entity<NameSelect>,
    scheduler: Entity<NameSelect>,
    h3_loras: Entity<LoraStack>,
    ltx_loras: Entity<LoraStack>,
    numbers: HashMap<Num, Entity<InputState>>,
    sliders: HashMap<Slide, Entity<SliderState>>,
    h3_seed: Entity<InputState>,
    ltx_seed: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

impl VideoComposer {
    pub fn new(
        pods: VideoPods,
        rules: Rc<VideoRules>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let family = Preferences::get(cx, &FAMILY);
        let h3 = H3Form::load(cx, &rules);
        let ltx = LtxForm::load(cx, &rules);
        let fal_limits = Rules::global(cx)
            .and_then(|shared| shared.get("referenceProfile.REFERENCE_PROFILES.fal").ok());
        let mut subscriptions = Vec::new();

        let active_prompt = match family {
            Family::H3 => h3.settings.prompt.clone(),
            Family::Ltx => ltx.settings.prompt.clone(),
        };
        let prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(5, 16)
                .default_value(active_prompt)
        });
        subscriptions.push(
            cx.subscribe(&prompt, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.prompt_changed(text, cx);
                }
            }),
        );
        let read: PromptReader = {
            let prompt = prompt.clone();
            Rc::new(move |cx| prompt.read(cx).value().to_string())
        };
        let write: PromptWriter = {
            let view = cx.entity().downgrade();
            Rc::new(move |text, window, cx| {
                let _ = view.update(cx, |this, cx| this.replace_prompt(text, window, cx));
            })
        };
        let context: ContextReader = {
            let view = cx.entity().downgrade();
            Rc::new(move |cx| {
                view.upgrade()
                    .map(|view| view.read(cx).enhance_context())
                    .unwrap_or_else(|| json!({ "media": "video" }))
            })
        };
        let library = cx.new(|cx| PromptLibrary::new(read.clone(), write.clone(), window, cx));
        let enhancer = cx.new(|cx| PromptEnhance::new(read, write, context, window, cx));
        // Only H3's Reference mode reads `@imageN` tags.
        let taggable: TaggableReferences = {
            let view = cx.entity().downgrade();
            Rc::new(move |cx| {
                let Some(view) = view.upgrade() else {
                    return Vec::new();
                };
                let this = view.read(cx);
                if this.family != Family::H3 || this.h3.settings.mode != H3Mode::Reference {
                    return Vec::new();
                }
                this.references()
                    .into_iter()
                    .map(|image| image.preview.clone())
                    .collect()
            })
        };
        let mentions = cx.new(|cx| PromptMentions::new(prompt.clone(), taggable, window, cx));
        subscriptions.push(cx.subscribe(&mentions, |this, _, _: &TagInserted, cx| {
            let text = this.prompt.read(cx).value().to_string();
            this.prompt_changed(text, cx);
        }));

        let negative_prompt = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Negative prompt (used because CFG > 1)")
                .default_value(ltx.settings.negative_prompt.clone())
        });
        subscriptions.push(cx.subscribe_in(
            &negative_prompt,
            window,
            |this, state, event, _, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    if text != this.ltx.settings.negative_prompt {
                        this.update_ltx(cx, |form| form.settings.negative_prompt = text);
                    }
                }
            },
        ));

        let model_select = |window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| {
                SelectState::new(
                    SearchableVec::new(Vec::<ModelChoice>::new()),
                    None,
                    window,
                    cx,
                )
                .searchable(true)
            })
        };
        let h3_checkpoint = model_select(window, cx);
        let ltx_checkpoint = model_select(window, cx);
        subscriptions.push(cx.subscribe_in(
            &h3_checkpoint,
            window,
            |this, _, event: &SelectEvent<SearchableVec<ModelChoice>>, _, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                let value = value.to_string();
                this.update_h3(cx, |form| form.settings.checkpoint = value);
            },
        ));
        subscriptions.push(cx.subscribe_in(
            &ltx_checkpoint,
            window,
            |this, _, event: &SelectEvent<SearchableVec<ModelChoice>>, window, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                this.pick_ltx_checkpoint(value.to_string(), window, cx);
            },
        ));

        let name_select =
            |items: Vec<SharedString>, value: &str, window: &mut Window, cx: &mut Context<Self>| {
                let value = SharedString::from(value.to_string());
                let select = cx.new(|cx| {
                    SelectState::new(SearchableVec::new(items), None, window, cx).searchable(true)
                });
                select.update(cx, |select, cx| {
                    select.set_selected_value(&value, window, cx)
                });
                select
            };
        let sampler = name_select(rules.h3_samplers.clone(), &h3.settings.sampler, window, cx);
        let scheduler = name_select(
            rules.h3_schedulers.clone(),
            &h3.settings.scheduler,
            window,
            cx,
        );
        subscriptions.push(cx.subscribe_in(
            &sampler,
            window,
            |this, _, event: &SelectEvent<SearchableVec<SharedString>>, _, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                let value = value.to_string();
                this.update_h3(cx, |form| form.settings.sampler = value);
            },
        ));
        subscriptions.push(cx.subscribe_in(
            &scheduler,
            window,
            |this, _, event: &SelectEvent<SearchableVec<SharedString>>, _, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                let value = value.to_string();
                this.update_h3(cx, |form| form.settings.scheduler = value);
            },
        ));

        let h3_loras = cx.new(|cx| {
            LoraStack::new(
                "h3-lora",
                rules.h3_limits.loras,
                rules.h3_limits.lora_strength,
                "No H3 LoRAs on the pod yet",
                &h3.settings.loras,
                window,
                cx,
            )
        });
        let ltx_loras = cx.new(|cx| {
            LoraStack::new(
                "ltx-lora",
                rules.ltx_limits.loras,
                rules.ltx_limits.lora_strength,
                "No LTX LoRAs on the pod yet",
                &ltx.settings.loras,
                window,
                cx,
            )
        });
        subscriptions.push(cx.subscribe(&h3_loras, |this, _, LorasChanged(loras), cx| {
            let loras = loras.clone();
            this.update_h3(cx, |form| form.settings.loras = loras);
        }));
        subscriptions.push(
            cx.subscribe(&ltx_loras, |this, _, LorasChanged(loras), cx| {
                let loras = loras.clone();
                this.update_ltx(cx, |form| form.settings.loras = loras);
            }),
        );

        let mut numbers = HashMap::new();
        for num in NUMS {
            let state = number_state(
                num_value(num, &h3.settings, &ltx.settings),
                num_spec(num, &h3.settings, &rules),
                window,
                cx,
            );
            subscriptions.push(cx.subscribe_in(
                &state,
                window,
                move |this, state, event: &InputEvent, window, cx| {
                    this.number_event(num, state, event, window, cx)
                },
            ));
            numbers.insert(num, state);
        }

        let mut sliders = HashMap::new();
        for slide in SLIDES {
            let spec = slide_spec(slide, &rules);
            let value = spec.clamp(slide_value(slide, &h3.settings, &ltx.settings));
            let state = cx.new(|_| {
                SliderState::new()
                    .min(spec.min as f32)
                    .max(spec.max as f32)
                    .step(spec.step as f32)
                    .default_value(value as f32)
            });
            subscriptions.push(
                cx.subscribe(&state, move |this, _, event: &SliderEvent, cx| {
                    let value = match event {
                        SliderEvent::Change(value) | SliderEvent::Release(value) => value.start(),
                    };
                    this.slide_changed(slide, value as f64, cx);
                }),
            );
            sliders.insert(slide, state);
        }

        let seed_state = |seed: f64, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("random")
                    .default_value(format_seed(seed))
            })
        };
        let h3_seed = seed_state(h3.settings.seed, window, cx);
        let ltx_seed = seed_state(ltx.settings.seed, window, cx);
        for (state, family) in [(&h3_seed, Family::H3), (&ltx_seed, Family::Ltx)] {
            subscriptions.push(cx.subscribe_in(
                state,
                window,
                move |this, state, event: &InputEvent, window, cx| {
                    this.seed_event(family, state, event, window, cx)
                },
            ));
        }

        subscriptions.push(cx.observe(&pods, |this, _, cx| this.pods_changed(cx)));
        // A model landed on a pod ("To pod"): re-read the lists at once.
        subscriptions
            .push(cx.observe_global::<PodCatalogVersion>(|this, cx| this.reread_catalog(cx)));
        // Coming back to a hidden window re-reads too, as the web does on
        // `visibilitychange`; the poller itself is idle while hidden.
        subscriptions.push(
            cx.observe_window_visibility(window, |this, visibility, _, cx| {
                if visibility.is_visible() {
                    this.reread_catalog(cx);
                }
            }),
        );

        let catalog_poller = Poller::new(
            window,
            cx,
            |this: &mut Self| &mut this.catalog_poller,
            Self::poll_catalog,
        );
        // Previews are drawn from GPU textures that outlive the image unless
        // released.
        subscriptions.push(cx.on_release(|this, cx| {
            for image in this.inputs.drain(..).chain(this.sheet.take()) {
                cx.drop_image(image.preview, None);
            }
        }));

        let mut this = Self {
            rules,
            focus_handle: cx.focus_handle(),
            window: window.window_handle(),
            family,
            h3,
            ltx,
            derived: Derived::default(),
            inputs: Vec::new(),
            sheet: None,
            preparing: Vec::new(),
            inputs_revision: 0,
            slot_revisions: HashMap::new(),
            fal_limits,
            pods,
            run_on: None,
            catalog: None,
            catalog_origin: None,
            catalog_failures: 0,
            catalog_version: 0,
            active: true,
            catalog_poller,
            submitting: None,
            prompt,
            mentions,
            library,
            enhancer,
            negative_prompt,
            h3_checkpoint,
            ltx_checkpoint,
            sampler,
            scheduler,
            h3_loras,
            ltx_loras,
            numbers,
            sliders,
            h3_seed,
            ltx_seed,
            _subscriptions: subscriptions,
        };
        this.refresh_derived(cx);
        this.sync_placeholder(window, cx);
        this.refresh_catalog_key(cx);
        this
    }

    fn toast(&self, notification: Notification, cx: &mut App) {
        let _ = self.window.update(cx, |_, window, cx| {
            window.push_notification(notification, cx)
        });
    }

    // --- Form changes ---------------------------------------------------------

    fn update_h3(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut H3Form)) {
        change(&mut self.h3);
        self.h3.save(cx);
        self.refresh_derived(cx);
        cx.notify();
    }

    fn update_ltx(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut LtxForm)) {
        change(&mut self.ltx);
        self.ltx.save(cx);
        self.refresh_derived(cx);
        cx.notify();
    }

    fn refresh_derived(&mut self, cx: &App) {
        let h3 = &self.h3.settings;
        let ltx = &self.ltx.settings;
        let references = self.references().len();
        self.derived = Derived {
            h3_frames: rules::h3_frame_count(cx, h3.duration_seconds),
            ltx_frames: rules::ltx_frame_count(cx, ltx.duration_seconds, ltx.fps),
            tag_problem: (h3.mode == H3Mode::Reference)
                .then(|| rules::h3_tag_problem(cx, &h3.prompt, references))
                .flatten(),
            ltx_companion: rules::ltx_companion(cx, &ltx.checkpoint),
            ltx_checkpoint_advice: None,
        };
        self.derived.ltx_checkpoint_advice = form::ltx_checkpoint_advice(
            ltx,
            self.derived.ltx_companion.as_ref(),
            self.ltx_catalog()
                .map(|catalog| catalog.loras.as_slice())
                .unwrap_or_default(),
        );
    }

    fn set_family(&mut self, family: Family, window: &mut Window, cx: &mut Context<Self>) {
        if self.family == family {
            return;
        }
        self.family = family;
        Preferences::set(cx, &FAMILY, family);
        self.sync_prompt(window, cx);
        cx.notify();
    }

    /// Switches H3's mode, carrying an official checkpoint and Turbo's steps.
    fn set_h3_mode(&mut self, mode: H3Mode, window: &mut Window, cx: &mut Context<Self>) {
        let rules = self.rules.clone();
        self.update_h3(cx, |form| {
            form::h3_with_mode(&mut form.settings, mode, &rules)
        });
        self.sync_h3_checkpoint(window, cx);
        self.sync_number(Num::H3Steps, window, cx);
        self.sync_placeholder(window, cx);
    }

    fn set_ltx_mode(&mut self, mode: LtxMode, window: &mut Window, cx: &mut Context<Self>) {
        self.update_ltx(cx, |form| form.settings.mode = mode);
        self.sync_placeholder(window, cx);
    }

    /// Turbo has its own step count per mode; without it the model wants 20.
    fn set_turbo(&mut self, turbo: bool, window: &mut Window, cx: &mut Context<Self>) {
        let steps = if turbo {
            self.rules.h3_turbo_steps.get(self.h3.settings.mode)
        } else {
            self.rules.h3_full_steps
        };
        self.update_h3(cx, |form| {
            form.settings.turbo = turbo;
            form.settings.steps = steps;
        });
        self.sync_number(Num::H3Steps, window, cx);
    }

    /// Each sparse mode reads its value differently: VSA a keep percent
    /// (trained at 10), SOL a tau.
    fn set_sparse(&mut self, sparse: SparseAttention, window: &mut Window, cx: &mut Context<Self>) {
        self.update_h3(cx, |form| {
            form.settings.sparse_attention = sparse;
            form.settings.sparse_value = match sparse {
                SparseAttention::Vsa => 10.0,
                SparseAttention::Sol => 1.3,
                SparseAttention::Off => form.settings.sparse_value,
            };
        });
        self.sync_number(Num::H3Sparse, window, cx);
    }

    /// A size preset: an aspect at a short edge, or Custom (typed by hand).
    fn set_preset(
        &mut self,
        family: Family,
        aspect: SharedString,
        short_edge: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let size = (aspect != CUSTOM)
            .then(|| match family {
                Family::H3 => rules::h3_dimensions(cx, short_edge, &aspect),
                Family::Ltx => rules::ltx_dimensions(cx, short_edge, &aspect),
            })
            .flatten();
        match family {
            Family::H3 => {
                self.update_h3(cx, |form| {
                    form.aspect = aspect;
                    form.short_edge = short_edge;
                    if let Some((width, height)) = size {
                        form.settings.width = width;
                        form.settings.height = height;
                    }
                });
                self.sync_number(Num::H3Width, window, cx);
                self.sync_number(Num::H3Height, window, cx);
            }
            Family::Ltx => {
                self.update_ltx(cx, |form| {
                    form.aspect = aspect;
                    form.short_edge = short_edge;
                    if let Some((width, height)) = size {
                        form.settings.width = width;
                        form.settings.height = height;
                    }
                });
                self.sync_number(Num::LtxWidth, window, cx);
                self.sync_number(Num::LtxHeight, window, cx);
            }
        }
    }

    fn reset_h3_recommended(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rules = self.rules.clone();
        self.update_h3(cx, |form| {
            form::apply_h3_recommended(&mut form.settings, &rules)
        });
        self.sync_h3_controls(window, cx);
    }

    fn reset_ltx_recommended(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rules = self.rules.clone();
        self.update_ltx(cx, |form| {
            form::apply_ltx_recommended(&mut form.settings, &rules)
        });
        self.sync_ltx_controls(window, cx);
    }

    /// A checkpoint brings its companion LoRA and drops the previous one's.
    fn pick_ltx_checkpoint(&mut self, value: String, window: &mut Window, cx: &mut Context<Self>) {
        let companion = rules::ltx_companion(cx, &value);
        let available = self
            .ltx_catalog()
            .map(|ltx| ltx.loras.clone())
            .unwrap_or_default();
        let loras =
            form::ltx_loras_for(&self.ltx.settings.loras, companion, &self.rules, &available);
        let stack_loras = loras.clone();
        self.update_ltx(cx, |form| {
            form.settings.checkpoint = value;
            form.settings.loras = loras;
        });
        self.ltx_loras
            .update(cx, |stack, cx| stack.set_loras(&stack_loras, window, cx));
    }

    fn set_count(&mut self, count: u32, cx: &mut Context<Self>) {
        match self.family {
            Family::H3 => self.update_h3(cx, |form| form.count = count),
            Family::Ltx => self.update_ltx(cx, |form| form.count = count),
        }
    }

    // --- Numbers, sliders and seeds -------------------------------------------

    fn number_event(
        &mut self,
        num: Num,
        state: &Entity<InputState>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let spec = num_spec(num, &self.h3.settings, &self.rules);
        let typed = parse_number(&state.read(cx).value());
        match event {
            // Typing takes effect as it goes; leaving the field clamps it.
            InputEvent::Change => {
                if let Some(value) = typed {
                    self.set_number(num, value, cx);
                }
            }
            InputEvent::Blur | InputEvent::PressEnter { .. } => {
                self.set_number(num, spec.clamp(typed.unwrap_or(spec.min)), cx);
                self.sync_number(num, window, cx);
            }
            _ => {}
        }
    }

    fn set_number(&mut self, num: Num, value: f64, cx: &mut Context<Self>) {
        if num_value(num, &self.h3.settings, &self.ltx.settings) == value {
            return;
        }
        match num {
            Num::H3Steps => self.update_h3(cx, |form| form.settings.steps = value),
            Num::H3ShiftVideo => self.update_h3(cx, |form| form.settings.shift_video = value),
            Num::H3ShiftAudio => self.update_h3(cx, |form| form.settings.shift_audio = value),
            Num::H3Sparse => self.update_h3(cx, |form| form.settings.sparse_value = value),
            Num::H3EasyCache => {
                self.update_h3(cx, |form| form.settings.easy_cache_threshold = value)
            }
            Num::H3Width => self.update_h3(cx, |form| form.settings.width = value),
            Num::H3Height => self.update_h3(cx, |form| form.settings.height = value),
            Num::LtxSteps => self.update_ltx(cx, |form| form.settings.steps = value),
            Num::LtxCfg => self.update_ltx(cx, |form| form.settings.cfg = value),
            Num::LtxWidth => self.update_ltx(cx, |form| form.settings.width = value),
            Num::LtxHeight => self.update_ltx(cx, |form| form.settings.height = value),
        }
    }

    fn slide_changed(&mut self, slide: Slide, value: f64, cx: &mut Context<Self>) {
        let spec = slide_spec(slide, &self.rules);
        let scale = 10f64.powi(spec.decimals as i32);
        let value = spec.clamp((value * scale).round() / scale);
        if slide_value(slide, &self.h3.settings, &self.ltx.settings) == value {
            return;
        }
        match slide {
            Slide::H3Duration => self.update_h3(cx, |form| form.settings.duration_seconds = value),
            Slide::LtxDuration => {
                self.update_ltx(cx, |form| form.settings.duration_seconds = value)
            }
            Slide::LtxImageStrength => {
                self.update_ltx(cx, |form| form.settings.image_strength = value)
            }
            Slide::LtxImageCompression => {
                self.update_ltx(cx, |form| form.settings.image_compression = value)
            }
            Slide::LtxSheetStrength => {
                self.update_ltx(cx, |form| form.settings.sheet_strength = Some(value))
            }
        }
    }

    /// Blank is random (-1); anything else a whole number from 0.
    fn seed_event(
        &mut self,
        family: Family,
        state: &Entity<InputState>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = state.read(cx).value();
        let seed = if text.trim().is_empty() {
            Some(-1.0)
        } else {
            parse_number(&text).map(|seed| seed.round().max(0.0))
        };
        match event {
            InputEvent::Change => {
                if let Some(seed) = seed {
                    self.set_seed(family, seed, cx);
                }
            }
            InputEvent::Blur | InputEvent::PressEnter { .. } => {
                if let Some(seed) = seed {
                    self.set_seed(family, seed, cx);
                }
                self.sync_seed(family, window, cx);
            }
            _ => {}
        }
    }

    fn set_seed(&mut self, family: Family, seed: f64, cx: &mut Context<Self>) {
        match family {
            Family::H3 if self.h3.settings.seed != seed => {
                self.update_h3(cx, |form| form.settings.seed = seed)
            }
            Family::Ltx if self.ltx.settings.seed != seed => {
                self.update_ltx(cx, |form| form.settings.seed = seed)
            }
            _ => {}
        }
    }

    fn random_seed(&mut self, family: Family, window: &mut Window, cx: &mut Context<Self>) {
        self.set_seed(family, -1.0, cx);
        self.sync_seed(family, window, cx);
    }

    // --- Writing the forms back into the controls ---------------------------
    //
    // After a change made for the user (Reproduce, a reset, a mode that moves
    // the checkpoint), never in reply to the control's own event.

    fn sync_number(&mut self, num: Num, window: &mut Window, cx: &mut Context<Self>) {
        let spec = num_spec(num, &self.h3.settings, &self.rules);
        let text = spec.format(num_value(num, &self.h3.settings, &self.ltx.settings));
        let Some(state) = self.numbers.get(&num) else {
            return;
        };
        state.update(cx, |input, cx| {
            if num == Num::H3Sparse {
                input.set_min(Some(spec.min), window, cx);
                input.set_max(Some(spec.max), window, cx);
                input.set_step(Some(spec.step.into()), window, cx);
            }
            if input.value().as_ref() != text {
                input.set_value(text, window, cx);
            }
        });
    }

    fn sync_slider(&mut self, slide: Slide, window: &mut Window, cx: &mut Context<Self>) {
        let spec = slide_spec(slide, &self.rules);
        let value = spec.clamp(slide_value(slide, &self.h3.settings, &self.ltx.settings));
        if let Some(state) = self.sliders.get(&slide) {
            state.update(cx, |slider, cx| slider.set_value(value as f32, window, cx));
        }
    }

    fn sync_seed(&mut self, family: Family, window: &mut Window, cx: &mut Context<Self>) {
        let (state, seed) = match family {
            Family::H3 => (&self.h3_seed, self.h3.settings.seed),
            Family::Ltx => (&self.ltx_seed, self.ltx.settings.seed),
        };
        let text = format_seed(seed);
        state.update(cx, |input, cx| {
            if input.value().as_ref() != text {
                input.set_value(text, window, cx);
            }
        });
    }

    fn sync_h3_checkpoint(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = SharedString::from(self.h3.settings.checkpoint.clone());
        self.h3_checkpoint.update(cx, |select, cx| {
            select.set_selected_value(&value, window, cx)
        });
    }

    fn sync_h3_controls(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for num in [
            Num::H3Steps,
            Num::H3ShiftVideo,
            Num::H3ShiftAudio,
            Num::H3Sparse,
            Num::H3EasyCache,
            Num::H3Width,
            Num::H3Height,
        ] {
            self.sync_number(num, window, cx);
        }
        self.sync_slider(Slide::H3Duration, window, cx);
        self.sync_seed(Family::H3, window, cx);
        self.sync_h3_checkpoint(window, cx);
        let settings = &self.h3.settings;
        for (select, value) in [
            (&self.sampler, &settings.sampler),
            (&self.scheduler, &settings.scheduler),
        ] {
            let value = SharedString::from(value.clone());
            select.update(cx, |select, cx| {
                select.set_selected_value(&value, window, cx)
            });
        }
        let loras = settings.loras.clone();
        self.h3_loras
            .update(cx, |stack, cx| stack.set_loras(&loras, window, cx));
        self.sync_prompt(window, cx);
    }

    fn sync_ltx_controls(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for num in [Num::LtxSteps, Num::LtxCfg, Num::LtxWidth, Num::LtxHeight] {
            self.sync_number(num, window, cx);
        }
        for slide in [
            Slide::LtxDuration,
            Slide::LtxImageStrength,
            Slide::LtxImageCompression,
            Slide::LtxSheetStrength,
        ] {
            self.sync_slider(slide, window, cx);
        }
        self.sync_seed(Family::Ltx, window, cx);
        let checkpoint = SharedString::from(self.ltx.settings.checkpoint.clone());
        self.ltx_checkpoint.update(cx, |select, cx| {
            select.set_selected_value(&checkpoint, window, cx)
        });
        let loras = self.ltx.settings.loras.clone();
        self.ltx_loras
            .update(cx, |stack, cx| stack.set_loras(&loras, window, cx));
        let negative = self.ltx.settings.negative_prompt.clone();
        self.negative_prompt.update(cx, |input, cx| {
            if input.value().as_ref() != negative {
                input.set_value(negative, window, cx);
            }
        });
        self.sync_prompt(window, cx);
    }

    // --- The prompt -------------------------------------------------------------

    fn active_prompt(&self) -> &str {
        match self.family {
            Family::H3 => &self.h3.settings.prompt,
            Family::Ltx => &self.ltx.settings.prompt,
        }
    }

    fn prompt_changed(&mut self, text: String, cx: &mut Context<Self>) {
        if text == self.active_prompt() {
            return;
        }
        match self.family {
            Family::H3 => self.update_h3(cx, |form| form.settings.prompt = text),
            Family::Ltx => self.update_ltx(cx, |form| form.settings.prompt = text),
        }
    }

    /// Text from the library, Enhance or the two-part template.
    fn replace_prompt(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.mentions
            .update(cx, |mentions, cx| mentions.set_text(&text, window, cx));
        self.prompt_changed(text, cx);
    }

    /// Shows the open family's prompt.
    fn sync_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.active_prompt().to_string();
        if self.prompt.read(cx).value().as_ref() != text {
            self.mentions
                .update(cx, |mentions, cx| mentions.set_text(&text, window, cx));
        }
        self.sync_placeholder(window, cx);
    }

    fn sync_placeholder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let placeholder = match (self.family, self.h3.settings.mode, self.ltx.settings.mode) {
            (Family::H3, H3Mode::Reference, _) => {
                "Describe the action in order — tag references as @image1, @image2… Every motion and sound, dialogue in quotes."
            }
            (Family::H3, _, _) => {
                "Describe the action in order, every motion and every sound — H3 rewards long, literal prompts. Dialogue in quotes."
            }
            (Family::Ltx, _, LtxMode::Sheet) => {
                "Reference sheet: what the sheet shows.\n\nGenerated video: the scene, second by second."
            }
            (Family::Ltx, _, _) => {
                "Plain, literal scene script: who, where, what happens second by second, camera, sounds and dialogue in quotes."
            }
        };
        self.prompt.update(cx, |input, cx| {
            input.set_placeholder(placeholder, window, cx)
        });
    }

    /// The `EnhanceContext` for the open form.
    fn enhance_context(&self) -> Value {
        let mut context = json!({ "media": "video" });
        let (target, duration, aspect, frames) = match self.family {
            Family::H3 => (
                "MiniMax H3",
                self.h3.settings.duration_seconds,
                &self.h3.aspect,
                self.h3.settings.mode == H3Mode::Frames,
            ),
            Family::Ltx => (
                if self.ltx.settings.mode == LtxMode::Sheet {
                    SHEET_ENHANCE_TARGET
                } else {
                    "LTX 2.3"
                },
                self.ltx.settings.duration_seconds,
                &self.ltx.aspect,
                self.ltx.settings.mode == LtxMode::Frames,
            ),
        };
        context["targetModel"] = target.into();
        context["duration"] = duration.into();
        if aspect.as_ref() != CUSTOM {
            context["aspectRatio"] = aspect.to_string().into();
        }
        if self.family == Family::H3 && self.h3.settings.mode == H3Mode::Reference {
            context["referenceCount"] = self.references().len().into();
        }
        if frames {
            let inputs = self.input_counts();
            let which = match (inputs.first, inputs.last) {
                (true, true) => Some("both"),
                (true, false) => Some("first"),
                (false, true) => Some("last"),
                (false, false) => None,
            };
            if let Some(which) = which {
                context["frameInputs"] = which.into();
            }
        }
        context
    }

    // --- Input images -----------------------------------------------------------

    fn input_mode(&self) -> InputMode {
        match self.family {
            Family::H3 => match self.h3.settings.mode {
                H3Mode::Text => InputMode::Text,
                H3Mode::Frames => InputMode::Frames,
                H3Mode::Reference => InputMode::Reference,
            },
            Family::Ltx => match self.ltx.settings.mode {
                LtxMode::Text => InputMode::Text,
                LtxMode::Frames => InputMode::Frames,
                LtxMode::Sheet => InputMode::Sheet,
            },
        }
    }

    fn input(&self, role: InputRole) -> Option<&InputImage> {
        self.inputs.iter().find(|image| image.role == role)
    }

    fn references(&self) -> Vec<&InputImage> {
        self.inputs
            .iter()
            .filter(|image| image.role == InputRole::Reference)
            .collect()
    }

    /// LTX's sheet: one image, which the next one replaces.
    fn sheet(&self) -> Option<&InputImage> {
        self.sheet.as_ref()
    }

    fn input_counts(&self) -> InputCounts {
        InputCounts {
            first: self.input(InputRole::First).is_some(),
            last: self.input(InputRole::Last).is_some(),
            references: self.references().len(),
        }
    }

    /// What the open mode sends; the rest stays attached for later.
    fn visible_inputs(&self) -> Vec<InputImage> {
        match self.input_mode() {
            InputMode::Text => Vec::new(),
            InputMode::Frames => self
                .inputs
                .iter()
                .filter(|image| image.role != InputRole::Reference)
                .cloned()
                .collect(),
            InputMode::Reference => self.references().into_iter().cloned().collect(),
            InputMode::Sheet => self.sheet.iter().cloned().collect(),
        }
    }

    fn is_preparing(&self, slot: Slot) -> bool {
        self.preparing.contains(&slot)
    }

    /// How many more images `slot` takes, counting those being prepared for
    /// it. A single slot always takes one (it replaces).
    fn capacity(&self, slot: Slot) -> usize {
        if slot.is_single() {
            return 1;
        }
        let preparing = self.preparing.iter().filter(|kept| **kept == slot).count();
        self.rules
            .h3_limits
            .references
            .saturating_sub(self.references().len() + preparing)
    }

    /// Starts preparing for `slot`: a single slot's newer image supersedes
    /// any still being prepared for it.
    fn ticket(&mut self, slot: Slot) -> Ticket {
        let slot_revision = slot.is_single().then(|| {
            let revision = self.slot_revisions.entry(slot).or_default();
            *revision += 1;
            *revision
        });
        Ticket {
            inputs: self.inputs_revision,
            slot: slot_revision,
        }
    }

    fn is_current(&self, slot: Slot, ticket: Ticket) -> bool {
        ticket.inputs == self.inputs_revision
            && ticket
                .slot
                .is_none_or(|revision| self.slot_revisions.get(&slot) == Some(&revision))
    }

    fn finish_preparing(&mut self, slots: &[Slot]) {
        for slot in slots {
            if let Some(ix) = self.preparing.iter().position(|kept| kept == slot) {
                self.preparing.remove(ix);
            }
        }
    }

    /// Puts images in `slot`: a single slot keeps the last, references append
    /// up to the limit. What is replaced or turned away has its texture
    /// released.
    fn place(&mut self, slot: Slot, images: Vec<InputImage>, cx: &mut Context<Self>) {
        let mut released = Vec::new();
        for image in images {
            match slot {
                Slot::Sheet => released.extend(self.sheet.replace(image)),
                Slot::First | Slot::Last => {
                    let role = slot.role();
                    if let Some(ix) = self.inputs.iter().position(|kept| kept.role == role) {
                        released.push(self.inputs.remove(ix));
                    }
                    self.inputs.push(image);
                }
                Slot::Reference if self.references().len() < self.rules.h3_limits.references => {
                    self.inputs.push(image)
                }
                Slot::Reference => released.push(image),
            }
        }
        for image in released {
            cx.drop_image(image.preview, None);
        }
        self.refresh_derived(cx);
        cx.notify();
    }

    fn remove_input(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let removed = if self.sheet.as_ref().is_some_and(|image| image.id == id) {
            self.sheet.take()
        } else {
            self.inputs
                .iter()
                .position(|image| image.id == id)
                .map(|ix| self.inputs.remove(ix))
        };
        if let Some(image) = removed {
            cx.drop_image(image.preview, Some(window));
        }
        self.refresh_derived(cx);
        cx.notify();
    }

    /// Downloads (on the runtime) and prepares (in the background) images, a
    /// few at a time, then puts them in `slot` in the order given. The batch
    /// is cut to what the slot takes before anything is read.
    fn attach(
        &mut self,
        sources: Vec<Source>,
        slot: Slot,
        success: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        if sources.is_empty() {
            return;
        }
        let Some(limits) = self.fal_limits.clone() else {
            self.toast(
                Notification::error("Images cannot be prepared right now"),
                cx,
            );
            return;
        };
        let free = self.capacity(slot);
        if free == 0 {
            let limit = self.rules.h3_limits.references;
            self.toast(
                Notification::error(format!(
                    "All {limit} references are in use — remove one to add another"
                )),
                cx,
            );
            return;
        }
        let mut sources = sources;
        if slot.is_single() {
            // One fits; the last given is the one that would stay.
            sources = sources.pop().into_iter().collect();
        } else if sources.len() > free {
            sources.truncate(free);
            self.toast(
                Notification::info(format!(
                    "Only {free} more reference{} fit — the rest were not added",
                    if free == 1 { "" } else { "s" }
                )),
                cx,
            );
        }
        let ticket = self.ticket(slot);
        let slots = vec![slot; sources.len()];
        self.preparing.extend(slots.iter().copied());
        cx.notify();
        let fetcher = Media::fetcher(cx);
        cx.spawn(async move |this, cx| {
            let results = prepare_all(sources, fetcher, limits, cx).await;
            let _ = this.update(cx, |this, cx| {
                this.finish_preparing(&slots);
                let mut images = Vec::with_capacity(results.len());
                let mut failure = None;
                for result in results {
                    match result {
                        Ok(image) => images.push(image.into_input(slot.role())),
                        Err(error) => failure = Some(error),
                    }
                }
                if !this.is_current(slot, ticket) {
                    // A later image for the slot, or a Reproduce, came first.
                    cx.notify();
                    return;
                }
                this.place(slot, images, cx);
                match (failure, success) {
                    (Some(error), _) => this.toast(
                        Notification::error(format!("Could not add the image: {error}")),
                        cx,
                    ),
                    (None, Some(success)) => this.toast(Notification::success(success), cx),
                    (None, None) => {}
                }
            });
        })
        .detach();
    }

    fn add_files(&mut self, paths: Vec<PathBuf>, slot: Slot, cx: &mut Context<Self>) {
        let (accepted, refused): (Vec<_>, Vec<_>) = paths
            .into_iter()
            .partition(|path| inputs::is_accepted(path));
        if !refused.is_empty() {
            self.toast(
                Notification::error(
                    "Use PNG, JPEG, WebP or GIF images (AVIF and HEIC aren\u{2019}t supported yet)",
                ),
                cx,
            );
        }
        self.attach(
            accepted.into_iter().map(Source::File).collect(),
            slot,
            None,
            cx,
        );
    }

    fn pick_files(&mut self, slot: Slot, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: !slot.is_single(),
            prompt: Some("Attach".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                let _ = this.update(cx, |this, cx| this.add_files(paths, slot, cx));
            }
        })
        .detach();
    }

    fn open_gallery(&mut self, slot: Slot, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        artsnack_library::open_reference_picker(window, cx, move |picked, _, cx| {
            let _ = view.update(cx, |this, cx| {
                let source = Source::Url {
                    url: picked.url.to_string(),
                    source_key: Some(picked.b2_key),
                };
                this.attach(vec![source], slot, None, cx)
            });
        });
    }

    /// Where a pasted or dropped image goes in the open mode; none in Text.
    fn paste_slot(&self) -> Option<Slot> {
        match self.input_mode() {
            InputMode::Text => None,
            InputMode::Reference => Some(Slot::Reference),
            InputMode::Sheet => Some(Slot::Sheet),
            InputMode::Frames if self.input(InputRole::First).is_some() => Some(Slot::Last),
            InputMode::Frames => Some(Slot::First),
        }
    }

    /// An image pasted anywhere in the form lands where an image makes sense;
    /// a text paste falls through to the focused field.
    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        let Some(slot) = self.paste_slot() else {
            return;
        };
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        // Focus on the form itself means no field is taking the text.
        let into_text_field = !self.focus_handle.is_focused(window);
        let pasted = inputs::pasted_images(&item, into_text_field);
        if pasted.is_empty() {
            return;
        }
        cx.stop_propagation();
        self.attach(
            pasted.into_iter().map(Source::Pasted).collect(),
            slot,
            None,
            cx,
        );
    }

    /// "Use as reference" on a result: the visible form decides the slot.
    pub fn use_result(&mut self, url: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let slot = match self.family {
            Family::Ltx => {
                if self.ltx.settings.mode == LtxMode::Text {
                    self.set_ltx_mode(LtxMode::Frames, window, cx);
                }
                if self.ltx.settings.mode == LtxMode::Sheet {
                    Slot::Sheet
                } else {
                    Slot::First
                }
            }
            Family::H3 => {
                if self.h3.settings.mode == H3Mode::Text {
                    self.set_h3_mode(H3Mode::Frames, window, cx);
                }
                if self.h3.settings.mode == H3Mode::Reference {
                    Slot::Reference
                } else {
                    Slot::First
                }
            }
        };
        let success = match slot {
            Slot::Sheet => "Set as the reference sheet",
            Slot::Reference => "Added as a reference",
            _ => "Set as the first frame",
        };
        let source_key = Media::urls(cx).key_of(&url).map(str::to_string);
        self.attach(
            vec![Source::Url {
                url: url.to_string(),
                source_key,
            }],
            slot,
            Some(success.into()),
            cx,
        );
    }

    /// An image sent from the API tab: switches to the mode its role needs (a
    /// frame means Image → video, a reference H3's Reference — or LTX's sheet,
    /// when that is open) and attaches it.
    pub fn receive_handoff(
        &mut self,
        url: SharedString,
        role: VideoRole,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let becomes_sheet = role == VideoRole::Reference
            && self.family == Family::Ltx
            && self.ltx.settings.mode == LtxMode::Sheet;
        let slot = match role {
            VideoRole::Reference if becomes_sheet => Slot::Sheet,
            VideoRole::Reference => Slot::Reference,
            VideoRole::First => Slot::First,
            VideoRole::Last => Slot::Last,
        };
        if becomes_sheet {
            // The image becomes the sheet; nothing to switch.
        } else if slot == Slot::Reference {
            self.set_family(Family::H3, window, cx);
            if self.h3.settings.mode != H3Mode::Reference {
                self.set_h3_mode(H3Mode::Reference, window, cx);
            }
        } else if self.family == Family::Ltx {
            self.set_ltx_mode(LtxMode::Frames, window, cx);
        } else if self.h3.settings.mode != H3Mode::Frames {
            self.set_h3_mode(H3Mode::Frames, window, cx);
        }
        let success = match slot {
            Slot::Sheet => "Set as the reference sheet",
            Slot::Reference => "Added as a reference — tag it in the prompt with @image",
            Slot::First => "Set as the start frame",
            Slot::Last => "Set as the last frame",
        };
        let source_key = Media::urls(cx).key_of(&url).map(str::to_string);
        self.attach(
            vec![Source::Url {
                url: url.to_string(),
                source_key,
            }],
            slot,
            Some(success.into()),
            cx,
        );
    }

    // --- Reproduce --------------------------------------------------------------

    /// Restores a clip's settings (size as Custom, one clip) and its input
    /// images. `missing` is said when the row has no settings to restore.
    pub fn reproduce(
        &mut self,
        row: Arc<ApiGeneration>,
        missing: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let sheet = if let Some(settings) = row
            .ltx_settings
            .as_ref()
            .and_then(|raw| rules::normalize_ltx(cx, raw))
        {
            let sheet = settings.mode == LtxMode::Sheet;
            self.set_family(Family::Ltx, window, cx);
            self.update_ltx(cx, |form| {
                form.short_edge = settings.width.min(settings.height);
                form.settings = settings;
                form.aspect = CUSTOM.into();
                form.count = 1;
            });
            self.sync_ltx_controls(window, cx);
            sheet
        } else if let Some(settings) = row
            .h3_settings
            .as_ref()
            .and_then(|raw| rules::normalize_h3(cx, raw))
        {
            self.set_family(Family::H3, window, cx);
            self.update_h3(cx, |form| {
                form.short_edge = settings.width.min(settings.height);
                form.settings = settings;
                form.aspect = CUSTOM.into();
                form.count = 1;
            });
            self.sync_h3_controls(window, cx);
            false
        } else {
            self.toast(Notification::error(missing), cx);
            return;
        };
        self.restore_inputs(
            row.reference_b2_keys.clone().unwrap_or_default(),
            row.h3_input_roles.clone().unwrap_or_default(),
            sheet,
            window,
            cx,
        );
        self.toast(Notification::success("Settings restored"), cx);
    }

    /// The row's input images, downloaded together but set at once in the
    /// stored order — appended as each finished, a small second reference
    /// would overtake the first and change what `@image1` means. An LTX sheet
    /// clip's reference is its sheet. Images attached while the restore runs
    /// are newer: they stay, after the restored ones.
    fn restore_inputs(
        &mut self,
        keys: Vec<String>,
        roles: Vec<String>,
        sheet: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A new set: images still being prepared for the old one are dropped.
        self.inputs_revision += 1;
        let revision = self.inputs_revision;
        for image in self.inputs.drain(..).chain(self.sheet.take()) {
            cx.drop_image(image.preview, Some(window));
        }
        self.refresh_derived(cx);
        cx.notify();
        if keys.is_empty() {
            return;
        }
        let Some(limits) = self.fal_limits.clone() else {
            return;
        };
        let slots: Vec<Slot> = (0..keys.len())
            .map(|ix| match roles.get(ix).map(String::as_str) {
                Some("first") => Slot::First,
                Some("last") => Slot::Last,
                _ if sheet => Slot::Sheet,
                _ => Slot::Reference,
            })
            .collect();
        let urls = Media::urls(cx).clone();
        let sources: Vec<Source> = keys
            .iter()
            .map(|key| Source::Url {
                url: urls.original(key),
                source_key: Some(key.clone()),
            })
            .collect();
        self.preparing.extend(slots.iter().copied());
        let fetcher = Media::fetcher(cx);
        let wanted = keys.len();
        cx.spawn(async move |this, cx| {
            let results = prepare_all(sources, fetcher, limits, cx).await;
            let _ = this.update(cx, |this, cx| {
                this.finish_preparing(&slots);
                if revision != this.inputs_revision {
                    cx.notify();
                    return;
                }
                let restored: Vec<(Slot, InputImage)> = results
                    .into_iter()
                    .zip(&slots)
                    .filter_map(|(result, slot)| {
                        result
                            .ok()
                            .map(|image| (*slot, image.into_input(slot.role())))
                    })
                    .collect();
                let complete = restored.len() == wanted;
                // What was attached meanwhile goes after (and, in a single
                // slot, over) what is restored.
                let since = std::mem::take(&mut this.inputs);
                let since_sheet = this.sheet.take();
                for (slot, image) in restored {
                    this.place(slot, vec![image], cx);
                }
                for image in since {
                    let slot = match image.role {
                        InputRole::First => Slot::First,
                        InputRole::Last => Slot::Last,
                        InputRole::Reference => Slot::Reference,
                    };
                    this.place(slot, vec![image], cx);
                }
                if let Some(image) = since_sheet {
                    this.place(Slot::Sheet, vec![image], cx);
                }
                if !complete {
                    this.toast(
                        Notification::error(
                            "Some input images could not be restored — check the @image tags",
                        ),
                        cx,
                    );
                }
            });
        })
        .detach();
    }

    // --- Pods and the catalogue -------------------------------------------------

    fn pod_list(&self, cx: &App) -> Option<Arc<Vec<RunpodBackend>>> {
        self.pods.read(cx).data().cloned()
    }

    fn ready_pods(&self, cx: &App) -> Vec<RunpodBackend> {
        self.pod_list(cx)
            .map(|pods| {
                pods.iter()
                    .filter(|pod| pod.state == BackendState::Ready)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The pod picked in "Run on", while it is ready.
    fn pinned_pod(&self, cx: &App) -> Option<RunpodBackend> {
        let id = self.run_on.as_ref()?;
        self.ready_pods(cx).into_iter().find(|pod| &pod.id == id)
    }

    fn pods_changed(&mut self, cx: &mut Context<Self>) {
        // A picked pod that went away falls back to Auto; one that is only
        // stopped or starting blocks the form until another is picked.
        if let (Some(id), Some(pods)) = (&self.run_on, self.pod_list(cx))
            && !pods.iter().any(|pod| &pod.id == id)
        {
            self.run_on = None;
        }
        self.refresh_catalog_key(cx);
        cx.notify();
    }

    fn set_run_on(&mut self, pod: Option<String>, cx: &mut Context<Self>) {
        if self.run_on != pod {
            self.run_on = pod;
            self.refresh_catalog_key(cx);
            cx.notify();
        }
    }

    /// Whether the tab is on screen. Opening it re-reads the lists.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active != active {
            self.active = active;
            if active {
                self.catalog_version += 1;
            }
            self.refresh_catalog_key(cx);
        }
    }

    fn reread_catalog(&mut self, cx: &mut Context<Self>) {
        self.catalog_version += 1;
        self.refresh_catalog_key(cx);
    }

    fn refresh_catalog_key(&mut self, cx: &mut Context<Self>) {
        let ready = !self.ready_pods(cx).is_empty();
        let key = (self.active && ready).then(|| CatalogKey {
            backend_id: self.pinned_pod(cx).map(|pod| pod.id),
            version: self.catalog_version,
        });
        self.catalog_poller.set_key(key);
    }

    fn poll_catalog(&mut self, key: CatalogKey, cx: &mut Context<Self>) -> Task<Duration> {
        let args = VideoCatalogArgs {
            backend_id: key.backend_id.clone(),
        };
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(pod_catalog::VIDEO_CATALOG, &args, cx)
        });
        let window = self.window;
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = window.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    // An answer overtaken by a newer read is dropped.
                    if this.catalog_poller.is_current(&key) {
                        this.apply_catalog(result, key.backend_id.clone(), window, cx);
                    }
                });
            });
            CATALOG_POLL
        })
    }

    /// An identical answer keeps the lists as they are; a failed read keeps
    /// the last good ones — the first failure in a row silently, from the
    /// second with the error beside them. The server reports a pod it cannot
    /// reach as lists with an error and nothing in them: that is a failed
    /// read too, not an empty pod.
    fn apply_catalog(
        &mut self,
        result: Result<VideoPodCatalog, CallError>,
        origin: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let result = match result {
            Ok(catalog) => match catalog.error.clone() {
                Some(error) => Err(error),
                None => Ok(catalog),
            },
            Err(error) => Err(error.user_message().to_string()),
        };
        let origin_before = self.catalog_origin.clone();
        let next = match result {
            Ok(catalog) => {
                self.catalog_failures = 0;
                self.catalog_origin = Some(origin);
                catalog
            }
            Err(error) => {
                self.catalog_failures += 1;
                match &self.catalog {
                    Some(previous) if previous.error.is_none() && self.catalog_failures < 2 => {
                        return;
                    }
                    Some(previous) if previous.error.as_deref() == Some(error.as_str()) => return,
                    Some(previous) => VideoPodCatalog {
                        error: Some(error),
                        ..previous.clone()
                    },
                    None => VideoPodCatalog {
                        error: Some(error),
                        ..VideoPodCatalog::default()
                    },
                }
            }
        };
        if self.catalog.as_ref() == Some(&next) {
            // The same lists; where they were read for may still be news.
            if self.catalog_origin != origin_before {
                cx.notify();
            }
            return;
        }
        let rules = self.rules.clone();
        let previous = self.catalog.take();
        let ltx = next.ltx.clone().unwrap_or_default();
        let previous_ltx = previous.as_ref().and_then(|catalog| catalog.ltx.as_ref());
        // Only a picker whose list changed is given it again: that resets a
        // search typed into its open dropdown.
        let h3_items = (previous.as_ref().map(|catalog| &catalog.checkpoints)
            != Some(&next.checkpoints))
        .then(|| {
            next.checkpoints
                .iter()
                .map(|name| ModelChoice {
                    value: name.clone().into(),
                    title: name
                        .strip_suffix(".safetensors")
                        .unwrap_or(name)
                        .to_string()
                        .into(),
                    note: form::h3_checkpoint_note(name, &rules).into(),
                })
                .collect::<Vec<_>>()
        });
        let ltx_items = (previous_ltx.map(|catalog| &catalog.checkpoints)
            != Some(&ltx.checkpoints))
        .then(|| {
            ltx.checkpoints
                .iter()
                .map(|name| {
                    let known = rules.ltx_known.get(name);
                    ModelChoice {
                        value: name.clone().into(),
                        title: known.map(|known| known.label.clone()).unwrap_or_else(|| {
                            name.strip_suffix(".safetensors")
                                .unwrap_or(name)
                                .to_string()
                                .into()
                        }),
                        note: known
                            .map(|known| known.note.clone())
                            .unwrap_or_else(|| "Custom LTX 2.3 checkpoint".into()),
                    }
                })
                .collect::<Vec<_>>()
        });
        let h3_value = self.h3.settings.checkpoint.clone();
        let ltx_value = self.ltx.settings.checkpoint.clone();
        show_choices(
            &self.h3_checkpoint,
            h3_items,
            next.checkpoints.contains(&h3_value).then_some(h3_value),
            window,
            cx,
        );
        show_choices(
            &self.ltx_checkpoint,
            ltx_items,
            ltx.checkpoints.contains(&ltx_value).then_some(ltx_value),
            window,
            cx,
        );
        self.h3_loras
            .update(cx, |stack, cx| stack.set_available(&next.loras, window, cx));
        self.ltx_loras
            .update(cx, |stack, cx| stack.set_available(&ltx.loras, window, cx));
        self.catalog = Some(next);
        // The LTX advice reads the pod's LoRAs.
        self.refresh_derived(cx);
        cx.notify();
    }

    /// Whether the lists on screen were read for where clips go now. After a
    /// change of "Run on" they belong to the old target until the new one
    /// answers.
    fn catalog_matches_target(&self, cx: &App) -> bool {
        let target = self.pinned_pod(cx).map(|pod| pod.id);
        self.catalog_origin
            .as_ref()
            .is_none_or(|origin| *origin == target)
    }

    fn ltx_catalog(&self) -> Option<&LtxCatalog> {
        self.catalog
            .as_ref()
            .and_then(|catalog| catalog.ltx.as_ref())
    }

    // --- Generate -------------------------------------------------------------

    /// Why the open form cannot run, first problem first.
    fn problems(&self, cx: &App) -> Vec<SharedString> {
        let ready = !self.ready_pods(cx).is_empty();
        let mut problems = Vec::new();
        if self.run_on.is_some() && self.pinned_pod(cx).is_none() && ready {
            problems.push(
                "The pod picked in \u{201c}Run on\u{201d} is not ready — pick Auto or another pod"
                    .into(),
            );
        }
        if ready && !self.catalog_matches_target(cx) {
            let failed = self
                .catalog
                .as_ref()
                .is_some_and(|catalog| catalog.error.is_some());
            problems.push(if failed {
                "Could not read the models on the pod this goes to".into()
            } else {
                "Reading the models on the pod this goes to…".into()
            });
        }
        let inputs = self.input_counts();
        problems.extend(match self.family {
            Family::H3 => form::h3_problems(
                &self.h3.settings,
                ready,
                &inputs,
                self.derived.tag_problem.as_deref(),
            ),
            Family::Ltx => form::ltx_problems(
                &self.ltx.settings,
                ready,
                self.ltx_catalog(),
                &inputs,
                self.sheet().is_some(),
                &self.rules,
            ),
        });
        problems
    }

    /// Takes in what is typed into the number, seed and LoRA strength fields
    /// but not committed yet, clamped as leaving the field would. Those fields
    /// commit on Blur or Enter; Cmd+Enter inside one submits before either.
    fn commit_drafts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for num in NUMS {
            let spec = num_spec(num, &self.h3.settings, &self.rules);
            let typed = parse_number(&self.numbers[&num].read(cx).value());
            self.set_number(num, spec.clamp(typed.unwrap_or(spec.min)), cx);
            self.sync_number(num, window, cx);
        }
        for family in [Family::H3, Family::Ltx] {
            let state = match family {
                Family::H3 => &self.h3_seed,
                Family::Ltx => &self.ltx_seed,
            };
            let text = state.read(cx).value();
            let seed = if text.trim().is_empty() {
                Some(-1.0)
            } else {
                parse_number(&text).map(|seed| seed.round().max(0.0))
            };
            if let Some(seed) = seed {
                self.set_seed(family, seed, cx);
            }
            self.sync_seed(family, window, cx);
        }
        if let Some(loras) = self
            .h3_loras
            .update(cx, |stack, cx| stack.commit_drafts(window, cx))
        {
            self.update_h3(cx, |form| form.settings.loras = loras);
        }
        if let Some(loras) = self
            .ltx_loras
            .update(cx, |stack, cx| stack.commit_drafts(window, cx))
        {
            self.update_ltx(cx, |form| form.settings.loras = loras);
        }
    }

    /// Uploads the open mode's images, then queues the clips. Every step has a
    /// deadline (mutations 30 s, uploads 120 s), so the button always recovers.
    fn submit(&mut self, _: &Submit, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitting.is_some() || !self.preparing.is_empty() {
            return;
        }
        self.commit_drafts(window, cx);
        if !self.problems(cx).is_empty() {
            return;
        }
        let images = self.visible_inputs();
        let backend_id = self.pinned_pod(cx).map(|pod| pod.id);
        let job = match self.family {
            Family::H3 => Job::H3(self.h3.settings.clone(), self.h3.count),
            Family::Ltx => Job::Ltx(self.ltx.settings.clone(), self.ltx.count),
        };
        self.submitting = Some(if images.is_empty() {
            "Queuing on the video pod…".into()
        } else {
            match images.len() {
                1 => "Uploading the image…".into(),
                count => format!("Uploading {count} images…").into(),
            }
        });
        cx.notify();

        cx.spawn(async move |this, cx| {
            let set_status = |text: String, cx: &mut AsyncApp| {
                let _ = this.update(cx, |this, cx| {
                    this.submitting = Some(text.into());
                    cx.notify();
                });
            };
            let outcome: Result<u32, String> = async {
                // Every upload URL at once, then every upload at once: one
                // round trip of each however many frames go.
                let url_requests: Vec<_> = cx.update(|cx| {
                    images
                        .iter()
                        .map(|_| {
                            Backend::global(cx).update(cx, |backend, cx| {
                                backend.mutate(grok_generations::UPLOAD_URL, &NoArgs {}, cx)
                            })
                        })
                        .collect()
                });
                let urls = futures::future::join_all(url_requests)
                    .await
                    .into_iter()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.user_message().to_string())?;
                let uploads: Vec<_> = cx.update(|cx| {
                    urls.into_iter()
                        .zip(&images)
                        .map(|(url, image)| {
                            let bytes = image.jpeg.as_ref().clone();
                            artsnack_runtime::spawn_result(cx, async move {
                                upload::upload_bytes(&url, bytes, "image/jpeg").await
                            })
                        })
                        .collect()
                });
                let storage_ids = futures::future::join_all(uploads)
                    .await
                    .into_iter()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("Failed to upload an input image: {error}"))?;
                let mut uploaded = Vec::with_capacity(images.len());
                for (image, storage_id) in images.iter().zip(storage_ids) {
                    // Only an output's key links the clip back to it.
                    let source_key = match image.source_key.clone() {
                        Some(key) => cx
                            .update(|cx| {
                                artsnack_rules::composer(cx).call::<_, Option<String>>(
                                    "composer.referenceSourceKey",
                                    &(key,),
                                )
                            })
                            .await
                            .unwrap_or(None),
                        None => None,
                    };
                    uploaded.push(VideoInput {
                        storage_id,
                        role: image.role,
                        source_key,
                    });
                }
                set_status("Queuing on the video pod…".into(), cx);
                let count = match job {
                    Job::H3(settings, count) => {
                        let args = StartArgs {
                            settings,
                            inputs: uploaded,
                            count: count as f64,
                            backend_id,
                        };
                        cx.update(|cx| {
                            Backend::global(cx).update(cx, |backend, cx| {
                                backend.mutate(comfy_video_jobs::START, &args, cx)
                            })
                        })
                        .await
                        .map_err(|error| error.user_message().to_string())?;
                        count
                    }
                    Job::Ltx(settings, count) => {
                        let args = StartArgs {
                            settings,
                            inputs: uploaded,
                            count: count as f64,
                            backend_id,
                        };
                        cx.update(|cx| {
                            Backend::global(cx).update(cx, |backend, cx| {
                                backend.mutate(comfy_video_jobs::START_LTX, &args, cx)
                            })
                        })
                        .await
                        .map_err(|error| error.user_message().to_string())?;
                        count
                    }
                };
                Ok(count)
            }
            .await;

            let _ = this.update(cx, |this, cx| {
                this.submitting = None;
                match outcome {
                    Ok(1) => this.toast(Notification::success("Clip queued"), cx),
                    Ok(count) => {
                        this.toast(Notification::success(format!("{count} clips queued")), cx)
                    }
                    Err(message) => this.toast(Notification::error(message), cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- Rendering --------------------------------------------------------------

    fn render_family(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let cell = |id: &'static str, label: &'static str, note: &'static str, selected: bool| {
            Button::new(id)
                .flex_1()
                .h_auto()
                .py_1()
                .selected(selected)
                .child(
                    v_flex()
                        .items_center()
                        .min_w_0()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(label))
                        .child(div().text_xs().text_color(muted).truncate().child(note)),
                )
        };
        ButtonGroup::new("video-family")
            .outline()
            .w_full()
            .child(cell(
                "family-h3",
                "MiniMax H3",
                "Sound + references, up to 15 s",
                self.family == Family::H3,
            ))
            .child(cell(
                "family-ltx",
                "LTX 2.3",
                "Up to 20 s, 1080p",
                self.family == Family::Ltx,
            ))
            .on_click(cx.listener(|this, selected: &Vec<usize>, window, cx| {
                let family = match selected.first() {
                    Some(1) => Family::Ltx,
                    _ => Family::H3,
                };
                this.set_family(family, window, cx);
            }))
    }

    /// "Run on": only when there is a choice, or the picked pod went down.
    fn render_run_on(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let ready = self.ready_pods(cx);
        let pinned = self.pinned_pod(cx);
        let unavailable = self.run_on.is_some() && pinned.is_none();
        if ready.len() <= 1 && !(unavailable && !ready.is_empty()) {
            return None;
        }
        let hint_text = if unavailable {
            "The pod picked here is not ready any more — choose Auto or a running pod."
        } else if pinned.is_some() {
            "Every clip from this form goes to this pod."
        } else {
            "Each clip goes to the least busy pod that has every model it needs."
        };
        Some(
            Field::new("run-on", "Run on")
                .hint(Some(hint_text))
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_1()
                        .child(
                            choice("run-on-auto", "Auto", self.run_on.is_none())
                                .on_click(cx.listener(|this, _, _, cx| this.set_run_on(None, cx))),
                        )
                        .children(ready.iter().map(|pod| {
                            let id = pod.id.clone();
                            choice(
                                SharedString::from(format!("run-on-{id}")),
                                video_pod_label(pod),
                                self.run_on.as_ref() == Some(&pod.id),
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| this.set_run_on(Some(id.clone()), cx),
                            ))
                        })),
                )
                .into_any_element(),
        )
    }

    /// B300s on the pods a clip may land on (the picked one, else any ready).
    fn weak_int8(&self, cx: &App) -> bool {
        match self.pinned_pod(cx) {
            Some(pod) => is_b300(&pod),
            None => self.ready_pods(cx).iter().any(is_b300),
        }
    }

    /// The prompt's label row (with `extra` before Enhance and the library)
    /// and the field, which offers `@image` tags in H3's Reference mode.
    fn render_prompt(&self, extra: Option<AnyElement>) -> impl IntoElement {
        v_flex()
            .gap_1p5()
            .child(
                h_flex()
                    .min_h_7()
                    .justify_between()
                    .gap_2()
                    .child(section_title("Prompt"))
                    .child(
                        h_flex()
                            .gap_1()
                            .children(extra)
                            .child(self.enhancer.clone())
                            .child(self.library.clone()),
                    ),
            )
            .child(self.mentions.clone())
    }

    /// Aspect presets and Custom; a short edge per preset, or the typed size.
    fn render_size(&self, family: Family, cx: &mut Context<Self>) -> impl IntoElement {
        let (aspect, short_edge, edges, width, height, hint_text) = match family {
            Family::H3 => (
                self.h3.aspect.clone(),
                self.h3.short_edge,
                &self.rules.h3_short_edges,
                Num::H3Width,
                Num::H3Height,
                format!(
                    "{}×{} · H3\u{2019}s native ceiling is 768×1344; larger is slower and untrained.",
                    form::plain(self.h3.settings.width),
                    form::plain(self.h3.settings.height)
                ),
            ),
            Family::Ltx => (
                self.ltx.aspect.clone(),
                self.ltx.short_edge,
                &self.rules.ltx_short_edges,
                Num::LtxWidth,
                Num::LtxHeight,
                format!(
                    "{}×{} · up to 1920 on the long edge.",
                    form::plain(self.ltx.settings.width),
                    form::plain(self.ltx.settings.height)
                ),
            ),
        };
        let prefix = match family {
            Family::H3 => "h3",
            Family::Ltx => "ltx",
        };
        let custom = aspect.as_ref() == CUSTOM;
        let presets = h_flex()
            .flex_wrap()
            .gap_1()
            .children(self.rules.aspects.iter().map(|option| {
                let option = option.clone();
                choice(
                    SharedString::from(format!("{prefix}-aspect-{option}")),
                    option.clone(),
                    aspect == option,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.set_preset(family, option.clone(), short_edge, window, cx)
                }))
            }))
            .child(
                choice(
                    SharedString::from(format!("{prefix}-aspect-custom")),
                    "Custom",
                    custom,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.set_preset(family, CUSTOM.into(), short_edge, window, cx)
                })),
            );
        let detail = if custom {
            h_flex()
                .gap_2()
                .child(
                    div().flex_1().child(
                        NumberInput::new(&self.numbers[&width])
                            .small()
                            .accessibility_label("Width"),
                    ),
                )
                .child(hint("×", cx))
                .child(
                    div().flex_1().child(
                        NumberInput::new(&self.numbers[&height])
                            .small()
                            .accessibility_label("Height"),
                    ),
                )
                .into_any_element()
        } else {
            h_flex()
                .flex_wrap()
                .gap_1()
                .children(edges.iter().map(|edge| {
                    let edge = *edge;
                    let aspect = aspect.clone();
                    choice(
                        SharedString::from(format!("{prefix}-edge-{edge}")),
                        format!("{}p", form::plain(edge)),
                        short_edge == edge,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.set_preset(family, aspect.clone(), edge, window, cx)
                    }))
                }))
                .into_any_element()
        };
        Field::new(SharedString::from(format!("{prefix}-size")), "Size")
            .hint(Some(hint_text))
            .child(presets)
            .child(detail)
    }

    /// "Quality and speed" with what the settings are and the way back to
    /// the recommended ones.
    fn render_quality_header(
        &self,
        id: &'static str,
        status: &'static str,
        recommended: bool,
        tooltip: &'static str,
        reset: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        h_flex()
            .justify_between()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(cx.theme().border)
            .child(
                v_flex()
                    .min_w_0()
                    .child(section_title("Quality and speed"))
                    .child(hint(status, cx)),
            )
            .child(
                Button::new(id)
                    .outline()
                    .small()
                    .icon(IconName::RotateCcw)
                    .label("Recommended settings")
                    .disabled(recommended)
                    .tooltip(tooltip)
                    .on_click(cx.listener(move |this, _, window, cx| reset(this, window, cx))),
            )
    }

    /// Seed (blank is random) and how many clips one click queues.
    fn render_seed_and_clips(&self, family: Family, cx: &mut Context<Self>) -> impl IntoElement {
        let (state, seed, count, prefix) = match family {
            Family::H3 => (&self.h3_seed, self.h3.settings.seed, self.h3.count, "h3"),
            Family::Ltx => (
                &self.ltx_seed,
                self.ltx.settings.seed,
                self.ltx.count,
                "ltx",
            ),
        };
        h_flex()
            .items_start()
            .gap_3()
            .child(
                div().flex_1().min_w_0().child(
                    Field::new(SharedString::from(format!("{prefix}-seed")), "Seed")
                        .hint((seed < 0.0).then_some("Random each time"))
                        .child(
                            h_flex()
                                .gap_1()
                                .child(
                                    div()
                                        .flex_1()
                                        .child(Input::new(state).small().aria_label("Seed")),
                                )
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "{prefix}-random-seed"
                                    )))
                                    .outline()
                                    .small()
                                    .icon(IconName::Shuffle)
                                    .accessibility_label("Random seed")
                                    .tooltip("Random seed")
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.random_seed(family, window, cx)
                                    })),
                                ),
                        ),
                ),
            )
            .child(
                div().flex_1().min_w_0().child(
                    Field::new(SharedString::from(format!("{prefix}-clips")), "Clips").child(
                        ButtonGroup::new(SharedString::from(format!("{prefix}-count")))
                            .outline()
                            .small()
                            .w_full()
                            .children((1..=MAX_CLIPS).map(|option| {
                                Button::new(SharedString::from(format!("{prefix}-count-{option}")))
                                    .flex_1()
                                    .label(option.to_string())
                                    .selected(count == option)
                            }))
                            .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                                if let Some(ix) = selected.first() {
                                    this.set_count(*ix as u32 + 1, cx);
                                }
                            })),
                    ),
                ),
            )
    }

    fn render_generate(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let problems = self.problems(cx);
        let busy = self.submitting.is_some();
        let disabled = busy || !problems.is_empty() || !self.preparing.is_empty();
        let label = self
            .submitting
            .clone()
            .unwrap_or_else(|| "Generate video".into());
        v_flex()
            .gap_1()
            .p_4()
            .border_t_1()
            .border_color(cx.theme().border)
            .child(
                Button::new("video-generate")
                    .primary()
                    .large()
                    .w_full()
                    .icon(IconName::Video)
                    .label(label)
                    .loading(busy)
                    .disabled(disabled)
                    .tooltip_with_action("Generate video", &Submit, Some(CONTEXT))
                    .on_click(cx.listener(|this, _, window, cx| this.submit(&Submit, window, cx))),
            )
            .when_some(problems.into_iter().next(), |this, problem| {
                this.child(
                    div()
                        .text_xs()
                        .text_center()
                        .text_color(cx.theme().muted_foreground)
                        .child(problem),
                )
            })
    }
}

/// Downloads (on the network runtime) and prepares (on the background
/// executor) images, [`PREPARE_CONCURRENCY`] at a time, answering in the
/// order given.
async fn prepare_all(
    sources: Vec<Source>,
    fetcher: Arc<Fetcher>,
    limits: upload::ProfileLimits,
    cx: &AsyncApp,
) -> Vec<anyhow::Result<Prepared>> {
    let jobs = sources.into_iter().map(|source| {
        let (cx, fetcher, limits) = (cx.clone(), fetcher.clone(), limits.clone());
        async move {
            let (bytes, source_key) = match source {
                Source::Url { url, source_key } => {
                    let download = artsnack_runtime::spawn_result(&cx, async move {
                        fetcher.image_bytes(&url).await
                    });
                    (download.await, source_key)
                }
                Source::File(path) => (
                    cx.background_spawn(async move { Ok(std::fs::read(path)?) })
                        .await,
                    None,
                ),
                Source::Pasted(pasted) => (
                    cx.background_spawn(async move { inputs::read_pasted(pasted) })
                        .await,
                    None,
                ),
            };
            let bytes = bytes?;
            cx.background_spawn(async move { inputs::prepare(&bytes, &limits, source_key) })
                .await
        }
    });
    futures::stream::iter(jobs)
        .buffered(PREPARE_CONCURRENCY)
        .collect()
        .await
}

/// Gives a model picker a new list (when it changed) and shows `value` as
/// picked — unless it already is, or the list does not have it: setting it
/// again would clear a search typed into the open dropdown.
fn show_choices(
    select: &Entity<ModelSelect>,
    items: Option<Vec<ModelChoice>>,
    value: Option<String>,
    window: &mut Window,
    cx: &mut App,
) {
    select.update(cx, |select, cx| {
        if let Some(items) = items {
            select.set_items(SearchableVec::new(items), window, cx);
        }
        if let Some(value) = value.map(SharedString::from)
            && select.selected_value() != Some(&value)
        {
            select.set_selected_value(&value, window, cx);
        }
    });
}

/// A submit's settings, taken when the button was pressed.
enum Job {
    H3(H3Settings, u32),
    Ltx(LtxSettings, u32),
}

fn format_seed(seed: f64) -> String {
    if seed < 0.0 {
        String::new()
    } else {
        format!("{}", seed as i64)
    }
}

impl Focusable for VideoComposer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for VideoComposer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body: Vec<AnyElement> = match self.family {
            Family::H3 => self.render_h3(window, cx),
            Family::Ltx => self.render_ltx(window, cx),
        };
        v_flex()
            .id("video-composer")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::submit))
            .capture_action(cx.listener(Self::paste))
            .size_full()
            .child(
                v_flex()
                    .id("video-form")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_4()
                    .gap_4()
                    .child(self.render_family(cx))
                    .children(self.render_run_on(cx))
                    .children(body),
            )
            .child(self.render_generate(cx))
    }
}
