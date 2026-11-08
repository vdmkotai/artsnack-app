//! The MiniMax H3 form (the H3 half of the web's `VideoPanel`).

use artsnack_backend::api::comfy_video_jobs::{H3Mode, ReferenceSize, SparseAttention};
use gpui_kit::{
    AnyElement, Context, ExternalPaths, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, Styled as _, Window,
    component::{
        ActiveTheme as _, Selectable as _, Sizable as _,
        button::{Button, ButtonGroup},
        h_flex,
        input::NumberInput,
        select::Select,
        slider::Slider,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

use super::{Num, Slide, Slot, VideoComposer};
use crate::{
    controls::{
        Field, ImageSlot, ToggleRow, advice_line, community_mark, group_box, hint, section_title,
    },
    form::{self, Family},
};

impl VideoComposer {
    pub(super) fn render_h3(&self, _: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let rules = &self.rules;
        let settings = &self.h3.settings;
        let custom = form::is_custom_h3(&settings.checkpoint);
        let marks = form::h3_marks(settings, rules);
        let advice = form::h3_advice(settings, self.weak_int8(cx), rules);
        let pod_ready = !self.ready_pods(cx).is_empty();
        let catalog_error = self
            .catalog
            .as_ref()
            .and_then(|catalog| catalog.error.clone());
        // Unknown until the first read: an option's warning waits for it.
        let extras = self
            .catalog
            .as_ref()
            .map(|catalog| catalog.extras.unwrap_or_default());
        let mut out: Vec<AnyElement> = Vec::new();

        let modes = rules.h3_modes.clone();
        out.push(
            ButtonGroup::new("h3-mode")
                .outline()
                .small()
                .w_full()
                .children(modes.iter().map(|mode| {
                    Button::new(SharedString::from(format!("h3-mode-{:?}", mode.value)))
                        .flex_1()
                        .label(mode.label.clone())
                        .tooltip(mode.hint.clone())
                        .selected(settings.mode == mode.value)
                }))
                .on_click(cx.listener(move |this, selected: &Vec<usize>, window, cx| {
                    if let Some(mode) = selected.first().and_then(|ix| modes.get(*ix)) {
                        this.set_h3_mode(mode.value, window, cx);
                    }
                }))
                .into_any_element(),
        );

        match settings.mode {
            H3Mode::Frames => out.push(self.render_frame_slots(cx).into_any_element()),
            H3Mode::Reference => out.push(self.render_references(cx)),
            H3Mode::Text => {}
        }

        let checkpoint_hint = catalog_error.or_else(|| {
            custom.then(|| {
                "Custom checkpoints are often turbo merges already — check its model page and switch Turbo off if so.".to_string()
            })
        });
        out.push(
            Field::new("h3-checkpoint", "Checkpoint")
                .hint(checkpoint_hint)
                .advice(advice.checkpoint.clone())
                .child(
                    Select::new(&self.h3_checkpoint)
                        .placeholder(if pod_ready {
                            "Choose a checkpoint…"
                        } else {
                            "Start the video pod to list models"
                        })
                        .empty(|_, _| div().p_2().child("No H3 checkpoints on the pod")),
                )
                .into_any_element(),
        );
        out.push(
            Field::new("h3-loras", "LoRAs")
                .child(self.h3_loras.clone())
                .into_any_element(),
        );
        out.push(self.render_prompt(None).into_any_element());
        out.push(self.render_size(Family::H3, cx).into_any_element());

        let duration = settings.duration_seconds;
        let frames = self
            .derived
            .h3_frames
            .map(|frames| format!(" · {frames} frames at 24 fps"))
            .unwrap_or_default();
        out.push(
            Field::new(
                "h3-duration",
                format!("Duration · {} s{frames}", form::plain(duration)),
            )
            .hint(Some(if duration > 15.0 {
                "Past 15 s is outside H3\u{2019}s trained range — expect drift."
            } else {
                "Time grows faster than length: 10 s takes about three times a 5 s clip."
            }))
            .child(Slider::new(&self.sliders[&Slide::H3Duration]).accessibility_label("Duration"))
            .into_any_element(),
        );

        out.push(
            self.render_quality_header(
                "h3-recommended",
                if custom {
                    "Custom checkpoint: follow the settings on its model page."
                } else if marks.all {
                    "Recommended settings for the official model."
                } else {
                    "Changed from the recommended settings."
                },
                marks.all,
                "Turbo on, fast attention on, sparse attention and EasyCache off, shift off",
                |this, window, cx| this.reset_h3_recommended(window, cx),
                cx,
            )
            .into_any_element(),
        );

        out.push(
            v_flex()
                .gap_2()
                .child(
                    ToggleRow::new("h3-turbo", "Turbo", settings.turbo)
                        .hint(format!(
                            "Speed-up LoRA: {} steps instead of 20–25, about 2× faster, slightly less detail.",
                            form::plain(rules.h3_turbo_steps.get(settings.mode))
                        ))
                        .recommended(marks.turbo)
                        .advice(advice.turbo.clone())
                        .on_change(cx.listener(|this, checked: &bool, window, cx| {
                            this.set_turbo(*checked, window, cx)
                        })),
                )
                .child(
                    ToggleRow::new("h3-audio", "Audio", settings.audio)
                        .hint("Off removes the soundtrack; it does not render faster.")
                        .on_change(cx.listener(|this, checked: &bool, _, cx| {
                            let checked = *checked;
                            this.update_h3(cx, |form| form.settings.audio = checked);
                        })),
                )
                .into_any_element(),
        );

        out.push(
            v_flex()
                .gap_1p5()
                .child(
                    h_flex()
                        .items_start()
                        .gap_2()
                        .child(
                            div().flex_1().min_w_0().child(
                                Field::new("h3-steps", "Steps")
                                    .recommended(marks.steps)
                                    .child(NumberInput::new(&self.numbers[&Num::H3Steps]).small()),
                            ),
                        )
                        .child(
                            div().flex_1().min_w_0().child(
                                Field::new("h3-sampler", "Sampler")
                                    .recommended(marks.sampler)
                                    .child(Select::new(&self.sampler).small()),
                            ),
                        )
                        .child(
                            div().flex_1().min_w_0().child(
                                Field::new("h3-scheduler", "Scheduler")
                                    .recommended(marks.scheduler)
                                    .child(Select::new(&self.scheduler).small()),
                            ),
                        ),
                )
                .when_some(advice.steps.clone(), |this, advice| {
                    this.child(advice_line(&advice, cx))
                })
                .into_any_element(),
        );

        out.push(
            group_box(cx)
                .child(
                    ToggleRow::new("h3-shift", "Sigma shift", settings.shift_enabled)
                        .unboxed()
                        .hint("Overrides how the noise is spread over the steps. Off = the model\u{2019}s own schedule.")
                        .recommended(marks.shift)
                        .advice(advice.shift.clone())
                        .on_change(cx.listener(|this, checked: &bool, _, cx| {
                            let checked = *checked;
                            this.update_h3(cx, |form| form.settings.shift_enabled = checked);
                        })),
                )
                .when(settings.shift_enabled, |this| {
                    this.child(
                        h_flex()
                            .items_start()
                            .gap_2()
                            .child(
                                div().flex_1().min_w_0().child(
                                    Field::new("h3-shift-video", "Video shift")
                                        .hint(Some("Higher favours overall composition and motion, lower fine detail. Usually 10–12."))
                                        .child(
                                            NumberInput::new(&self.numbers[&Num::H3ShiftVideo])
                                                .small(),
                                        ),
                                ),
                            )
                            .child(
                                div().flex_1().min_w_0().child(
                                    Field::new("h3-shift-audio", "Audio shift")
                                        .hint(Some("The same for the soundtrack. Usually 3–5."))
                                        .child(
                                            NumberInput::new(&self.numbers[&Num::H3ShiftAudio])
                                                .small(),
                                        ),
                                ),
                            ),
                    )
                })
                .into_any_element(),
        );

        out.push(
            self.render_speed(settings, &marks, &advice, cx)
                .into_any_element(),
        );
        out.push(
            self.render_community(settings, extras, pod_ready, cx)
                .into_any_element(),
        );

        if settings.mode == H3Mode::Reference {
            let size = settings.reference_size;
            out.push(
                Field::new("h3-reference-size", "Reference size")
                    .hint(Some(
                        "Max keeps references at 2048 px for identity; it can be several times slower.",
                    ))
                    .child(
                        ButtonGroup::new("h3-reference-size-choice")
                            .outline()
                            .small()
                            .child(
                                Button::new("h3-reference-size-match")
                                    .label("Match output")
                                    .selected(size == ReferenceSize::Match),
                            )
                            .child(
                                Button::new("h3-reference-size-max")
                                    .label("Max")
                                    .selected(size == ReferenceSize::Max),
                            )
                            .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                                let size = match selected.first() {
                                    Some(1) => ReferenceSize::Max,
                                    _ => ReferenceSize::Match,
                                };
                                this.update_h3(cx, |form| form.settings.reference_size = size);
                            })),
                    )
                    .into_any_element(),
            );
        }

        out.push(
            self.render_seed_and_clips(Family::H3, cx)
                .into_any_element(),
        );
        out
    }

    fn render_speed(
        &self,
        settings: &artsnack_backend::api::comfy_video_jobs::H3Settings,
        marks: &form::H3Marks,
        advice: &form::H3Advice,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let sparse = settings.sparse_attention;
        let sparse_hint = match sparse {
            SparseAttention::Vsa => {
                "VSA needs FastH3-trained weights; keep % of video cubes (trained at 10)."
            }
            SparseAttention::Sol => {
                "Training-free; higher tau is sparser and faster (1.0 ≈ 16% exact)."
            }
            SparseAttention::Off => {
                "Computes only the strongest links between frames. SOL: any model. VSA: VSA-trained weights only."
            }
        };
        const SPARSE: [(SparseAttention, &str); 3] = [
            (SparseAttention::Off, "Off"),
            (SparseAttention::Sol, "SOL"),
            (SparseAttention::Vsa, "VSA"),
        ];
        group_box(cx)
            .child(section_title("Speed"))
            .child(
                ToggleRow::new(
                    "h3-fast-attention",
                    "Fast attention (Comfy Kitchen INT8)",
                    settings.fast_attention,
                )
                .unboxed()
                .hint("About 27% faster with no visible loss in our tests.")
                .recommended(marks.fast_attention)
                .advice(advice.fast_attention.clone())
                .on_change(cx.listener(|this, checked: &bool, _, cx| {
                    let checked = *checked;
                    this.update_h3(cx, |form| form.settings.fast_attention = checked);
                })),
            )
            .child(
                Field::new("h3-sparse", "Sparse attention")
                    .recommended(marks.sparse)
                    .hint(Some(sparse_hint))
                    .advice(advice.sparse.clone())
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                ButtonGroup::new("h3-sparse-choice")
                                    .outline()
                                    .small()
                                    .children(SPARSE.iter().map(|(value, label)| {
                                        Button::new(SharedString::from(format!(
                                            "h3-sparse-{label}"
                                        )))
                                        .label(*label)
                                        .selected(sparse == *value)
                                    }))
                                    .on_click(cx.listener(
                                        |this, selected: &Vec<usize>, window, cx| {
                                            if let Some((value, _)) =
                                                selected.first().and_then(|ix| SPARSE.get(*ix))
                                            {
                                                this.set_sparse(*value, window, cx);
                                            }
                                        },
                                    )),
                            )
                            .when(sparse != SparseAttention::Off, |this| {
                                this.child(
                                    div().w_32().child(
                                        NumberInput::new(&self.numbers[&Num::H3Sparse])
                                            .small()
                                            .accessibility_label(match sparse {
                                                SparseAttention::Vsa => "Keep percent",
                                                _ => "Tau",
                                            }),
                                    ),
                                )
                            }),
                    ),
            )
            .child(
                ToggleRow::new("h3-easy-cache", "EasyCache", settings.easy_cache)
                    .unboxed()
                    .hint("Reuses steps that barely change; faster, can soften fine motion.")
                    .recommended(marks.easy_cache)
                    .advice(advice.easy_cache.clone())
                    .on_change(cx.listener(|this, checked: &bool, _, cx| {
                        let checked = *checked;
                        this.update_h3(cx, |form| form.settings.easy_cache = checked);
                    })),
            )
            .when(settings.easy_cache, |this| {
                this.child(
                    Field::new("h3-easy-cache-threshold", "Reuse threshold").child(
                        div()
                            .w_32()
                            .child(NumberInput::new(&self.numbers[&Num::H3EasyCache]).small()),
                    ),
                )
            })
    }

    /// Third-party models and nodes, each off until the pod reports its file.
    fn render_community(
        &self,
        settings: &artsnack_backend::api::comfy_video_jobs::H3Settings,
        extras: Option<artsnack_backend::api::pod_catalog::VideoExtras>,
        pod_ready: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let has = extras.unwrap_or_default();
        // Only a pod that answered can be said to lack something.
        let missing = |present: bool| pod_ready && extras.is_some() && !present;
        group_box(cx)
            .child(
                h_flex()
                    .gap_1p5()
                    .child(section_title("Community add-ons"))
                    .child(community_mark("h3-community-mark")),
            )
            .child(hint(
                "Third-party models and nodes the community uses for smoother H3 clips — not part of official H3. Off by default; try them one at a time.",
                cx,
            ))
            .child(
                ToggleRow::new("h3-rife", "Smooth 48 fps (RIFE)", settings.interpolate)
                    .unboxed()
                        .hint("Doubles the frame rate after rendering — fluid motion, a few seconds extra.")
                    .community()
                    .disabled(!has.rife && !settings.interpolate)
                    .advice(missing(has.rife).then(|| {
                        form::Advice::warn(
                            "Not on this pod — it booted before RIFE was added. Start a new pod.",
                        )
                    }))
                    .on_change(cx.listener(|this, checked: &bool, _, cx| {
                        let checked = *checked;
                        this.update_h3(cx, |form| form.settings.interpolate = checked);
                    })),
            )
            .child(
                ToggleRow::new("h3-upscale", "Upscale 2× (two-pass)", settings.upscale)
                    .unboxed()
                        .hint("Renders at half size, upscales the latent with a trained H3 upscaler, then refines 3 steps at full size. Sharper detail; often faster too.")
                    .community()
                    .disabled(!has.upscaler && !settings.upscale)
                    .advice(missing(has.upscaler).then(|| {
                        form::Advice::warn(
                            "Not on this pod — it booted before the upscaler was added. Start a new pod.",
                        )
                    }))
                    .on_change(cx.listener(|this, checked: &bool, _, cx| {
                        let checked = *checked;
                        this.update_h3(cx, |form| form.settings.upscale = checked);
                    })),
            )
    }

    /// One frame slot, for either family's Image → video.
    pub(super) fn frame_slot(
        &self,
        slot: Slot,
        id: &'static str,
        label: &'static str,
        cx: &mut Context<Self>,
    ) -> ImageSlot {
        let image = self.input(slot.role());
        let image_id = image.map(|image| image.id);
        ImageSlot::new(id, label)
            .image(image.map(|image| image.preview.clone()))
            .preparing(image.is_none() && self.is_preparing(slot))
            .on_upload(cx.listener(move |this, _, _, cx| this.pick_files(slot, cx)))
            .on_gallery(cx.listener(move |this, _, window, cx| this.open_gallery(slot, window, cx)))
            .when_some(image_id, |image_slot, image_id| {
                image_slot.on_clear(
                    cx.listener(move |this, _, window, cx| this.remove_input(image_id, window, cx)),
                )
            })
            .on_drop(cx.listener(move |this, paths: &ExternalPaths, _, cx| {
                this.add_files(paths.paths().to_vec(), slot, cx)
            }))
    }

    pub(super) fn render_frame_slots(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .items_start()
            .gap_3()
            .child(div().flex_1().min_w_0().child(self.frame_slot(
                Slot::First,
                "first-frame",
                "First frame",
                cx,
            )))
            .child(div().flex_1().min_w_0().child(self.frame_slot(
                Slot::Last,
                "last-frame",
                "Last frame",
                cx,
            )))
    }

    /// H3's references: numbered as the prompt tags them, then one slot to
    /// add more until the limit. Files dropped anywhere on the block are added.
    fn render_references(&self, cx: &mut Context<Self>) -> AnyElement {
        let references = self.references();
        let limit = self.rules.h3_limits.references;
        let preparing = self
            .preparing
            .iter()
            .filter(|slot| **slot == Slot::Reference)
            .count();
        let tint = cx.theme().primary.opacity(0.05);
        let count = references.len();
        v_flex()
            .id("h3-references")
            .gap_1p5()
            .rounded(cx.theme().radius_lg)
            .drag_over::<ExternalPaths>(move |style, _, _, _| style.bg(tint))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                this.add_files(paths.paths().to_vec(), Slot::Reference, cx)
            }))
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .children(references.iter().enumerate().map(|(ix, image)| {
                        let id = image.id;
                        div().w_32().child(
                            ImageSlot::new(format!("reference-{id}"), format!("Reference {}", ix + 1))
                                .badge(ix + 1)
                                .image(Some(image.preview.clone()))
                                .on_clear(cx.listener(move |this, _, window, cx| {
                                    this.remove_input(id, window, cx)
                                })),
                        )
                    }))
                    .children((0..preparing).map(|ix| {
                        div().w_32().child(
                            ImageSlot::new(format!("reference-preparing-{ix}"), "Preparing…")
                                .preparing(true),
                        )
                    }))
                    .when(count + preparing < limit, |this| {
                        this.child(
                            div().w_32().child(
                                ImageSlot::new("reference-add", format!("Add ({count}/{limit})"))
                                    .compact()
                                    .on_upload(cx.listener(|this, _, _, cx| {
                                        this.pick_files(Slot::Reference, cx)
                                    }))
                                    .on_gallery(cx.listener(|this, _, window, cx| {
                                        this.open_gallery(Slot::Reference, window, cx)
                                    })),
                            ),
                        )
                    }),
            )
            .child(hint(
                "Tag a reference in the prompt as @image1, @image2… — @image1 is the first. Drop or paste images here too.",
                cx,
            ))
            .into_any_element()
    }
}
