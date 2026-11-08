//! The self-hosted image form (the left column of the Self-hosted tab).
//!
//! The model lists come from Convex's `podCatalog.catalog` in one round trip —
//! what the iOS app uses — so the native app never needs the web's cookie-
//! authenticated `/api/models` and `/api/loras` routes. The last lists stay on
//! screen while a refresh is out, and only the newest refresh's answer is
//! applied: a slow answer for a pod that has since been replaced is dropped.
//!
//! Seed, the custom size and the number fields hold what is typed until Enter
//! or leaving the field; Generate (and Cmd+Enter, which reaches the form
//! before the field sees either) takes them in first — see
//! [`SelfHostedComposer::commit_drafts`].

use artsnack_backend::{
    Backend, NoArgs,
    api::{
        pod_catalog::{self, PodCatalog},
        pod_submit::{self, FormState, GenerateArgs, LoraSlot},
    },
};
use artsnack_settings::Preferences;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        label::Label,
        notification::Notification,
        searchable_list::SearchableVec,
        select::{Select, SelectEvent, SelectState},
        slider::{Slider, SliderEvent, SliderState},
        switch::Switch,
        tag::Tag,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    rems,
};
use serde_json::Value;

use crate::{
    controls::{NumberChanged, NumberField, NumberSpec},
    form::{self, BATCH_SIZES, LORA_SLOTS, SAVED_FORM},
    image_size::{self, Axis, ImageSize, PRESETS},
};

actions!(self_hosted, [Submit]);

const CONTEXT: &str = "SelfHostedComposer";

pub fn init(cx: &mut gpui_kit::App) {
    cx.bind_keys([
        KeyBinding::new("cmd-enter", Submit, Some(CONTEXT)),
        KeyBinding::new("cmd-enter", Submit, Some(&artsnack_ui::field_in(CONTEXT))),
    ]);
}

type NameSelect = SelectState<SearchableVec<SharedString>>;

/// Raised when a job was accepted, so the results column can scroll to it.
#[derive(Clone, Debug)]
pub struct Started;

/// Which form this is: the Generate tab's, or Enhance's Img2Img fields (no
/// size, batch or Generate button; Enhance supplies its own).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComposerKind {
    Generate,
    Img2Img,
}

struct LoraSlotControls {
    select: Entity<NameSelect>,
    strength_model: Entity<NumberField>,
    strength_clip: Entity<NumberField>,
}

pub struct SelfHostedComposer {
    kind: ComposerKind,
    focus_handle: FocusHandle,
    form: FormState,
    catalog: Option<PodCatalog>,
    catalog_loading: bool,
    /// The refresh in flight; a newer one replaces (and so drops) it.
    _catalog_refresh: Option<Task<()>>,
    /// Counts refreshes, so an answer is applied only if it is the newest.
    catalog_request: u64,
    checkpoint: Entity<NameSelect>,
    sampler: Entity<NameSelect>,
    scheduler: Entity<NameSelect>,
    prompt: Entity<TextareaState>,
    /// Save / Saved beside the prompt (the Generate form only).
    library: Option<Entity<artsnack_prompts::PromptLibrary>>,
    negative_prompt: Entity<TextareaState>,
    seed: Entity<InputState>,
    steps: Entity<NumberField>,
    cfg: Entity<NumberField>,
    denoise: Entity<NumberField>,
    lora_slots: Vec<LoraSlotControls>,
    loras_open: bool,
    advanced_open: bool,
    size_custom_open: bool,
    size_locked: bool,
    /// Which way a square image "faces", so Portrait stays pressed on 1:1.
    square_portrait: bool,
    size_slider: Entity<SliderState>,
    size_stops: Vec<ImageSize>,
    width_input: Entity<InputState>,
    height_input: Entity<InputState>,
    submitting: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<Started> for SelfHostedComposer {}

const STEPS: NumberSpec = NumberSpec {
    min: 1.0,
    max: 100.0,
    step: 1.0,
    decimals: 0,
    fallback: 20.0,
};
const CFG: NumberSpec = NumberSpec {
    min: 1.0,
    max: 20.0,
    step: 0.5,
    decimals: 1,
    fallback: 7.0,
};
const DENOISE: NumberSpec = NumberSpec {
    min: 0.0,
    max: 1.0,
    step: 0.01,
    decimals: 2,
    fallback: 1.0,
};
/// Img2Img's denoise, as the Enhance page bounds it.
const IMG2IMG_DENOISE: NumberSpec = NumberSpec {
    min: 0.1,
    max: 1.0,
    step: 0.05,
    decimals: 2,
    fallback: 0.6,
};
const LORA_STRENGTH: NumberSpec = NumberSpec {
    min: -10.0,
    max: 10.0,
    step: 0.1,
    decimals: 2,
    fallback: 1.0,
};

impl SelfHostedComposer {
    pub fn new(kind: ComposerKind, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let form = match kind {
            ComposerKind::Generate => Preferences::get(cx, &SAVED_FORM),
            ComposerKind::Img2Img => Preferences::get(cx, &form::SAVED_IMG2IMG_FORM),
        };
        let mut subscriptions = Vec::new();

        let select =
            |placeholder_items: Vec<SharedString>, window: &mut Window, cx: &mut Context<Self>| {
                cx.new(|cx| {
                    SelectState::new(SearchableVec::new(placeholder_items), None, window, cx)
                        .searchable(true)
                })
            };
        let checkpoint = select(Vec::new(), window, cx);
        let sampler = select(Vec::new(), window, cx);
        let scheduler = select(Vec::new(), window, cx);
        subscriptions.push(cx.subscribe_in(
            &checkpoint,
            window,
            |this, _, event: &SelectEvent<SearchableVec<SharedString>>, _, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                this.update_form(cx, |form| form.checkpoint = value.to_string());
            },
        ));
        subscriptions.push(cx.subscribe_in(
            &sampler,
            window,
            |this, _, event: &SelectEvent<SearchableVec<SharedString>>, _, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                this.update_form(cx, |form| form.sampler = value.to_string());
            },
        ));
        subscriptions.push(cx.subscribe_in(
            &scheduler,
            window,
            |this, _, event: &SelectEvent<SearchableVec<SharedString>>, _, cx| {
                let SelectEvent::Confirm(Some(value)) = event else {
                    return;
                };
                this.update_form(cx, |form| form.scheduler = value.to_string());
            },
        ));

        let prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(4, 16)
                .placeholder("Describe what you want to see...")
                .default_value(form.prompt.clone())
        });
        let negative_prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(2, 10)
                .placeholder("What to avoid")
                .default_value(form.negative_prompt.clone())
        });
        subscriptions.push(
            cx.subscribe(&prompt, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.update_form(cx, |form| form.prompt = text);
                }
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &negative_prompt,
            window,
            |this, state, event, _, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.update_form(cx, |form| form.negative_prompt = text);
                }
            },
        ));

        let seed = cx.new(|cx| InputState::new(window, cx).default_value(format_seed(form.seed)));
        subscriptions.push(
            cx.subscribe_in(&seed, window, |this, state, event, window, cx| {
                if matches!(event, InputEvent::Blur | InputEvent::PressEnter { .. }) {
                    let seed = typed_seed(&state.read(cx).value());
                    this.set_seed(seed, window, cx);
                }
            }),
        );

        let number = |value: f64, spec: NumberSpec, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| NumberField::new(value, spec, window, cx))
        };
        let steps = number(form.steps, STEPS, window, cx);
        let cfg = number(form.cfg, CFG, window, cx);
        let denoise_spec = match kind {
            ComposerKind::Generate => DENOISE,
            ComposerKind::Img2Img => IMG2IMG_DENOISE,
        };
        let denoise = number(form.denoise, denoise_spec, window, cx);
        subscriptions.push(cx.subscribe(&steps, |this, _, NumberChanged(value), cx| {
            let value = *value;
            this.update_form(cx, |form| form.steps = value);
        }));
        subscriptions.push(cx.subscribe(&cfg, |this, _, NumberChanged(value), cx| {
            let value = *value;
            this.update_form(cx, |form| form.cfg = value);
        }));
        subscriptions.push(cx.subscribe(&denoise, |this, _, NumberChanged(value), cx| {
            let value = *value;
            this.update_form(cx, |form| form.denoise = value);
        }));

        let slots = form::lora_slots(&form);
        let mut lora_slots = Vec::with_capacity(LORA_SLOTS);
        for (ix, slot) in slots.iter().enumerate() {
            let select = select(Vec::new(), window, cx);
            subscriptions.push(cx.subscribe_in(
                &select,
                window,
                move |this, _, event: &SelectEvent<SearchableVec<SharedString>>, _, cx| {
                    let SelectEvent::Confirm(Some(value)) = event else {
                        return;
                    };
                    let value = value.to_string();
                    this.update_slot(ix, cx, |slot| slot.lora_name = value);
                },
            ));
            let strength =
                |value: f64, label: &'static str, window: &mut Window, cx: &mut Context<Self>| {
                    cx.new(|cx| NumberField::new(value, LORA_STRENGTH, window, cx).labeled(label))
                };
            let strength_model = strength(slot.strength_model, "Model Strength", window, cx);
            let strength_clip = strength(slot.strength_clip, "CLIP Strength", window, cx);
            subscriptions.push(cx.subscribe(
                &strength_model,
                move |this, _, NumberChanged(value), cx| {
                    let value = *value;
                    this.update_slot(ix, cx, |slot| slot.strength_model = value);
                },
            ));
            subscriptions.push(cx.subscribe(
                &strength_clip,
                move |this, _, NumberChanged(value), cx| {
                    let value = *value;
                    this.update_slot(ix, cx, |slot| slot.strength_clip = value);
                },
            ));
            lora_slots.push(LoraSlotControls {
                select,
                strength_model,
                strength_clip,
            });
        }

        let size = current_size(&form);
        let width_input =
            cx.new(|cx| InputState::new(window, cx).default_value(size.width.to_string()));
        let height_input =
            cx.new(|cx| InputState::new(window, cx).default_value(size.height.to_string()));
        for (input, axis) in [(&width_input, Axis::Width), (&height_input, Axis::Height)] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                move |this, state, event, window, cx| {
                    if matches!(event, InputEvent::Blur | InputEvent::PressEnter { .. }) {
                        let typed = state.read(cx).value().trim().parse::<f64>().ok();
                        this.commit_dimension(axis, typed, window, cx);
                    }
                },
            ));
        }

        let (size_slider, size_stops, slider_subscription) =
            Self::build_size_slider(size, size.height > size.width, window, cx);
        subscriptions.push(slider_subscription);

        // A model landed on a pod ("To pod"): re-read the lists.
        subscriptions.push(
            cx.observe_global_in::<artsnack_pods::PodCatalogVersion>(window, |this, window, cx| {
                this.refresh_catalog(window, cx)
            }),
        );

        let library = (kind == ComposerKind::Generate).then(|| {
            let read: artsnack_prompts::PromptReader = {
                let prompt = prompt.clone();
                std::rc::Rc::new(move |cx| prompt.read(cx).value().to_string())
            };
            let write: artsnack_prompts::PromptWriter = {
                let view = cx.entity().downgrade();
                std::rc::Rc::new(move |text, window, cx| {
                    let _ = view.update(cx, |this, cx| {
                        this.prompt
                            .update(cx, |state, cx| state.set_value(text.clone(), window, cx));
                        this.update_form(cx, |form| form.prompt = text);
                    });
                })
            };
            cx.new(|cx| artsnack_prompts::PromptLibrary::new(read, write, window, cx))
        });

        let mut this = Self {
            kind,
            focus_handle: cx.focus_handle(),
            form: form.clone(),
            catalog: None,
            catalog_loading: false,
            _catalog_refresh: None,
            catalog_request: 0,
            checkpoint,
            sampler,
            scheduler,
            prompt,
            library,
            negative_prompt,
            seed,
            steps,
            cfg,
            denoise,
            lora_slots,
            loras_open: false,
            advanced_open: false,
            size_custom_open: false,
            size_locked: true,
            square_portrait: false,
            size_slider,
            size_stops,
            width_input,
            height_input,
            submitting: false,
            _subscriptions: subscriptions,
        };
        this.refresh_catalog(window, cx);
        this
    }

    // --- Form state ---------------------------------------------------------

    fn update_form(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut FormState)) {
        change(&mut self.form);
        match self.kind {
            ComposerKind::Generate => Preferences::set(cx, &SAVED_FORM, self.form.clone()),
            ComposerKind::Img2Img => {
                Preferences::set(cx, &form::SAVED_IMG2IMG_FORM, self.form.clone())
            }
        }
        cx.notify();
    }

    fn update_slot(
        &mut self,
        ix: usize,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut LoraSlot),
    ) {
        let mut slots = form::lora_slots(&self.form);
        if let Some(slot) = slots.get_mut(ix) {
            change(slot);
        }
        self.update_form(cx, |form| form.loras = slots);
    }

    /// Loads the checkpoint, LoRA, sampler and scheduler lists from the pod.
    /// A refresh started meanwhile (the pod became ready, another took over,
    /// a model landed) supersedes this one, whose answer is then dropped.
    pub fn refresh_catalog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.catalog_loading = true;
        self.catalog_request += 1;
        let request_id = self.catalog_request;
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(pod_catalog::CATALOG, &NoArgs {}, cx)
        });
        let window_handle = window.window_handle();
        self._catalog_refresh = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = window_handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    if this.catalog_request != request_id {
                        return;
                    }
                    this.catalog_loading = false;
                    match result {
                        Ok(catalog) => this.apply_catalog(catalog, window, cx),
                        Err(error) => window.push_notification(
                            Notification::error(format!(
                                "Could not load models: {}",
                                error.user_message()
                            )),
                            cx,
                        ),
                    }
                    cx.notify();
                });
            });
        }));
    }

    fn apply_catalog(&mut self, catalog: PodCatalog, window: &mut Window, cx: &mut Context<Self>) {
        if self.catalog.as_ref() == Some(&catalog) {
            return;
        }
        // A pod with no checkpoints yet keeps the last good lists on screen.
        if catalog.checkpoints.is_empty() && self.catalog.is_some() {
            return;
        }
        let names = |items: &[String]| {
            items
                .iter()
                .cloned()
                .map(SharedString::from)
                .collect::<Vec<_>>()
        };

        // Auto-defaults, as the web form does: first checkpoint, sampler and
        // scheduler when the form has none.
        let mut form = self.form.clone();
        if form.checkpoint.is_empty() {
            form.checkpoint = catalog.checkpoints.first().cloned().unwrap_or_default();
        }
        if form.sampler.is_empty() {
            form.sampler = catalog.samplers.first().cloned().unwrap_or_default();
        }
        if form.scheduler.is_empty() {
            form.scheduler = catalog.schedulers.first().cloned().unwrap_or_default();
        }

        for (state, items, value) in [
            (
                &self.checkpoint,
                names(&catalog.checkpoints),
                form.checkpoint.clone(),
            ),
            (
                &self.sampler,
                names(&catalog.samplers),
                form.sampler.clone(),
            ),
            (
                &self.scheduler,
                names(&catalog.schedulers),
                form.scheduler.clone(),
            ),
        ] {
            state.update(cx, |state, cx| {
                state.set_items(SearchableVec::new(items), window, cx);
                state.set_selected_value(&SharedString::from(value), window, cx);
            });
        }
        let loras = names(&catalog.loras);
        for (slot, controls) in form::lora_slots(&form).iter().zip(&self.lora_slots) {
            let name = SharedString::from(slot.lora_name.clone());
            let loras = loras.clone();
            controls.select.update(cx, |state, cx| {
                state.set_items(SearchableVec::new(loras), window, cx);
                if !name.is_empty() {
                    state.set_selected_value(&name, window, cx);
                }
            });
        }
        self.catalog = Some(catalog);
        if form != self.form {
            self.update_form(cx, |current| *current = form);
        }
    }

    /// Restores a saved form (Reproduce from History, Gallery, Favorites).
    pub fn reproduce(&mut self, saved: &Value, window: &mut Window, cx: &mut Context<Self>) {
        self.merge_saved(saved, window, cx);
        window.push_notification(Notification::success("Settings restored"), cx);
    }

    /// Merges a saved form over this one without a notification (an image
    /// handed to Enhance brings its form along).
    pub fn merge_saved(&mut self, saved: &Value, window: &mut Window, cx: &mut Context<Self>) {
        let form = form::merge_saved(&self.form, saved);
        self.load_form(form, window, cx);
    }

    fn load_form(&mut self, form: FormState, window: &mut Window, cx: &mut Context<Self>) {
        self.prompt.update(cx, |input, cx| {
            input.set_value(form.prompt.clone(), window, cx)
        });
        self.negative_prompt.update(cx, |input, cx| {
            input.set_value(form.negative_prompt.clone(), window, cx)
        });
        self.seed.update(cx, |input, cx| {
            input.set_value(format_seed(form.seed), window, cx)
        });
        self.steps
            .update(cx, |field, cx| field.set_value(form.steps, window, cx));
        self.cfg
            .update(cx, |field, cx| field.set_value(form.cfg, window, cx));
        self.denoise
            .update(cx, |field, cx| field.set_value(form.denoise, window, cx));
        for (state, value) in [
            (&self.checkpoint, &form.checkpoint),
            (&self.sampler, &form.sampler),
            (&self.scheduler, &form.scheduler),
        ] {
            let value = SharedString::from(value.clone());
            state.update(cx, |state, cx| state.set_selected_value(&value, window, cx));
        }
        for (slot, controls) in form::lora_slots(&form).iter().zip(&self.lora_slots) {
            let name = SharedString::from(slot.lora_name.clone());
            controls
                .select
                .update(cx, |state, cx| state.set_selected_value(&name, window, cx));
            controls.strength_model.update(cx, |field, cx| {
                field.set_value(slot.strength_model, window, cx)
            });
            controls.strength_clip.update(cx, |field, cx| {
                field.set_value(slot.strength_clip, window, cx)
            });
        }
        if form.loras.iter().any(|slot| slot.enabled) {
            self.loras_open = true;
        }
        let size = current_size(&form);
        self.update_form(cx, |current| *current = form);
        self.sync_size_controls(size, window, cx);
    }

    fn set_seed(&mut self, seed: f64, window: &mut Window, cx: &mut Context<Self>) {
        let text = format_seed(seed);
        if self.seed.read(cx).value().as_ref() != text {
            self.seed
                .update(cx, |input, cx| input.set_value(text, window, cx));
        }
        self.update_form(cx, |form| form.seed = seed);
    }

    // --- Image size ---------------------------------------------------------

    fn build_size_slider(
        size: ImageSize,
        portrait: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<SliderState>, Vec<ImageSize>, Subscription) {
        let stops = image_size::slider_stops(size, portrait);
        let index = image_size::nearest_stop(&stops, size);
        let slider = cx.new(|_| {
            SliderState::new()
                .min(0.)
                .max(stops.len().saturating_sub(1).max(1) as f32)
                .step(1.)
                .default_value(index as f32)
        });
        let subscription = cx.subscribe_in(
            &slider,
            window,
            |this, _, event: &SliderEvent, window, cx| {
                let value = match event {
                    SliderEvent::Change(value) | SliderEvent::Release(value) => value.start(),
                };
                if let Some(size) = this.size_stops.get(value.round() as usize).copied() {
                    this.set_size(size, false, window, cx);
                }
            },
        );
        (slider, stops, subscription)
    }

    fn portrait(&self) -> bool {
        let size = current_size(&self.form);
        if size.width == size.height {
            self.square_portrait
        } else {
            size.height > size.width
        }
    }

    /// Sets the size; `rebuild_slider` when the ratio may have changed.
    fn set_size(
        &mut self,
        size: ImageSize,
        rebuild_slider: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.update_form(cx, |form| {
            form.width = size.width as f64;
            form.height = size.height as f64;
        });
        for (input, value) in [
            (&self.width_input, size.width),
            (&self.height_input, size.height),
        ] {
            let text = value.to_string();
            if input.read(cx).value().as_ref() != text {
                input.update(cx, |input, cx| input.set_value(text, window, cx));
            }
        }
        if rebuild_slider {
            self.sync_size_controls(size, window, cx);
        }
    }

    fn sync_size_controls(&mut self, size: ImageSize, window: &mut Window, cx: &mut Context<Self>) {
        let (slider, stops, subscription) =
            Self::build_size_slider(size, self.portrait(), window, cx);
        self.size_slider = slider;
        self.size_stops = stops;
        self._subscriptions.push(subscription);
        for (input, value) in [
            (&self.width_input, size.width),
            (&self.height_input, size.height),
        ] {
            input.update(cx, |input, cx| {
                input.set_value(value.to_string(), window, cx)
            });
        }
    }

    fn set_orientation(&mut self, portrait: bool, window: &mut Window, cx: &mut Context<Self>) {
        let size = current_size(&self.form);
        self.square_portrait = portrait;
        if size.width != size.height && portrait != (size.height > size.width) {
            self.set_size(
                ImageSize {
                    width: size.height,
                    height: size.width,
                },
                true,
                window,
                cx,
            );
        } else {
            cx.notify();
        }
    }

    fn commit_dimension(
        &mut self,
        axis: Axis,
        typed: Option<f64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let size = current_size(&self.form);
        let current = match axis {
            Axis::Width => size.width,
            Axis::Height => size.height,
        };
        let value = typed.map(image_size::snap).unwrap_or(current);
        let next = if self.size_locked {
            image_size::resize_locked(size, axis, value)
        } else {
            match axis {
                Axis::Width => ImageSize {
                    width: value,
                    ..size
                },
                Axis::Height => ImageSize {
                    height: value,
                    ..size
                },
            }
        };
        self.set_size(next, true, window, cx);
    }

    // --- Submit -------------------------------------------------------------

    /// Takes every value still being typed into the form, as Enter or leaving
    /// the field would: Seed, the custom size, Steps, CFG, Denoise and the LoRA
    /// strengths. Cmd+Enter runs the form's action without the field seeing
    /// either, and the value on screen must be the one sent.
    pub fn commit_drafts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let seed_text = self.seed.read(cx).value().trim().to_string();
        if seed_text != format_seed(self.form.seed) {
            self.set_seed(typed_seed(&seed_text), window, cx);
        }
        if self.kind == ComposerKind::Generate {
            for axis in [Axis::Width, Axis::Height] {
                let input = match axis {
                    Axis::Width => &self.width_input,
                    Axis::Height => &self.height_input,
                };
                let text = input.read(cx).value().trim().to_string();
                // Read again for each side: a locked width moves the height.
                let size = current_size(&self.form);
                let current = match axis {
                    Axis::Width => size.width,
                    Axis::Height => size.height,
                };
                if text != current.to_string() {
                    self.commit_dimension(axis, text.parse::<f64>().ok(), window, cx);
                }
            }
        }

        let steps = self.steps.update(cx, |field, cx| field.commit(window, cx));
        let cfg = self.cfg.update(cx, |field, cx| field.commit(window, cx));
        let denoise = self
            .denoise
            .update(cx, |field, cx| field.commit(window, cx));
        let mut slots = form::lora_slots(&self.form);
        let mut slots_changed = false;
        for (slot, controls) in slots.iter_mut().zip(&self.lora_slots) {
            let strength_model = controls
                .strength_model
                .update(cx, |field, cx| field.commit(window, cx));
            let strength_clip = controls
                .strength_clip
                .update(cx, |field, cx| field.commit(window, cx));
            if (strength_model, strength_clip) != (slot.strength_model, slot.strength_clip) {
                slot.strength_model = strength_model;
                slot.strength_clip = strength_clip;
                slots_changed = true;
            }
        }
        let numbers = (steps, cfg, denoise);
        if slots_changed || numbers != (self.form.steps, self.form.cfg, self.form.denoise) {
            self.update_form(cx, |form| {
                (form.steps, form.cfg, form.denoise) = numbers;
                if slots_changed {
                    form.loras = slots;
                }
            });
        }
    }

    fn submit(&mut self, _: &Submit, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitting {
            return;
        }
        self.commit_drafts(window, cx);
        if self.form.prompt.trim().is_empty() {
            window.push_notification(Notification::error("Please enter a prompt"), cx);
            return;
        }
        if self.form.checkpoint.is_empty() {
            window.push_notification(Notification::error("Choose a checkpoint first"), cx);
            return;
        }
        self.submitting = true;
        cx.notify();
        let args = GenerateArgs {
            form_state: form::submitted(&self.form),
            backend: "comfyui".into(),
        };
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(pod_submit::GENERATE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.submitting = false;
                if result.is_ok() {
                    cx.emit(Started);
                }
                cx.notify();
            });
            if let Err(error) = result {
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx)
                });
            }
        })
        .detach();
    }

    pub fn is_submitting(&self) -> bool {
        self.submitting
    }

    /// The form as it stands (Enhance reads its Img2Img fields from here).
    pub fn form(&self) -> &FormState {
        &self.form
    }

    // --- Rendering ----------------------------------------------------------

    fn section_label(text: &'static str) -> impl IntoElement {
        Label::new(text).text_sm().font_weight(FontWeight::MEDIUM)
    }

    /// The web's `LoraStack` inside its collapsible box: ten slot cards, an
    /// enabled one outlined in the primary colour with its model and the two
    /// strengths, a disabled one dimmed to a switch and the name it keeps.
    /// The count sits in the box's header, so it shows while closed too.
    fn render_loras(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let slots = form::lora_slots(&self.form);
        let active = slots.iter().filter(|slot| slot.enabled).count();
        let open = self.loras_open;
        v_flex()
            .p_4()
            .rounded(cx.theme().radius_lg)
            .border_1()
            .border_color(cx.theme().border)
            .child(
                h_flex()
                    .id("lora-header")
                    .justify_between()
                    .gap_2()
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.loras_open = !this.loras_open;
                        cx.notify();
                    }))
                    .child(Self::section_label("LoRA Stack"))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(Tag::secondary().child(format!("{active}/{LORA_SLOTS} Active")))
                            .child(
                                Icon::new(if open {
                                    IconName::ChevronDown
                                } else {
                                    IconName::ChevronRight
                                })
                                .small(),
                            ),
                    ),
            )
            .when(open, |this| {
                this.child(
                    v_flex().pt_4().gap_3().children(
                        slots
                            .iter()
                            .enumerate()
                            .map(|(ix, slot)| self.render_lora_slot(ix, slot, cx)),
                    ),
                )
            })
    }

    fn render_lora_slot(&self, ix: usize, slot: &LoraSlot, cx: &Context<Self>) -> impl IntoElement {
        let controls = &self.lora_slots[ix];
        let enabled = slot.enabled;
        let theme = cx.theme();
        // The web dims a disabled card with `opacity-60`. GPUI fades each
        // primitive on its own (a switch's track would show through its
        // thumb), so the card's fill, border and text are dimmed instead.
        let card = theme.group_box;
        v_flex()
            .id(("lora-slot", ix))
            .p_3()
            .rounded(theme.radius_lg)
            .border_1()
            .map(|this| {
                if enabled {
                    this.bg(card)
                        .border_color(theme.primary.opacity(0.5))
                        .shadow_sm()
                } else {
                    this.bg(card.opacity(0.6))
                        .border_color(theme.border.opacity(0.5))
                        .hover(|style| style.bg(card.opacity(0.8)))
                }
            })
            .child(
                h_flex()
                    .justify_between()
                    .gap_3()
                    .child(
                        Switch::new(("lora-enabled", ix))
                            .checked(enabled)
                            .label(format!("Slot {}", ix + 1))
                            .font_weight(FontWeight::MEDIUM)
                            .when(!enabled, |this| this.text_color(theme.muted_foreground))
                            .on_change(cx.listener(move |this, checked: &bool, _, cx| {
                                let checked = *checked;
                                this.update_slot(ix, cx, |slot| slot.enabled = checked);
                            })),
                    )
                    .when(!enabled && !slot.lora_name.is_empty(), |this| {
                        this.child(
                            div()
                                .min_w_0()
                                .max_w(rems(9.375))
                                .truncate()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(slot.lora_name.clone()),
                        )
                    }),
            )
            .when(enabled, |this| {
                this.child(
                    v_flex()
                        .mt_4()
                        .gap_4()
                        .child(
                            v_flex()
                                .gap_1p5()
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("Model"),
                                )
                                .child(
                                    Select::new(&controls.select)
                                        .placeholder("Select LoRA...")
                                        .empty(|_, _| div().p_2().child("No LoRAs found.")),
                                ),
                        )
                        .child(
                            h_flex()
                                .gap_4()
                                .items_start()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .child(controls.strength_model.clone()),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .child(controls.strength_clip.clone()),
                                ),
                        ),
                )
            })
    }

    fn render_size(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let size = current_size(&self.form);
        let portrait = self.portrait();
        let preset = image_size::matching_preset(size);

        v_flex()
            .gap_3()
            .p_3()
            .rounded(cx.theme().radius_lg)
            .border_1()
            .border_color(cx.theme().border)
            .child(
                h_flex()
                    .justify_between()
                    .child(Self::section_label("Image size"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!("{} × {} px", size.width, size.height)),
                    ),
            )
            .child(
                h_flex()
                    .gap_1()
                    .flex_wrap()
                    .children(PRESETS.iter().map(|preset_option| {
                        let target = preset_option.size(portrait);
                        let selected = preset.map(|p| p.id) == Some(preset_option.id);
                        Button::new(preset_option.id)
                            .small()
                            .when(selected, |button| button.primary())
                            .when(!selected, |button| button.outline())
                            .label(format!(
                                "{} {}",
                                preset_option.label,
                                preset_option.ratio_label(portrait)
                            ))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.set_size(target, true, window, cx)
                            }))
                    })),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        ButtonGroup::new("orientation")
                            .small()
                            .outline()
                            .child(
                                Button::new("landscape")
                                    .icon(IconName::RectangleHorizontal)
                                    .label("Landscape")
                                    .selected(!portrait),
                            )
                            .child(
                                Button::new("portrait")
                                    .icon(IconName::RectangleVertical)
                                    .label("Portrait")
                                    .selected(portrait),
                            )
                            .on_click(cx.listener(|this, selected: &Vec<usize>, window, cx| {
                                this.set_orientation(selected.first() == Some(&1), window, cx);
                            })),
                    )
                    .when(preset.is_none(), |this| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child("Custom ratio"),
                        )
                    }),
            )
            .child(
                h_flex().justify_between().text_xs().child("Size").child(
                    div()
                        .text_color(cx.theme().muted_foreground)
                        .child(image_size::scale_label(size)),
                ),
            )
            .child(Slider::new(&self.size_slider))
            .child(
                Button::new("custom-size")
                    .ghost()
                    .small()
                    .icon(if self.size_custom_open {
                        IconName::ChevronDown
                    } else {
                        IconName::ChevronRight
                    })
                    .label("Custom size")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.size_custom_open = !this.size_custom_open;
                        cx.notify();
                    })),
            )
            .when(self.size_custom_open, |this| {
                this.child(
                    h_flex()
                        .gap_2()
                        .items_end()
                        .child(
                            v_flex()
                                .flex_1()
                                .gap_1()
                                .child(div().text_xs().child("Width"))
                                .child(Input::new(&self.width_input)),
                        )
                        .child(
                            Button::new("lock-aspect")
                                .ghost()
                                .small()
                                .icon(if self.size_locked {
                                    IconName::Lock
                                } else {
                                    IconName::LockOpen
                                })
                                .tooltip(if self.size_locked {
                                    "Unlock aspect ratio"
                                } else {
                                    "Lock aspect ratio"
                                })
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.size_locked = !this.size_locked;
                                    cx.notify();
                                })),
                        )
                        .child(
                            v_flex()
                                .flex_1()
                                .gap_1()
                                .child(div().text_xs().child("Height"))
                                .child(Input::new(&self.height_input)),
                        ),
                )
            })
    }

    fn render_seed(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let random = self.form.seed < 0.0;
        v_flex().gap_2().child(Self::section_label("Seed")).child(
            h_flex()
                .gap_2()
                .child(div().flex_1().child(Input::new(&self.seed)))
                .child(
                    Button::new("randomize-seed")
                        .outline()
                        .small()
                        .icon(IconName::Dices)
                        .tooltip("Randomize Seed")
                        .on_click(cx.listener(|this, _, window, cx| {
                            let seed = rand::random_range(0..crate::form::MAX_RANDOM_SEED) as f64;
                            this.set_seed(seed, window, cx);
                        })),
                )
                .child(
                    Button::new("random-seed")
                        .small()
                        .when(random, |button| button.primary())
                        .when(!random, |button| button.outline())
                        .label("Random (-1)")
                        .tooltip("Set to Random (-1): the server picks a seed")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.set_seed(-1.0, window, cx)),
                        ),
                ),
        )
    }

    fn render_batch(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let batch = self.form.batch_size as u32;
        v_flex()
            .gap_2()
            .child(Self::section_label("Batch Size"))
            .child(
                ButtonGroup::new("batch-size")
                    .small()
                    .outline()
                    .children(BATCH_SIZES.iter().map(|size| {
                        Button::new(("batch", *size as usize))
                            .label(size.to_string())
                            .selected(batch == *size)
                    }))
                    .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                        if let Some(size) = selected.first().and_then(|ix| BATCH_SIZES.get(*ix)) {
                            let size = *size as f64;
                            this.update_form(cx, |form| form.batch_size = size);
                        }
                    })),
            )
    }

    pub fn render_generate_button(&self, cx: &mut Context<Self>) -> AnyElement {
        Button::new("generate")
            .primary()
            .large()
            .w_full()
            .icon(IconName::Sparkles)
            .label(if self.submitting {
                "Starting..."
            } else {
                "Generate"
            })
            .loading(self.submitting)
            .disabled(self.submitting)
            .tooltip_with_action("Generate", &Submit, Some(CONTEXT))
            .on_click(cx.listener(|this, _, window, cx| this.submit(&Submit, window, cx)))
            .into_any_element()
    }
}

fn current_size(form: &FormState) -> ImageSize {
    ImageSize {
        width: image_size::snap(form.width),
        height: image_size::snap(form.height),
    }
}

fn format_seed(seed: f64) -> String {
    format!("{}", seed as i64)
}

/// A typed seed: a whole number, or -1 (random) for anything unreadable.
fn typed_seed(text: &str) -> f64 {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|seed| seed.is_finite())
        .map(f64::trunc)
        .unwrap_or(-1.0)
}

impl Focusable for SelfHostedComposer {
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SelfHostedComposer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let catalog_error = self
            .catalog
            .as_ref()
            .and_then(|catalog| catalog.error.clone());
        let loading = self.catalog.is_none();
        let advanced_open = self.advanced_open;
        let generate = self.kind == ComposerKind::Generate;

        v_flex()
            .id("self-hosted-composer")
            .when(generate, |this| {
                this.key_context(CONTEXT)
                    .on_action(cx.listener(Self::submit))
            })
            .track_focus(&self.focus_handle)
            .size_full()
            .child(
                v_flex()
                    .id("self-hosted-form")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_4()
                    .gap_4()
                    .when_some(catalog_error, |this, error| {
                        this.child(div().text_sm().text_color(cx.theme().warning).child(error))
                    })
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Self::section_label("Checkpoint"))
                            .child(
                                Select::new(&self.checkpoint)
                                    .placeholder(if loading {
                                        "Loading checkpoints..."
                                    } else {
                                        "Choose a checkpoint"
                                    })
                                    .empty(|_, _| div().p_2().child("No checkpoints found")),
                            ),
                    )
                    .child(self.render_loras(cx))
                    .child(
                        v_flex()
                            .gap_2()
                            .child(
                                h_flex()
                                    .justify_between()
                                    .child(Self::section_label("Prompt"))
                                    .children(self.library.clone()),
                            )
                            .child(Textarea::new(&self.prompt)),
                    )
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Self::section_label("Negative Prompt"))
                            .child(Textarea::new(&self.negative_prompt)),
                    )
                    .when(generate, |this| this.child(self.render_size(cx)))
                    .when(!generate, |this| {
                        this.child(
                            v_flex()
                                .gap_2()
                                .child(Self::section_label("Denoise"))
                                .child(self.denoise.clone()),
                        )
                    })
                    .child(self.render_seed(cx))
                    .when(generate, |this| this.child(self.render_batch(cx)))
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Self::section_label("Steps"))
                            .child(self.steps.clone()),
                    )
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Self::section_label("CFG Scale"))
                            .child(self.cfg.clone()),
                    )
                    .child(
                        h_flex()
                            .gap_3()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .gap_2()
                                    .child(Self::section_label("Sampler"))
                                    .child(Select::new(&self.sampler).placeholder("Sampler")),
                            )
                            .child(
                                v_flex()
                                    .flex_1()
                                    .gap_2()
                                    .child(Self::section_label("Scheduler"))
                                    .child(Select::new(&self.scheduler).placeholder("Scheduler")),
                            ),
                    )
                    .when(generate, |this| {
                        this.child(
                            Button::new("advanced")
                                .ghost()
                                .small()
                                .icon(if advanced_open {
                                    IconName::ChevronDown
                                } else {
                                    IconName::ChevronRight
                                })
                                .label("Advanced Settings")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.advanced_open = !this.advanced_open;
                                    cx.notify();
                                })),
                        )
                    })
                    .when(generate && advanced_open, |this| {
                        this.child(
                            v_flex()
                                .gap_2()
                                .child(Self::section_label("Denoising Strength"))
                                .child(self.denoise.clone()),
                        )
                    }),
            )
            .when(generate, |this| {
                this.child(
                    div()
                        .p_4()
                        .border_t_1()
                        .border_color(cx.theme().border)
                        .child(self.render_generate_button(cx)),
                )
            })
    }
}
