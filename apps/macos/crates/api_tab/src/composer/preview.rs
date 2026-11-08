//! A reference at full size, and — when it is one of the app's own outputs —
//! the generation that made it, with what can be done with that (the web's
//! reference-preview.tsx). The generation is found the way the web finds it:
//! reading the history a page at a time until a row lists the key.

use std::sync::Arc;

use artsnack_backend::{
    Backend,
    api::{
        generations::Generation,
        grok_generations::{self, ApiGeneration, IdArgs},
    },
};
use artsnack_library::{FavoriteHearts, MediaCommand};
use artsnack_media::Media;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, ImageSource, IntoElement, ObjectFit,
    ParentElement as _, Render, RenderImage, SharedString, Styled as _, StyledImage as _,
    Subscription, Task, WeakEntity, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariant, ButtonVariants as _},
        h_flex,
        notification::Notification,
        spinner::Spinner,
        v_flex,
    },
    div, img, px,
};

use super::{ApiComposer, ComposerEvent};
use crate::{
    reference_source::{Lookup, Reproduce, Source, find_source},
    results::meta,
};

pub struct ReferencePreview {
    /// Decoded for this dialog alone; it leaves the GPU atlas with the dialog
    /// (`_release`), since GPUI keeps a drawn image there until told.
    image: Arc<RenderImage>,
    caption: SharedString,
    reference_id: SharedString,
    selected: bool,
    key: Option<String>,
    lookup: Lookup,
    /// The viewer's price line, for an API row.
    price: Option<SharedString>,
    hearts: Entity<FavoriteHearts>,
    composer: WeakEntity<ApiComposer>,
    _task: Option<Task<()>>,
    _hearts: Subscription,
    _release: Subscription,
}

impl ReferencePreview {
    pub fn new(
        image: Arc<RenderImage>,
        caption: SharedString,
        reference_id: SharedString,
        selected: bool,
        key: Option<String>,
        composer: WeakEntity<ApiComposer>,
        cx: &mut Context<Self>,
    ) -> Self {
        let hearts = cx.new(FavoriteHearts::new);
        let observe_hearts = cx.observe(&hearts, |_, _, cx| cx.notify());
        let release = cx.on_release(|this: &mut Self, cx| {
            let image = this.image.clone();
            // Deferred to where no window is being updated, so every window's
            // atlas is reached.
            cx.defer(move |cx| cx.drop_image(image, None));
        });
        let mut this = Self {
            image,
            caption,
            reference_id,
            selected,
            lookup: if key.is_some() {
                Lookup::Finding
            } else {
                Lookup::NotOurs
            },
            key,
            price: None,
            hearts,
            composer,
            _task: None,
            _hearts: observe_hearts,
            _release: release,
        };
        this.find(cx);
        this
    }

    fn find(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.key.clone() else {
            return;
        };
        self.lookup = Lookup::Finding;
        cx.notify();
        self._task = Some(cx.spawn(async move |this, cx| {
            let outcome = find_source(&key, cx).await;
            let price = match &outcome {
                Ok(Some(Source::Api(row))) => {
                    let labels = cx.update(|cx| meta::rows_meta(vec![meta::row_json(row)], cx));
                    labels
                        .await
                        .ok()
                        .and_then(|labels| labels.into_iter().next())
                        .and_then(|label| label.price_tag)
                }
                _ => None,
            };
            let _ = this.update(cx, |this, cx| {
                this.price = price.map(Into::into);
                this.lookup = match outcome {
                    Ok(Some(source)) => Lookup::Found(source),
                    Ok(None) => Lookup::Missing,
                    Err(error) => Lookup::Failed(error.user_message()),
                };
                cx.notify();
            });
        }));
    }

    fn close(window: &mut Window, cx: &mut gpui_kit::App) {
        window.close_dialog(cx);
    }

    fn reproduce(&self, source: &Source, window: &mut Window, cx: &mut Context<Self>) {
        Self::close(window, cx);
        let reproduce = source.reproduce();
        let _ = self.composer.update(cx, |composer, cx| match reproduce {
            Reproduce::Api(row) => composer.reproduce(row, cx),
            Reproduce::Elsewhere(command) => cx.emit(ComposerEvent::Media(command)),
        });
    }

    fn send_to_enhance(
        &self,
        row: &Generation,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        Self::close(window, cx);
        let command = MediaCommand::Enhance {
            image_url: Media::urls(cx).original(key).into(),
            form_state: Some(row.form_state.to_value()),
        };
        let _ = self
            .composer
            .update(cx, |_, cx| cx.emit(ComposerEvent::Media(command)));
    }

    fn toggle_favorite(
        &self,
        source: &Source,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let args = source.toggle_args(key);
        self.hearts
            .update(cx, |hearts, cx| hearts.toggle(args, window, cx));
    }

    fn use_as_reference(
        &self,
        key: &str,
        to_video: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        Self::close(window, cx);
        let url: SharedString = Media::urls(cx).original(key).into();
        let key = key.to_string();
        let _ = self.composer.update(cx, |composer, cx| {
            composer.attach_url(url, Some(key), Some(to_video), cx)
        });
    }

    /// Deletes the row the way the results grid does (same questions), then
    /// closes the preview.
    fn delete(&self, row: &ApiGeneration, window: &mut Window, cx: &mut Context<Self>) {
        let id = row.id.clone();
        let key = self.key.clone();
        let (title, description, ok) = if row.is_running() {
            (
                "Remove this from the results?",
                "The job cannot be cancelled: it will still run and still be charged for, you just won't get the result.",
                "Remove",
            )
        } else {
            (
                "Delete this generation?",
                "The media goes with it.",
                "Delete",
            )
        };
        window.open_alert_dialog(cx, move |alert, _, _| {
            let id = id.clone();
            let key = key.clone();
            alert
                .title(title)
                .description(description)
                .confirm()
                .ok_text(ok)
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let task = Backend::global(cx).update(cx, |backend, cx| {
                        backend.mutate(grok_generations::REMOVE, &IdArgs { id: id.clone() }, cx)
                    });
                    // The preview under this question goes now, not a round
                    // trip later; a failure says so. Dialogs close from the
                    // top: this closes the question, returning `true` the
                    // preview beneath it.
                    window.close_dialog(cx);
                    let window_handle = window.window_handle();
                    let key = key.clone();
                    cx.spawn(async move |cx| {
                        let result = task.await;
                        let _ = window_handle.update(cx, |_, window, cx| match result {
                            Ok(()) => {
                                if let Some(key) = &key {
                                    crate::reference_source::forget(key, cx);
                                }
                            }
                            Err(error) => window.push_notification(
                                Notification::error(format!(
                                    "Couldn\u{2019}t delete the generation. {}",
                                    error.user_message()
                                )),
                                cx,
                            ),
                        });
                    })
                    .detach();
                    true
                })
        });
    }

    fn render_source(&self, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        match &self.lookup {
            Lookup::NotOurs => div()
                .text_sm()
                .text_color(muted)
                .child("No generation settings for this reference")
                .into_any_element(),
            Lookup::Finding => h_flex()
                .gap_2()
                .text_sm()
                .text_color(muted)
                .child(Spinner::new().small())
                .child("Finding generation…")
                .into_any_element(),
            Lookup::Failed(message) => Button::new("preview-retry")
                .ghost()
                .small()
                .label("Lookup failed. Retry")
                .tooltip(message.clone())
                .on_click(cx.listener(|this, _, _, cx| this.find(cx)))
                .into_any_element(),
            Lookup::Missing => div()
                .text_sm()
                .text_color(muted)
                .child("Original generation is unavailable")
                .into_any_element(),
            Lookup::Found(source) => {
                let key = self.key.clone().unwrap_or_default();
                let favorited = self.hearts.read(cx).is_favorited(&key);
                let mut row = h_flex().gap_1().flex_wrap().items_center();
                if let Some(price) = self.price.clone() {
                    row = row.child(div().mr_2().text_sm().text_color(muted).child(price));
                }
                let reproduce_source = source.clone();
                row = row.child(
                    Button::new("preview-reproduce")
                        .ghost()
                        .small()
                        .icon(IconName::RefreshCw)
                        .label("Reproduce")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.reproduce(&reproduce_source, window, cx)
                        })),
                );
                if let Source::SelfHosted(generation) = source {
                    let (generation, key) = (generation.clone(), key.clone());
                    row = row.child(
                        Button::new("preview-enhance")
                            .ghost()
                            .small()
                            .icon(IconName::Zap)
                            .label("Send to Enhance")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.send_to_enhance(&generation, &key, window, cx)
                            })),
                    );
                }
                let (favorite_source, favorite_key) = (source.clone(), key.clone());
                row = row.child(
                    Button::new("preview-favorite")
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
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.toggle_favorite(&favorite_source, &favorite_key, window, cx)
                        })),
                );
                let reference_key = key.clone();
                row = row.child(
                    Button::new("preview-reference")
                        .ghost()
                        .small()
                        .icon(IconName::ImagePlus)
                        .label("Use as reference")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.use_as_reference(&reference_key, false, window, cx)
                        })),
                );
                if let Source::Api(generation) = source {
                    let video_key = key.clone();
                    let generation = generation.clone();
                    row = row
                        .child(
                            Button::new("preview-video")
                                .ghost()
                                .small()
                                .icon(IconName::Film)
                                .label("Make video")
                                .tooltip("Make video from this image")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.use_as_reference(&video_key, true, window, cx)
                                })),
                        )
                        .child(
                            Button::new("preview-delete")
                                .ghost()
                                .small()
                                .icon(IconName::Trash)
                                .label("Delete")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.delete(&generation, window, cx)
                                })),
                        );
                }
                row.into_any_element()
            }
        }
    }
}

impl Render for ReferencePreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (toggle_id, remove_id) = (self.reference_id.clone(), self.reference_id.clone());
        let selected = self.selected;
        let composer = self.composer.clone();
        let remove_composer = self.composer.clone();
        v_flex()
            .gap_3()
            .child(
                div()
                    .h(px(560.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        img(ImageSource::Render(self.image.clone()))
                            .max_w_full()
                            .max_h_full()
                            .object_fit(ObjectFit::Contain),
                    ),
            )
            .child(self.render_source(cx))
            .child(
                h_flex()
                    .justify_between()
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(self.caption.clone()),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("preview-toggle")
                                    .outline()
                                    .small()
                                    .label(if selected { "Deselect" } else { "Select" })
                                    .on_click(move |_, window, cx| {
                                        window.close_dialog(cx);
                                        let _ = composer.update(cx, |this, cx| {
                                            this.toggle_reference(&toggle_id, cx)
                                        });
                                    }),
                            )
                            .child(
                                Button::new("preview-remove")
                                    .danger()
                                    .small()
                                    .icon(IconName::X)
                                    .label("Remove")
                                    .on_click(move |_, window, cx| {
                                        window.close_dialog(cx);
                                        let _ = remove_composer.update(cx, |this, cx| {
                                            this.remove_reference(&remove_id, cx)
                                        });
                                    }),
                            ),
                    ),
            )
    }
}
