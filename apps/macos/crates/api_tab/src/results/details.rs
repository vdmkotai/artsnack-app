//! The viewer's details panel (the web's `GenerationDetails`): what a result
//! was given, how long each part took and on what hardware, every setting and
//! the prompt — what the result itself cannot tell you.
//!
//! It reads `grokGenerations:get`, and for a self-hosted clip
//! `comfyVideo:runDetails`, live; the sections are laid out by
//! `details` in api-results.ts from the shared normalisers and run stats. Until
//! `get` answers, the grid's copy of the row stands in.

use std::{rc::Rc, sync::Arc};

use artsnack_backend::{
    LiveQuery, QueryState,
    api::{
        comfy_video::{self, RunDetails},
        grok_generations::{self, ApiGeneration, IdArgs},
    },
};
use artsnack_media::{ImageRequest, Media, media_image};
use gpui_kit::{
    AnyElement, App, Context, Entity, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ObjectFit, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledImage as _, Subscription, Task, WeakEntity, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        spinner::Spinner,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
    relative, rems,
};
use serde::Deserialize;

use super::{ApiResults, content::is_self_hosted_video, copied::CopiedMark, meta};

/// A prompt longer than this, or of more lines, starts clamped.
const LONG_PROMPT_CHARS: usize = 280;
const LONG_PROMPT_LINES: usize = 6;
/// Reference thumbnails are 256 px from the CDN.
const THUMB_MAX_DIMENSION: u32 = 256;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailsModel {
    badge: String,
    created: String,
    #[serde(default)]
    self_hosted: bool,
    #[serde(default)]
    references: Vec<Reference>,
    #[serde(default)]
    references_missing: bool,
    timing: Option<Timing>,
    gpu: Option<Vec<DetailRow>>,
    #[serde(default)]
    settings: Vec<DetailRow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    /// The stored copy, which the thumbnail shows.
    key: String,
    /// The output it was taken from, when it was one: what finds its
    /// generation (the stored copy is an upload and has none).
    source_key: Option<String>,
    label: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Timing {
    total_label: String,
    total: Option<String>,
    phases: Vec<Phase>,
    stages: Vec<Stage>,
    notes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct Phase {
    /// prepare | queue | render | save.
    key: String,
    label: String,
    duration: String,
    /// Fraction of the phases' total.
    share: f32,
}

#[derive(Clone, Debug, Deserialize)]
struct Stage {
    label: String,
    /// "20 steps · 1.4 s/step".
    detail: Option<String>,
    duration: String,
    share: f32,
}

#[derive(Clone, Debug, Deserialize)]
struct DetailRow {
    label: String,
    value: String,
    note: Option<String>,
    #[serde(default)]
    mono: bool,
    /// Offered with a Copy button (the seed).
    copy: Option<String>,
}

pub(crate) struct GenerationDetails {
    /// The grid's copy of the row, until `get` answers.
    row: Arc<ApiGeneration>,
    generation: Entity<LiveQuery<Option<ApiGeneration>>>,
    run: Option<Entity<LiveQuery<Option<RunDetails>>>>,
    model: Option<Rc<DetailsModel>>,
    error: Option<SharedString>,
    _load: Option<Task<()>>,
    prompt_expanded: bool,
    copied: CopiedMark,
    results: WeakEntity<ApiResults>,
    _subscriptions: Vec<Subscription>,
}

impl GenerationDetails {
    pub fn new(
        row: Arc<ApiGeneration>,
        results: WeakEntity<ApiResults>,
        cx: &mut Context<Self>,
    ) -> Self {
        let args = IdArgs { id: row.id.clone() };
        let generation = LiveQuery::new(grok_generations::GET, &args, cx);
        // Only a clip from the video pod has a pod to describe.
        let run =
            is_self_hosted_video(&row).then(|| LiveQuery::new(comfy_video::RUN_DETAILS, &args, cx));
        let mut subscriptions = vec![cx.observe(&generation, |this, _, cx| this.load(cx))];
        if let Some(run) = &run {
            subscriptions.push(cx.observe(run, |this, _, cx| this.load(cx)));
        }
        let mut this = Self {
            row,
            generation,
            run,
            model: None,
            error: None,
            _load: None,
            prompt_expanded: false,
            copied: CopiedMark::default(),
            results,
            _subscriptions: subscriptions,
        };
        this.load(cx);
        this
    }

    pub fn row_id(&self) -> &str {
        &self.row.id
    }

    /// The freshest row: `get`'s answer, or the grid's copy until there is one.
    /// `None` once the row is gone.
    fn current(&self, cx: &App) -> Option<ApiGeneration> {
        match self.generation.read(cx).state() {
            QueryState::Ready { data, .. } => data.as_ref().clone(),
            QueryState::Loading | QueryState::Failed(_) => Some((*self.row).clone()),
        }
    }

    /// Lays the sections out again for the current row and pod.
    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(row) = self.current(cx) else {
            self.model = None;
            cx.notify();
            return;
        };
        let pod = self
            .run
            .as_ref()
            .and_then(|run| run.read(cx).data().cloned())
            .and_then(|pod| pod.as_ref().clone());
        let task = meta::details::<DetailsModel>(&row, pod.as_ref(), cx);
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(model) => {
                        this.model = Some(Rc::new(model));
                        this.error = None;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "could not lay out the generation details");
                        this.error = Some(error.to_string().into());
                    }
                }
                cx.notify();
            });
        }));
    }

    fn copy(&mut self, key: &'static str, text: String, cx: &mut Context<Self>) {
        self.copied
            .copy(key.into(), text, |this: &mut Self| &mut this.copied, cx);
    }

    fn render_header(&self, model: Option<&DetailsModel>, cx: &App) -> impl IntoElement {
        v_flex()
            .gap_0p5()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child("Details"),
            )
            .when_some(model, |this, model| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .truncate()
                        .child(format!("{} · {}", model.badge, model.created)),
                )
            })
    }

    fn render_references(&self, model: &DetailsModel, cx: &App) -> Option<AnyElement> {
        if model.references.is_empty() && !model.references_missing {
            return None;
        }
        let title = if model.self_hosted {
            "Input images"
        } else {
            "References"
        };
        let urls = Media::urls(cx);
        let theme = cx.theme();
        let body: AnyElement = if model.references.is_empty() {
            muted_text("The original image was not saved.", cx).into_any_element()
        } else {
            h_flex()
                .flex_wrap()
                .gap_2()
                .children(model.references.iter().enumerate().map(|(ix, reference)| {
                    let image_url: SharedString = urls.original(&reference.key).into();
                    let results = self.results.clone();
                    let open_results = self.results.clone();
                    let (open_key, open_source, open_label) = (
                        reference.key.clone(),
                        reference.source_key.clone(),
                        reference.label.clone(),
                    );
                    v_flex()
                        .w(rems(5.5))
                        .gap_1()
                        .child(
                            div()
                                .id(("open-reference", ix))
                                .size(rems(5.5))
                                .overflow_hidden()
                                .rounded(theme.radius)
                                .bg(theme.muted)
                                .cursor_pointer()
                                .tooltip(|window, cx| {
                                    gpui_kit::component::tooltip::Tooltip::new("Open reference")
                                        .build(window, cx)
                                })
                                .on_click(move |_, window, cx| {
                                    let reference =
                                        super::reference_viewer::ViewerReference::from_key(
                                            &open_key,
                                            open_source.as_deref(),
                                            open_label.clone(),
                                            cx,
                                        );
                                    let _ = open_results.update(cx, |results, cx| {
                                        results.open_reference(reference, window, cx)
                                    });
                                })
                                .child(
                                    img(media_image(
                                        ImageRequest::new(urls.thumb(&reference.key))
                                            .max_dimension(THUMB_MAX_DIMENSION),
                                    ))
                                    .size_full()
                                    .object_fit(ObjectFit::Cover),
                                ),
                        )
                        .child(
                            h_flex()
                                .gap_0p5()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(reference.label.clone()),
                                )
                                .child(
                                    Button::new(("use-reference", ix))
                                        .ghost()
                                        .xsmall()
                                        .icon(IconName::ImagePlus)
                                        .tooltip("Use as reference")
                                        .on_click(move |_, window, cx| {
                                            let image_url = image_url.clone();
                                            let _ = results.update(cx, |results, cx| {
                                                results.use_reference_from_viewer(
                                                    image_url, window, cx,
                                                )
                                            });
                                        }),
                                ),
                        )
                }))
                .into_any_element()
        };
        Some(section(title, cx).child(body).into_any_element())
    }

    fn render_timing(&self, timing: &Timing, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let render_color = phase_color("render", cx);
        section("Time", cx)
            .when_some(timing.total.clone(), |this, total| {
                this.child(
                    h_flex()
                        .justify_between()
                        .gap_3()
                        .child(muted_text(timing.total_label.clone(), cx))
                        .child(
                            div()
                                .text_base()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(total),
                        ),
                )
            })
            .when(!timing.phases.is_empty(), |this| {
                this.child(
                    h_flex()
                        .h_1p5()
                        .w_full()
                        .overflow_hidden()
                        .rounded_full()
                        .bg(theme.muted)
                        .children(timing.phases.iter().map(|phase| {
                            div()
                                .h_full()
                                .w(relative(phase.share))
                                .bg(phase_color(&phase.key, cx))
                        })),
                )
                .child(
                    v_flex()
                        .gap_1p5()
                        .children(timing.phases.iter().map(|phase| {
                            v_flex()
                                .gap_1p5()
                                .child(
                                    h_flex()
                                        .justify_between()
                                        .gap_3()
                                        .text_xs()
                                        .child(
                                            h_flex()
                                                .min_w_0()
                                                .gap_2()
                                                .child(
                                                    div()
                                                        .size_2()
                                                        .flex_shrink_0()
                                                        .rounded_full()
                                                        .bg(phase_color(&phase.key, cx)),
                                                )
                                                .child(phase.label.clone()),
                                        )
                                        .child(phase.duration.clone()),
                                )
                                .when(phase.key == "render" && !timing.stages.is_empty(), |this| {
                                    this.child(
                                        v_flex()
                                            .ml_4()
                                            .pl_3()
                                            .gap_1()
                                            .border_l_1()
                                            .border_color(theme.border)
                                            .children(timing.stages.iter().map(|stage| {
                                                v_flex()
                                                    .gap_0p5()
                                                    .child(
                                                        h_flex()
                                                            .justify_between()
                                                            .gap_3()
                                                            .text_xs()
                                                            .child(
                                                                div()
                                                                    .min_w_0()
                                                                    .text_color(
                                                                        theme.muted_foreground,
                                                                    )
                                                                    .child(stage.label.clone())
                                                                    .when_some(
                                                                        stage.detail.clone(),
                                                                        |this, detail| {
                                                                            this.child(format!(
                                                                                " · {detail}"
                                                                            ))
                                                                        },
                                                                    ),
                                                            )
                                                            .child(stage.duration.clone()),
                                                    )
                                                    .child(
                                                        div()
                                                            .h_1()
                                                            .w_full()
                                                            .overflow_hidden()
                                                            .rounded_full()
                                                            .bg(theme.muted)
                                                            .child(
                                                                div()
                                                                    .h_full()
                                                                    .w(relative(stage.share))
                                                                    .rounded_full()
                                                                    .bg(render_color.opacity(0.6)),
                                                            ),
                                                    )
                                            })),
                                    )
                                })
                        })),
                )
            })
            .children(timing.notes.iter().map(|note| muted_text(note.clone(), cx)))
            .into_any_element()
    }

    fn render_rows(
        &self,
        title: &'static str,
        rows: &[DetailRow],
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        section(title, cx)
            .child(v_flex().gap_1p5().children(rows.iter().map(|row| {
                let copied = self.copied.is("seed");
                h_flex()
                    .justify_between()
                    .items_start()
                    .gap_3()
                    .text_xs()
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_color(theme.muted_foreground)
                            .child(row.label.clone()),
                    )
                    .child(
                        h_flex()
                            .min_w_0()
                            .justify_end()
                            .gap_1()
                            .child(
                                div()
                                    .min_w_0()
                                    .text_right()
                                    .when(row.mono, |this| {
                                        this.font_family(theme.mono_font_family.clone())
                                    })
                                    .child(row.value.clone()),
                            )
                            .when_some(row.note.clone(), |this, note| {
                                this.child(div().text_color(theme.muted_foreground).child(note))
                            })
                            .when_some(row.copy.clone(), |this, text| {
                                this.child(
                                    Button::new("copy-seed")
                                        .ghost()
                                        .xsmall()
                                        .icon(if copied {
                                            IconName::Check
                                        } else {
                                            IconName::Copy
                                        })
                                        .tooltip(if copied { "Copied" } else { "Copy seed" })
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.copy("seed", text.clone(), cx)
                                        })),
                                )
                            }),
                    )
            })))
            .into_any_element()
    }

    fn render_prompt(&self, prompt: &str, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let long = prompt.chars().count() > LONG_PROMPT_CHARS
            || prompt.lines().count() > LONG_PROMPT_LINES;
        let copied = self.copied.is("prompt");
        let text = prompt.to_string();
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .justify_between()
                    .child(section_title("Prompt", cx))
                    .child(
                        Button::new("copy-prompt")
                            .ghost()
                            .xsmall()
                            .icon(if copied {
                                IconName::Check
                            } else {
                                IconName::Copy
                            })
                            .tooltip(if copied { "Copied" } else { "Copy prompt" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.copy("prompt", text.clone(), cx)
                            })),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.foreground)
                    .when(long && !self.prompt_expanded, |this| {
                        this.line_clamp(LONG_PROMPT_LINES)
                    })
                    .child(prompt.to_string()),
            )
            .when(long, |this| {
                this.child(
                    Button::new("expand-prompt")
                        .ghost()
                        .xsmall()
                        .self_start()
                        .label(if self.prompt_expanded {
                            "Show less"
                        } else {
                            "Show all"
                        })
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.prompt_expanded = !this.prompt_expanded;
                            cx.notify();
                        })),
                )
            })
            .into_any_element()
    }
}

impl Render for GenerationDetails {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self.current(cx);
        let model = self.model.clone();
        let body: AnyElement = match (&current, &model) {
            (None, _) => {
                muted_text("This generation is no longer available.", cx).into_any_element()
            }
            (Some(_), None) => match &self.error {
                Some(error) => muted_text(error.clone(), cx).into_any_element(),
                None => h_flex()
                    .gap_2()
                    .child(Spinner::new().small())
                    .child(muted_text("Loading details…", cx))
                    .into_any_element(),
            },
            (Some(row), Some(model)) => v_flex()
                .gap_5()
                .children(self.render_references(model, cx))
                .children(
                    model
                        .timing
                        .as_ref()
                        .map(|timing| self.render_timing(timing, cx)),
                )
                .children(
                    model
                        .gpu
                        .as_ref()
                        .map(|rows| self.render_rows("GPU", rows, cx)),
                )
                .when(!model.settings.is_empty(), |this| {
                    this.child(self.render_rows("Settings", &model.settings, cx))
                })
                .when(!row.prompt.trim().is_empty(), |this| {
                    this.child(self.render_prompt(&row.prompt, cx))
                })
                .into_any_element(),
        };
        v_flex()
            .id("generation-details")
            .size_full()
            .overflow_y_scroll()
            .p_4()
            .gap_4()
            .child(self.render_header(model.as_deref(), cx))
            .child(body)
    }
}

fn section_title(title: &'static str, cx: &App) -> impl IntoElement {
    div()
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(cx.theme().muted_foreground)
        .child(title)
}

fn section(title: &'static str, cx: &App) -> gpui_kit::Div {
    v_flex().gap_2().child(section_title(title, cx))
}

fn muted_text(text: impl Into<SharedString>, cx: &App) -> impl IntoElement {
    div()
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .child(text.into())
}

/// The run's phases as one categorical series, in order.
fn phase_color(key: &str, cx: &App) -> Hsla {
    let theme = cx.theme();
    match key {
        "prepare" => theme.chart_1,
        "queue" => theme.chart_2,
        "render" => theme.chart_3,
        _ => theme.chart_4,
    }
}

#[cfg(test)]
mod tests {
    use super::DetailsModel;

    #[test]
    fn decodes_what_api_results_ts_returns() {
        let model: DetailsModel = serde_json::from_value(serde_json::json!({
            "badge": "H3 · h3",
            "created": "Nov 15, 2023, 2:13 AM",
            "selfHosted": true,
            "references": [
                { "key": "grok-references/a.jpg", "sourceKey": "generations/a.png", "label": "First frame" },
                { "key": "grok-references/b.jpg", "sourceKey": null, "label": "Picture 1" }
            ],
            "referencesMissing": false,
            "timing": {
                "totalLabel": "Total time",
                "total": "1 min 00 s",
                "phases": [{ "key": "render", "label": "Rendering on the GPU", "duration": "48 s", "share": 0.8 }],
                "stages": [{ "label": "Sampling", "detail": null, "duration": "40 s", "share": 0.9 }],
                "notes": []
            },
            "gpu": [{ "label": "Pod id", "value": "pod1", "mono": true }],
            "settings": [{ "label": "Seed", "value": "42", "copy": "42" }]
        }))
        .unwrap();
        assert_eq!(model.references[0].label, "First frame");
        assert_eq!(
            model.references[0].source_key.as_deref(),
            Some("generations/a.png")
        );
        assert_eq!(model.references[1].source_key, None);
        assert!(model.gpu.unwrap()[0].mono);
        assert_eq!(model.settings[0].copy.as_deref(), Some("42"));
        assert_eq!(model.timing.unwrap().phases[0].share, 0.8);
    }
}
