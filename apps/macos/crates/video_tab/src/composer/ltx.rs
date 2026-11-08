//! The LTX 2.3 form (the web's `h3/ltx-composer.tsx`).

use artsnack_backend::api::comfy_video_jobs::LtxMode;
use gpui_kit::{
    AnyElement, Context, ExternalPaths, IntoElement, ParentElement as _, SharedString, Styled as _,
    Window,
    assets::IconName,
    component::{
        Disableable as _, Selectable as _, Sizable as _,
        button::{Button, ButtonGroup, ButtonVariants as _},
        h_flex,
        input::{Input, NumberInput},
        select::Select,
        slider::Slider,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

use super::{Num, Slide, Slot, VideoComposer};
use crate::{
    controls::{Field, ImageSlot, ToggleRow, hint},
    form::{self, Advice, Family},
};

const MODES: [(LtxMode, &str); 3] = [
    (LtxMode::Text, "Text → video"),
    (LtxMode::Frames, "Image → video"),
    (LtxMode::Sheet, "Reference sheet"),
];

impl VideoComposer {
    /// Reads the form and the pods' lists in place: nothing here is cloned
    /// per frame, and the advice was worked out when they changed.
    pub(super) fn render_ltx(&self, _: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let rules = &self.rules;
        let settings = &self.ltx.settings;
        let marks = form::ltx_marks(settings, rules);
        let sheet_mode = settings.mode == LtxMode::Sheet;
        let pod_ready = !self.ready_pods(cx).is_empty();
        let catalog = self.ltx_catalog();
        let catalog_error = self
            .catalog
            .as_ref()
            .and_then(|catalog| catalog.error.as_deref());
        let mut out: Vec<AnyElement> = Vec::new();

        out.push(
            ButtonGroup::new("ltx-mode")
                .outline()
                .small()
                .w_full()
                .children(MODES.iter().map(|(mode, label)| {
                    Button::new(SharedString::from(format!("ltx-mode-{mode:?}")))
                        .flex_1()
                        .label(*label)
                        .selected(settings.mode == *mode)
                }))
                .on_click(cx.listener(|this, selected: &Vec<usize>, window, cx| {
                    if let Some((mode, _)) = selected.first().and_then(|ix| MODES.get(*ix)) {
                        this.set_ltx_mode(*mode, window, cx);
                    }
                }))
                .into_any_element(),
        );

        match settings.mode {
            LtxMode::Frames => out.push(
                v_flex()
                    .gap_2()
                    .child(self.render_frame_slots(cx))
                    .child(
                        h_flex()
                            .items_start()
                            .gap_3()
                            .child(
                                div().flex_1().min_w_0().child(
                                    Field::new(
                                        "ltx-image-strength",
                                        format!("Image strength · {:.2}", settings.image_strength),
                                    )
                                    .recommended(marks.image_strength)
                                    .hint(Some("How tightly the clip holds the frame. 0.7 lets it move; 1.0 can freeze it."))
                                    .child(
                                        Slider::new(&self.sliders[&Slide::LtxImageStrength])
                                            .accessibility_label("Image strength"),
                                    ),
                                ),
                            )
                            .child(
                                div().flex_1().min_w_0().child(
                                    Field::new(
                                        "ltx-image-compression",
                                        format!(
                                            "Image compression · {}",
                                            form::plain(settings.image_compression)
                                        ),
                                    )
                                    .recommended(marks.image_compression)
                                    .hint(Some("Softens the frame so LTX treats it as video, not a still. 33 in every example."))
                                    .child(
                                        Slider::new(&self.sliders[&Slide::LtxImageCompression])
                                            .accessibility_label("Image compression"),
                                    ),
                                ),
                            ),
                    )
                    .into_any_element(),
            ),
            LtxMode::Sheet => out.push(self.render_sheet(catalog, cx)),
            LtxMode::Text => {}
        }

        let checkpoint_hint = catalog_error.map(SharedString::from).or_else(|| {
            catalog.filter(|catalog| !catalog.ready).map(|_| {
                "LTX base models are still downloading to the pod (text encoder, VAEs, upscaler) — a few minutes after it starts.".into()
            })
        });
        out.push(
            Field::new("ltx-checkpoint", "Checkpoint")
                .hint(checkpoint_hint)
                .advice(self.derived.ltx_checkpoint_advice.clone())
                .child(
                    Select::new(&self.ltx_checkpoint)
                        .placeholder(if pod_ready {
                            "Choose a checkpoint…"
                        } else {
                            "Start the video pod to list models"
                        })
                        .empty(|_, _| div().p_2().child("No LTX checkpoints on the pod yet")),
                )
                .into_any_element(),
        );
        out.push(
            Field::new("ltx-loras", "LoRAs")
                .hint(Some("LTX LoRAs usually want 0.5–1.0; motion helpers ~0.7."))
                .child(self.ltx_loras.clone())
                .into_any_element(),
        );

        let two_part = (sheet_mode && !form::has_sheet_part(&settings.prompt)).then(|| {
            Button::new("ltx-two-part-prompt")
                .ghost()
                .xsmall()
                .icon(IconName::TextCursorInput)
                .label("Two-part prompt")
                .tooltip(
                    "The Ingredients LoRA reads a two-part prompt: what the sheet shows, then the scene",
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    let text = form::two_part_prompt(&this.ltx.settings.prompt);
                    this.replace_prompt(text, window, cx);
                }))
                .into_any_element()
        });
        out.push(
            v_flex()
                .gap_1p5()
                .child(self.render_prompt(two_part))
                .when(settings.cfg > 1.0, |this| {
                    this.child(
                        Input::new(&self.negative_prompt)
                            .small()
                            .aria_label("Negative prompt"),
                    )
                })
                .into_any_element(),
        );
        out.push(self.render_size(Family::Ltx, cx).into_any_element());

        let frames = self
            .derived
            .ltx_frames
            .map(|frames| format!(" · {frames} frames"))
            .unwrap_or_default();
        let fps_options = rules.ltx_fps.clone();
        out.push(
            h_flex()
                .items_start()
                .gap_3()
                .child(
                    div().flex_1().min_w_0().child(
                        Field::new(
                            "ltx-duration",
                            format!(
                                "Duration · {} s{frames}",
                                form::plain(settings.duration_seconds)
                            ),
                        )
                        .hint(Some(
                            "LTX 2.3 holds up to 20 s; longer clips take disproportionately longer.",
                        ))
                        .child(
                            Slider::new(&self.sliders[&Slide::LtxDuration])
                                .accessibility_label("Duration"),
                        ),
                    ),
                )
                .child(
                    Field::new("ltx-fps", "FPS").child(
                        ButtonGroup::new("ltx-fps-choice")
                            .outline()
                            .small()
                            .children(fps_options.iter().map(|fps| {
                                Button::new(SharedString::from(format!("ltx-fps-{fps}")))
                                    .label(form::plain(*fps))
                                    .selected(settings.fps == *fps)
                            }))
                            .on_click(cx.listener(move |this, selected: &Vec<usize>, _, cx| {
                                if let Some(fps) = selected.first().and_then(|ix| fps_options.get(*ix))
                                {
                                    let fps = *fps;
                                    this.update_ltx(cx, |form| form.settings.fps = fps);
                                }
                            })),
                    ),
                )
                .into_any_element(),
        );

        out.push(
            self.render_quality_header(
                "ltx-recommended",
                if marks.all {
                    "The two-pass recipe the best community examples use."
                } else {
                    "Changed from the recommended settings."
                },
                marks.all,
                "8 steps, two passes, CFG 1, image strength 0.7, compression 33",
                |this, window, cx| this.reset_ltx_recommended(window, cx),
                cx,
            )
            .into_any_element(),
        );

        out.push(
            v_flex()
                .gap_2()
                .child(
                    ToggleRow::new(
                        "ltx-two-pass",
                        "Two passes (upscale ×2)",
                        settings.two_pass && !sheet_mode,
                    )
                    .hint(if sheet_mode {
                        "Off for a reference sheet: one full-size pass, as in Lightricks\u{2019} workflow, so the likeness is not lost in an upscale."
                    } else {
                        "Renders at half size, upscales the latent 2× with Lightricks\u{2019} upscaler, refines 3 steps. Sharper and faster than one full-size pass."
                    })
                    .recommended(!sheet_mode && marks.two_pass)
                    .disabled(sheet_mode)
                    .on_change(cx.listener(|this, checked: &bool, _, cx| {
                        let checked = *checked;
                        this.update_ltx(cx, |form| form.settings.two_pass = checked);
                    })),
                )
                .child(
                    ToggleRow::new("ltx-audio", "Audio", settings.audio)
                        .hint("LTX renders the soundtrack with the video; off drops it from the file.")
                        .on_change(cx.listener(|this, checked: &bool, _, cx| {
                            let checked = *checked;
                            this.update_ltx(cx, |form| form.settings.audio = checked);
                        })),
                )
                .into_any_element(),
        );

        out.push(
            h_flex()
                .items_start()
                .gap_3()
                .child(
                    div().flex_1().min_w_0().child(
                        Field::new("ltx-steps", "Steps")
                            .recommended(!sheet_mode && marks.steps)
                            .hint(Some(if sheet_mode {
                                "Fixed for a reference sheet: Lightricks\u{2019} 8-step schedule."
                            } else {
                                "8 = Lightricks\u{2019} fixed distilled schedule (distilled models). Dev without a distill LoRA: ~30 on the LTXV scheduler."
                            }))
                            .child(
                                NumberInput::new(&self.numbers[&Num::LtxSteps])
                                    .small()
                                    .disabled(sheet_mode),
                            ),
                    ),
                )
                .child(
                    div().flex_1().min_w_0().child(
                        Field::new("ltx-cfg", "CFG")
                            .recommended(marks.cfg)
                            .hint(Some(
                                "1 = guidance-free (distilled). Above 1 enables the negative prompt and doubles the time.",
                            ))
                            .child(NumberInput::new(&self.numbers[&Num::LtxCfg]).small()),
                    ),
                )
                .into_any_element(),
        );

        out.push(
            self.render_seed_and_clips(Family::Ltx, cx)
                .into_any_element(),
        );
        out
    }

    /// One sheet image beside what makes a good one, and how strongly the
    /// clip follows it.
    fn render_sheet(
        &self,
        catalog: Option<&artsnack_backend::api::pod_catalog::LtxCatalog>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let sheet = self.sheet();
        let sheet_id = sheet.map(|image| image.id);
        let strength = self.ltx.settings.sheet_strength.unwrap_or(1.0);
        let slot = ImageSlot::new("reference-sheet", "Reference sheet")
            .image(sheet.map(|image| image.preview.clone()))
            .preparing(sheet.is_none() && self.is_preparing(Slot::Sheet))
            .on_upload(cx.listener(|this, _, _, cx| this.pick_files(Slot::Sheet, cx)))
            .on_gallery(
                cx.listener(|this, _, window, cx| this.open_gallery(Slot::Sheet, window, cx)),
            )
            .when_some(sheet_id, |slot, id| {
                slot.on_clear(
                    cx.listener(move |this, _, window, cx| this.remove_input(id, window, cx)),
                )
            })
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                this.add_files(paths.paths().to_vec(), Slot::Sheet, cx)
            }));
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .items_start()
                    .gap_3()
                    .child(div().flex_1().min_w_0().child(slot))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_1p5()
                            .pt_5()
                            .child(hint(
                                "Lightricks\u{2019} Ingredients IC-LoRA: the clip takes its characters, outfits and props from this sheet, not from the first frame.",
                                cx,
                            ))
                            .child(hint(
                                "Best sheets: a few large panels on a black background, the same character from several angles, no text or labels. It is letterboxed to the clip\u{2019}s size.",
                                cx,
                            )),
                    ),
            )
            .child(
                Field::new("ltx-sheet-strength", format!("Sheet strength · {strength:.2}"))
                    .recommended((1.0..=1.4).contains(&strength))
                    .hint(Some(
                        "1.0–1.4 per the model card; raise it when the clip drifts from the sheet.",
                    ))
                    .advice(catalog.filter(|catalog| !catalog.sheet).map(|_| {
                        Advice::warn(
                            "The Ingredients LoRA is not on this pod. It is gated on Hugging Face: pods started with HF_TOKEN set download it with the LTX set.",
                        )
                    }))
                    .child(
                        Slider::new(&self.sliders[&Slide::LtxSheetStrength])
                            .accessibility_label("Sheet strength"),
                    ),
            )
            .into_any_element()
    }
}
