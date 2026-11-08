//! What can be done with a result: on its tile, in the viewer, and from the
//! reference tray. Hand-offs to other screens are only reported, as
//! [`MediaCommand`]s; the shell routes them.

use artsnack_backend::{
    Backend, CallError,
    api::{
        generations::{self, ImageRef, RemoveImagesArgs},
        grok_generations::{self, IdArgs},
        search_catalog::SearchSource,
    },
};
use artsnack_library::{FavoriteHearts, MediaCommand, ReproduceSource};
use artsnack_media::Media;
use artsnack_ui::TileAction;
use gpui_kit::{
    ClipboardItem, Context, Task, WeakEntity, Window,
    assets::IconName,
    component::{WindowExt as _, button::ButtonVariant, notification::Notification},
};

use super::{SearchView, toggle_args};
use crate::{
    engine::{
        MAX_SEARCH_REFERENCES, SearchResult, reorder_search_references, toggle_search_reference,
    },
    results,
};

/// What Reproduce restores: a self-hosted image's form, or an API row (the
/// shell re-opens its settings, self-hosted video included).
fn reproduce_source(result: &SearchResult) -> Option<ReproduceSource> {
    let document = &result.document;
    match document.source {
        SearchSource::SelfHosted => document
            .local_settings
            .clone()
            .map(|form_state| ReproduceSource::SelfHosted { form_state }),
        SearchSource::Api => Some(ReproduceSource::Api {
            generation_id: document.id.clone(),
        }),
    }
}

impl SearchView {
    // --- References -------------------------------------------------------------

    pub(super) fn toggle_reference(&mut self, result: &SearchResult, cx: &mut Context<Self>) {
        self.references = toggle_search_reference(&self.references, result, MAX_SEARCH_REFERENCES);
        cx.notify();
    }

    pub(super) fn remove_reference(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix < self.references.len() {
            self.references.remove(ix);
            cx.notify();
        }
    }

    pub(super) fn reorder_references(&mut self, from: usize, to: usize, cx: &mut Context<Self>) {
        self.references = reorder_search_references(&self.references, from, to);
        cx.notify();
    }

    pub(super) fn clear_references(&mut self, cx: &mut Context<Self>) {
        self.references.clear();
        cx.notify();
    }

    /// "Use N as references": one hand-off per image, in tray order. The tray
    /// keeps them, as the web's does, so a second composer can take the same.
    pub(super) fn use_references(&mut self, cx: &mut Context<Self>) {
        let urls = Media::urls(cx).clone();
        let commands: Vec<MediaCommand> = self
            .references
            .iter()
            .map(|reference| MediaCommand::UseAsReference {
                image_url: results::media_url(reference, &urls).into(),
            })
            .collect();
        for command in commands {
            cx.emit(command);
        }
    }

    // --- Commands on one result ----------------------------------------------------

    /// The tile's hover actions: the reference toggle (images), Reproduce and
    /// Copy prompt. The rest live in the viewer.
    pub(super) fn tile_actions(
        &self,
        result: &SearchResult,
        view: &WeakEntity<Self>,
    ) -> Vec<TileAction> {
        let mut actions = Vec::with_capacity(3);
        if results::is_image(result) {
            actions.push(self.reference_action(result, view));
        }
        actions.extend(reproduce_action(result, view));
        actions.extend(copy_action(result));
        actions
    }

    /// The viewer's bar: heart, references, Send now, Copy, Reproduce,
    /// Download, Delete.
    pub(super) fn lightbox_actions(&self, key: &str, cx: &mut Context<Self>) -> Vec<TileAction> {
        let Some(result) = self.result(key) else {
            return Vec::new();
        };
        let view = cx.entity().downgrade();
        let mut actions = Vec::with_capacity(7);
        if results::has_heart(&result) {
            // Offered once favourites are known: the server toggles.
            actions.extend(FavoriteHearts::viewer_action(
                &self.hearts,
                toggle_args(&result),
                cx,
            ));
        }
        if results::is_image(&result) {
            actions.push(self.reference_action(&result, &view));
            let send_view = view.clone();
            let image_url = results::media_url(&result, Media::urls(cx));
            actions.push(TileAction::new(
                "send-reference",
                IconName::Sparkles,
                "Send to API as reference",
                move |_, cx| {
                    let command = MediaCommand::UseAsReference {
                        image_url: image_url.clone().into(),
                    };
                    let _ = send_view.update(cx, |_, cx| cx.emit(command));
                },
            ));
        }
        actions.extend(copy_action(&result));
        actions.extend(reproduce_action(&result, &view));

        let download_view = view.clone();
        let download = result.clone();
        actions.push(TileAction::new(
            "download",
            IconName::Download,
            "Download",
            move |window, cx| {
                let result = download.clone();
                let _ = download_view.update(cx, |this, cx| this.download(&result, window, cx));
            },
        ));
        if !self.deleting {
            let delete_view = view;
            let delete = result.clone();
            actions.push(TileAction::new(
                "delete",
                IconName::Trash,
                "Delete\u{2026}",
                move |window, cx| {
                    let result = delete.clone();
                    let _ =
                        delete_view.update(cx, |this, cx| this.confirm_delete(result, window, cx));
                },
            ));
        }
        actions
    }

    fn reference_action(&self, result: &SearchResult, view: &WeakEntity<Self>) -> TileAction {
        let selected = self.is_reference(result);
        let full = !selected && self.references.len() >= MAX_SEARCH_REFERENCES;
        let view = view.clone();
        let result = result.clone();
        TileAction::new(
            "reference",
            if selected {
                IconName::Check
            } else {
                IconName::ImagePlus
            },
            if selected {
                "Remove from references".to_string()
            } else if full {
                format!("The tray holds {MAX_SEARCH_REFERENCES} references")
            } else {
                "Add to references".to_string()
            },
            move |_, cx| {
                let _ = view.update(cx, |this, cx| this.toggle_reference(&result, cx));
            },
        )
    }

    // --- Delete ---------------------------------------------------------------------

    /// Deleting an API result removes its whole generation, every output of
    /// it, as on the web; the confirmation says so when there is more than one.
    fn confirm_delete(
        &mut self,
        result: SearchResult,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.deleting {
            return;
        }
        let assets = result.document.assets.len();
        let title = match (result.document.source, results::is_image(&result)) {
            (SearchSource::Api, _) if assets > 1 => {
                format!("Delete this generation and its {assets} results?")
            }
            (_, true) => "Delete this image?".to_string(),
            (_, false) => "Delete this clip?".to_string(),
        };
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            let result = result.clone();
            alert
                .title(title.clone())
                .description("This cannot be undone.")
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let result = result.clone();
                    let _ = view.update(cx, |this, cx| this.delete(result, window, cx));
                    true
                })
        });
    }

    fn delete(&mut self, result: SearchResult, window: &mut Window, cx: &mut Context<Self>) {
        self.deleting = true;
        cx.notify();
        let document = result.document.clone();
        let b2_key = result.asset().key.clone();
        let removal: Task<Result<(), CallError>> =
            Backend::global(cx).update(cx, |backend, cx| match document.source {
                SearchSource::Api => backend.mutate(
                    grok_generations::REMOVE,
                    &IdArgs {
                        id: document.id.clone(),
                    },
                    cx,
                ),
                SearchSource::SelfHosted => {
                    let removed = backend.mutate(
                        generations::REMOVE_IMAGES,
                        &RemoveImagesArgs {
                            images: vec![ImageRef {
                                generation_id: document.id.clone(),
                                b2_key,
                            }],
                        },
                        cx,
                    );
                    cx.spawn(async move |_, _| removed.await.map(|_| ()))
                }
            });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let outcome = removal.await;
            let _ = this.update(cx, |this, cx| {
                this.deleting = false;
                if outcome.is_ok() {
                    this.references
                        .retain(|reference| !is_deleted_by(reference, &result));
                }
                cx.notify();
            });
            let _ = window_handle.update(cx, |_, window, cx| match outcome {
                Ok(()) => window.push_notification(Notification::success("Deleted"), cx),
                Err(error) => window.push_notification(
                    Notification::error(format!(
                        "Couldn\u{2019}t delete the result. {}",
                        error.user_message()
                    )),
                    cx,
                ),
            });
        })
        .detach();
    }

    // --- Download ----------------------------------------------------------------------

    /// Saves the original to ~/Downloads, as the Electron shell saved every
    /// download (from the disk cache when the viewer already showed it).
    fn download(&mut self, result: &SearchResult, window: &mut Window, cx: &mut Context<Self>) {
        let url = results::media_url(result, Media::urls(cx));
        let name = artsnack_media::downloads::name_for_key(&result.asset().key);
        artsnack_media::downloads::download(url, name.to_string(), window, cx);
    }
}

/// Whether deleting `deleted` took `reference` with it, by identity rather
/// than by value: a reference picked before the catalogue refreshed holds an
/// older copy of its document. An API delete removes the whole generation;
/// a self-hosted one only that image of its batch.
fn is_deleted_by(reference: &SearchResult, deleted: &SearchResult) -> bool {
    reference.document.id == deleted.document.id
        && match deleted.document.source {
            SearchSource::Api => true,
            SearchSource::SelfHosted => reference.asset().key == deleted.asset().key,
        }
}

fn reproduce_action(result: &SearchResult, view: &WeakEntity<SearchView>) -> Option<TileAction> {
    let source = reproduce_source(result)?;
    let view = view.clone();
    Some(TileAction::new(
        "reproduce",
        IconName::RefreshCw,
        "Reproduce",
        move |_, cx| {
            let command = MediaCommand::Reproduce(source.clone());
            let _ = view.update(cx, |_, cx| cx.emit(command));
        },
    ))
}

fn copy_action(result: &SearchResult) -> Option<TileAction> {
    let prompt = result.document.prompt.clone();
    (!prompt.trim().is_empty()).then(|| {
        TileAction::new(
            "copy-prompt",
            IconName::Copy,
            "Copy prompt",
            move |window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(prompt.clone()));
                window.push_notification(Notification::success("Prompt copied"), cx);
            },
        )
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use artsnack_backend::api::{
        favorites::MediaType,
        search_catalog::{SearchAsset, SearchDocument, SearchSource},
    };

    use super::is_deleted_by;
    use crate::engine::SearchResult;

    fn result(source: SearchSource, prompt: &str, asset_ix: usize) -> SearchResult {
        let asset = |id: &str| SearchAsset {
            id: id.into(),
            key: format!("{id}.png"),
            thumbnail_key: None,
        };
        SearchResult {
            document: Arc::new(SearchDocument {
                id: "g1".into(),
                source,
                provider: "self-hosted".into(),
                media_type: MediaType::Image,
                created_at: 1.0,
                prompt: prompt.into(),
                negative_prompt: None,
                assets: vec![asset("a"), asset("b")],
                model: None,
                model_label: None,
                model_family: None,
                checkpoints: Vec::new(),
                loras: Vec::new(),
                width: None,
                height: None,
                aspect_ratio: None,
                resolution: None,
                quality: None,
                duration: None,
                has_references: false,
                sampler: None,
                scheduler: None,
                steps: None,
                cfg: None,
                seed: None,
                parameters: None,
                local_settings: None,
            }),
            asset_ix,
            score: 0,
            reasons: Arc::from(Vec::new()),
        }
    }

    #[test]
    fn a_self_hosted_delete_takes_only_that_image_of_the_batch() {
        let deleted = result(SearchSource::SelfHosted, "cat", 0);
        // Picked before the catalogue refreshed: another copy of the row.
        let same_image = result(SearchSource::SelfHosted, "cat (edited)", 0);
        let sibling = result(SearchSource::SelfHosted, "cat", 1);
        assert!(is_deleted_by(&same_image, &deleted));
        assert!(!is_deleted_by(&sibling, &deleted));
    }

    #[test]
    fn an_api_delete_takes_the_whole_generation() {
        let deleted = result(SearchSource::Api, "cat", 0);
        assert!(is_deleted_by(
            &result(SearchSource::Api, "cat", 1),
            &deleted
        ));
    }
}
