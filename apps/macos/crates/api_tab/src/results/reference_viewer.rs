//! A reference image opened from the viewer's details panel (the web's
//! `ReferenceViewer` in generation-lightbox.tsx): the image at size, the
//! generation it came from when it is one of the app's outputs, what can be
//! done with that, and that generation's own references — each of which opens
//! one level deeper, with Back to return.
//!
//! It is a dialog over the viewer: Escape closes it and leaves the viewer as
//! it was; every action that takes you to a form closes both.

use artsnack_library::{FavoriteHearts, MediaCommand, ReproduceSource};
use artsnack_media::{ImageRequest, Media, media_image};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ObjectFit, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledImage as _, Subscription, Task, WeakEntity, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        spinner::Spinner,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
    px, rems,
};
use serde::Deserialize;

use super::{ApiResults, ApiResultsEvent, ResultsKind, meta};
use crate::reference_source::{Lookup, Reproduce, Source, find_source, output_key};

/// The image is decoded to at most this size.
const IMAGE_MAX_DIMENSION: u32 = 1600;
/// Reference thumbnails in the side panel.
const THUMB_MAX_DIMENSION: u32 = 256;

/// One image to show.
#[derive(Clone, Debug)]
pub(crate) struct ViewerReference {
    /// The original, full size.
    pub url: SharedString,
    /// Its object key, when it is one of the app's outputs.
    pub key: Option<String>,
    /// "First frame", "Reference 2".
    pub label: Option<SharedString>,
}

impl ViewerReference {
    /// A generation's input image: shown from its stored copy `key`, looked
    /// up by `source_key`, the output it was taken from (the web's
    /// `reference.sourceKey ?? referenceOutputKey(reference.url)`).
    pub fn from_key(
        key: &str,
        source_key: Option<&str>,
        label: impl Into<SharedString>,
        cx: &App,
    ) -> Self {
        let url = Media::urls(cx).original(key);
        let lookup = source_key
            .filter(|source| crate::reference_source::is_output_key(source, cx))
            .map(str::to_string)
            .or_else(|| output_key(&url, cx));
        Self {
            url: url.into(),
            key: lookup,
            label: Some(label.into()),
        }
    }

    fn from_url(url: &str, cx: &App) -> Self {
        Self {
            url: url.to_string().into(),
            key: output_key(url, cx),
            label: None,
        }
    }

    /// A smaller copy for a thumbnail: the CDN's preview when it is ours.
    fn thumb(&self, cx: &App) -> SharedString {
        match Media::urls(cx).key_of(&self.url) {
            Some(key) => Media::urls(cx).thumb(key).into(),
            None => self.url.clone(),
        }
    }
}

/// The source's own references (`ReferencePanel`).
enum Inputs {
    /// No source, or one with nothing to list.
    None,
    Loading,
    Ready(Vec<ViewerReference>),
    /// The row had references but they were not saved.
    Missing,
}

/// The slice of `apiResults.details` this needs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailsReferences {
    #[serde(default)]
    references: Vec<KeyedReference>,
    #[serde(default)]
    references_missing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyedReference {
    key: String,
    source_key: Option<String>,
    label: String,
}

/// One level of the trail.
struct Frame {
    reference: ViewerReference,
    lookup: Lookup,
    inputs: Inputs,
    _task: Option<Task<()>>,
}

pub(crate) struct ReferenceViewer {
    trail: Vec<Frame>,
    results: WeakEntity<ApiResults>,
    hearts: Entity<FavoriteHearts>,
    _hearts: Subscription,
}

impl ReferenceViewer {
    /// Opens `reference` in a dialog over the results viewer.
    pub fn open(
        reference: ViewerReference,
        results: WeakEntity<ApiResults>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let viewer = cx.new(|cx| {
            let hearts = cx.new(FavoriteHearts::new);
            let observe_hearts = cx.observe(&hearts, |_, _, cx| cx.notify());
            let mut this = Self {
                trail: Vec::new(),
                results,
                hearts,
                _hearts: observe_hearts,
            };
            this.push(reference, cx);
            this
        });
        window.open_dialog(cx, move |dialog, _, _| {
            dialog.title("Reference").w(px(1040.)).child(viewer.clone())
        });
    }

    fn push(&mut self, reference: ViewerReference, cx: &mut Context<Self>) {
        let lookup = if reference.key.is_some() {
            Lookup::Finding
        } else {
            Lookup::NotOurs
        };
        self.trail.push(Frame {
            reference,
            lookup,
            inputs: Inputs::None,
            _task: None,
        });
        self.find(cx);
    }

    fn back(&mut self, cx: &mut Context<Self>) {
        if self.trail.len() > 1 {
            self.trail.pop();
            cx.notify();
        }
    }

    /// Looks up the top frame's generation, then that generation's inputs.
    fn find(&mut self, cx: &mut Context<Self>) {
        let depth = self.trail.len();
        let Some(frame) = self.trail.last_mut() else {
            return;
        };
        let Some(key) = frame.reference.key.clone() else {
            return;
        };
        frame.lookup = Lookup::Finding;
        frame.inputs = Inputs::None;
        cx.notify();
        frame._task = Some(cx.spawn(async move |this, cx| {
            let outcome = find_source(&key, cx).await;
            let found = outcome.as_ref().ok().cloned().flatten();
            let _ = this.update(cx, |this, cx| {
                let Some(frame) = this.trail.get_mut(depth - 1) else {
                    return;
                };
                frame.lookup = match outcome {
                    Ok(Some(source)) => Lookup::Found(source),
                    Ok(None) => Lookup::Missing,
                    Err(error) => Lookup::Failed(error.user_message()),
                };
                frame.inputs = match &found {
                    Some(Source::Api(_)) => Inputs::Loading,
                    Some(Source::Enhancement(row)) => {
                        let url = row
                            .source_b2_key
                            .as_deref()
                            .map(|key| Media::urls(cx).original(key))
                            .unwrap_or_else(|| row.source_image_url.clone());
                        let loadable = row.source_b2_key.is_some()
                            || url.starts_with("http://")
                            || url.starts_with("https://");
                        if loadable {
                            let mut reference = ViewerReference::from_url(&url, cx);
                            if let Some(key) = &row.source_b2_key {
                                reference.key = output_key(&Media::urls(cx).original(key), cx);
                            }
                            Inputs::Ready(vec![reference])
                        } else {
                            Inputs::None
                        }
                    }
                    _ => Inputs::None,
                };
                cx.notify();
            });
            let Some(Source::Api(row)) = found else {
                return;
            };
            let details = cx.update(|cx| meta::details::<DetailsReferences>(&row, None, cx));
            let details = details.await;
            let _ = this.update(cx, |this, cx| {
                let Some(frame) = this.trail.get_mut(depth - 1) else {
                    return;
                };
                frame.inputs = match details {
                    Ok(details) if !details.references.is_empty() => Inputs::Ready(
                        details
                            .references
                            .iter()
                            .map(|reference| {
                                ViewerReference::from_key(
                                    &reference.key,
                                    reference.source_key.as_deref(),
                                    reference.label.clone(),
                                    cx,
                                )
                            })
                            .collect(),
                    ),
                    Ok(details) if details.references_missing => Inputs::Missing,
                    Ok(_) => Inputs::None,
                    Err(error) => {
                        tracing::warn!(?error, "could not read the source's references");
                        Inputs::None
                    }
                };
                cx.notify();
            });
        }));
    }

    // --- Actions --------------------------------------------------------

    /// Closes this dialog and the viewer under it, then runs `then` on the
    /// results view (which hands the work to the composer or another screen).
    fn leave(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut ApiResults, &mut Window, &mut Context<ApiResults>),
    ) {
        window.close_dialog(cx);
        let _ = self.results.update(cx, |results, cx| {
            results.close_lightbox(window, cx);
            then(results, window, cx);
        });
    }

    fn use_reference(
        &self,
        url: SharedString,
        as_video: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.leave(window, cx, move |_, _, cx| {
            cx.emit(ApiResultsEvent::UseAsReference {
                image_url: url,
                as_video,
            })
        });
    }

    fn reproduce(&self, source: &Source, window: &mut Window, cx: &mut Context<Self>) {
        let reproduce = source.reproduce();
        self.leave(window, cx, move |results, _, cx| {
            let event = match reproduce {
                // The API tab's grid hands it to its own composer; the video
                // tab's would restore it into the clip form, so from there it
                // goes to the API tab like any other screen's Reproduce.
                Reproduce::Api(row) if results.kind == ResultsKind::Api => {
                    ApiResultsEvent::Reproduce(row)
                }
                Reproduce::Api(row) => {
                    ApiResultsEvent::Media(MediaCommand::Reproduce(ReproduceSource::Api {
                        generation_id: row.id.clone(),
                    }))
                }
                Reproduce::Elsewhere(command) => ApiResultsEvent::Media(command),
            };
            cx.emit(event)
        });
    }

    fn send_to_enhance(&self, frame: &Frame, window: &mut Window, cx: &mut Context<Self>) {
        let form_state = match frame.lookup.source() {
            Some(Source::SelfHosted(row)) => Some(row.form_state.to_value()),
            _ => None,
        };
        let command = MediaCommand::Enhance {
            image_url: frame.reference.url.clone(),
            form_state,
        };
        self.leave(window, cx, move |_, _, cx| {
            cx.emit(ApiResultsEvent::Media(command))
        });
    }

    // --- Rendering ------------------------------------------------------

    fn render_actions(&self, frame: &Frame, cx: &mut Context<Self>) -> AnyElement {
        let source = frame.lookup.source().cloned();
        let url = frame.reference.url.clone();
        let video_url = url.clone();
        let mut row = h_flex()
            .gap_1()
            .flex_wrap()
            .justify_center()
            .child(
                Button::new("viewer-reference")
                    .ghost()
                    .small()
                    .icon(IconName::ImagePlus)
                    .label("Use as reference")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.use_reference(url.clone(), false, window, cx)
                    })),
            )
            .child(
                Button::new("viewer-video")
                    .ghost()
                    .small()
                    .icon(IconName::Film)
                    .label("Make video")
                    .tooltip("Make video from this image")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.use_reference(video_url.clone(), true, window, cx)
                    })),
            );
        if let Some(source) = source.clone() {
            row = row.child(
                Button::new("viewer-reproduce")
                    .ghost()
                    .small()
                    .icon(IconName::RefreshCw)
                    .label("Reproduce")
                    .on_click(
                        cx.listener(move |this, _, window, cx| this.reproduce(&source, window, cx)),
                    ),
            );
        }
        row = row.child(
            Button::new("viewer-enhance")
                .ghost()
                .small()
                .icon(IconName::Zap)
                .label("Send to Enhance")
                .on_click(cx.listener(|this, _, window, cx| {
                    if let Some(frame) = this.trail.last() {
                        this.send_to_enhance(frame, window, cx)
                    }
                })),
        );
        if let (Some(source), Some(key)) = (source, frame.reference.key.clone()) {
            let favorited = self.hearts.read(cx).is_favorited(&key);
            let hearts = self.hearts.clone();
            row = row.child(
                Button::new("viewer-favorite")
                    .ghost()
                    .small()
                    .icon(if favorited {
                        IconName::HeartOff
                    } else {
                        IconName::Heart
                    })
                    .tooltip(if favorited {
                        "Remove from favorites"
                    } else {
                        "Add to favorites"
                    })
                    .on_click(move |_, window, cx| {
                        let args = source.toggle_args(&key);
                        hearts.update(cx, |hearts, cx| hearts.toggle(args, window, cx));
                    }),
            );
        }
        row.into_any_element()
    }

    fn render_source_card(&self, frame: &Frame, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let status: AnyElement = match &frame.lookup {
            Lookup::Finding => h_flex()
                .gap_1()
                .child(Spinner::new().xsmall())
                .child("Finding generation…")
                .into_any_element(),
            Lookup::Failed(message) => Button::new("viewer-retry")
                .ghost()
                .xsmall()
                .label("Lookup failed. Retry")
                .tooltip(message.clone())
                .on_click(cx.listener(|this, _, _, cx| this.find(cx)))
                .into_any_element(),
            Lookup::Found(_) => div()
                .child("Generation settings available")
                .into_any_element(),
            Lookup::Missing => div()
                .child(
                    "Original generation is unavailable. You can still use this saved reference.",
                )
                .into_any_element(),
            Lookup::NotOurs => div()
                .child("No generation settings were saved for this reference.")
                .into_any_element(),
        };
        v_flex()
            .gap_1()
            .p_3()
            .rounded(cx.theme().radius)
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().muted)
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .child("Source image"),
            )
            .child(div().text_xs().text_color(muted).child(status))
            .into_any_element()
    }

    fn render_inputs(&self, frame: &Frame, cx: &mut Context<Self>) -> Option<AnyElement> {
        let muted = cx.theme().muted_foreground;
        let body: AnyElement = match &frame.inputs {
            Inputs::None => return None,
            Inputs::Loading => div()
                .text_xs()
                .text_color(muted)
                .child("Loading references…")
                .into_any_element(),
            Inputs::Missing => div()
                .text_xs()
                .text_color(muted)
                .child("The original reference was not saved.")
                .into_any_element(),
            Inputs::Ready(references) => v_flex()
                .gap_2()
                .children(references.iter().enumerate().map(|(ix, reference)| {
                    let open = reference.clone();
                    let use_url = reference.url.clone();
                    v_flex()
                        .gap_1()
                        .child(
                            div()
                                .id(("viewer-input", ix))
                                .w_full()
                                .h(rems(7.))
                                .overflow_hidden()
                                .rounded(cx.theme().radius)
                                .bg(cx.theme().muted)
                                .cursor_pointer()
                                .child(
                                    img(media_image(
                                        ImageRequest::new(reference.thumb(cx))
                                            .max_dimension(THUMB_MAX_DIMENSION),
                                    ))
                                    .size_full()
                                    .object_fit(ObjectFit::Cover),
                                )
                                .tooltip(|window, cx| {
                                    gpui_kit::component::tooltip::Tooltip::new("Open reference")
                                        .build(window, cx)
                                })
                                .on_click(
                                    cx.listener(move |this, _, _, cx| this.push(open.clone(), cx)),
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
                                        .text_color(muted)
                                        .child(
                                            reference
                                                .label
                                                .clone()
                                                .unwrap_or_else(|| "Source image".into()),
                                        ),
                                )
                                .child(
                                    Button::new(("viewer-use-input", ix))
                                        .ghost()
                                        .xsmall()
                                        .icon(IconName::ImagePlus)
                                        .tooltip("Use as reference")
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.use_reference(use_url.clone(), false, window, cx)
                                        })),
                                ),
                        )
                }))
                .into_any_element(),
        };
        Some(
            v_flex()
                .gap_2()
                .child(
                    div()
                        .text_sm()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child("References"),
                )
                .child(body)
                .into_any_element(),
        )
    }
}

impl Render for ReferenceViewer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(frame) = self.trail.last() else {
            return div().into_any_element();
        };
        let depth = self.trail.len();
        let image = img(media_image(
            ImageRequest::new(frame.reference.url.clone()).max_dimension(IMAGE_MAX_DIMENSION),
        ))
        .max_w_full()
        .max_h_full()
        .object_fit(ObjectFit::Contain);
        let actions = self.render_actions(frame, cx);
        let source_card = self.render_source_card(frame, cx);
        let inputs = self.render_inputs(frame, cx);
        let label = frame.reference.label.clone();
        v_flex()
            .gap_3()
            .when(depth > 1 || label.is_some(), |this| {
                this.child(
                    h_flex()
                        .gap_2()
                        .when(depth > 1, |this| {
                            this.child(
                                Button::new("viewer-back")
                                    .ghost()
                                    .small()
                                    .icon(IconName::ArrowLeft)
                                    .label("Back")
                                    .on_click(cx.listener(|this, _, _, cx| this.back(cx))),
                            )
                        })
                        .when_some(label, |this, label| {
                            this.child(
                                div()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(label),
                            )
                        }),
                )
            })
            .child(
                h_flex()
                    .gap_4()
                    .items_start()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_3()
                            .child(
                                div()
                                    .h(px(600.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(image),
                            )
                            .child(actions),
                    )
                    .child(
                        v_flex()
                            .id("viewer-side")
                            .w(rems(12.))
                            .max_h(px(640.))
                            .overflow_y_scroll()
                            .gap_3()
                            .child(source_card)
                            .children(inputs),
                    ),
            )
            .into_any_element()
    }
}
