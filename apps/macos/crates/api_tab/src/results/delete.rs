//! Taking rows off the grid: one tile, a selection, every failure.
//!
//! The confirmation follows what is lost. A finished row's media goes with it.
//! A running hosted job is not cancelled — the vendor keeps it, finishes it
//! and bills it; only the tile goes — so that is said plainly. A running
//! self-hosted clip *is* cancelled on the pod. A failure produced nothing and
//! goes without asking.

use std::sync::Arc;

use artsnack_backend::{
    Backend, CallError, NoArgs,
    api::grok_generations::{self, ApiGeneration, IdArgs, REMOVE_MANY_CHUNK, RemoveManyArgs},
};
use gpui_kit::{
    AnyWindowHandle, AsyncApp, Context, SharedString, Window,
    component::{WindowExt as _, button::ButtonVariant, notification::Notification},
    prelude::FluentBuilder as _,
};

use super::{ApiResults, ResultsKind, content::is_self_hosted_video};

/// "1 generation", "3 generations".
fn generations_label(count: usize) -> String {
    if count == 1 {
        "1 generation".into()
    } else {
        format!("{count} generations")
    }
}

/// `removeMany` caps one transaction at 200 rows, so a long selection goes in
/// turns — and a failure part-way says how much already went.
async fn remove_in_chunks(ids: Vec<String>, cx: &mut AsyncApp) -> Result<usize, CallError> {
    let mut removed = 0;
    for chunk in ids.chunks(REMOVE_MANY_CHUNK) {
        let args = RemoveManyArgs {
            ids: chunk.to_vec(),
        };
        let task = cx.update(|cx| {
            Backend::global(cx).update(cx, |backend, cx| {
                backend.mutate(grok_generations::REMOVE_MANY, &args, cx)
            })
        });
        match task.await {
            Ok(count) => removed += count as usize,
            Err(error) if removed == 0 => return Err(error),
            Err(error) => {
                return Err(CallError::Function {
                    message: format!("Deleted {removed}, then stopped: {}", error.user_message()),
                    data: None,
                });
            }
        }
    }
    Ok(removed)
}

fn notify(window: AnyWindowHandle, notification: Notification, cx: &mut AsyncApp) {
    let _ = window.update(cx, |_, window, cx| {
        window.push_notification(notification, cx)
    });
}

impl ApiResults {
    /// Deletes `row`, asking first unless it failed. `close_viewer`: the viewer
    /// closes with the tile, never on a cancelled question.
    pub(super) fn confirm_remove(
        &mut self,
        row: Arc<ApiGeneration>,
        close_viewer: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let question: Option<(&str, &str, &str, Option<&str>)> = if row.is_failed() {
            None
        } else if row.is_running() && is_self_hosted_video(&row) {
            Some((
                "Cancel this clip on the video pod?",
                "It comes off the pod's queue, and its tile goes.",
                "Cancel clip",
                Some("Keep running"),
            ))
        } else if row.is_running() {
            Some((
                "Remove this from the results?",
                "The job cannot be cancelled: it will still run and still be charged for, you just won't get the result.",
                "Remove",
                None,
            ))
        } else {
            Some((
                "Delete this generation?",
                "The media goes with it.",
                "Delete",
                None,
            ))
        };
        let id = row.id.clone();
        let Some((title, description, ok, cancel)) = question else {
            self.remove(id, close_viewer, window, cx);
            return;
        };
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            let id = id.clone();
            alert
                .title(title)
                .description(description)
                .confirm()
                .ok_text(ok)
                .ok_variant(ButtonVariant::Danger)
                .when_some(cancel, |alert, cancel| alert.cancel_text(cancel))
                .on_ok(move |_, window, cx| {
                    let id = id.clone();
                    let _ = view.update(cx, |this, cx| this.remove(id, close_viewer, window, cx));
                    true
                })
        });
    }

    fn remove(
        &mut self,
        id: String,
        close_viewer: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The tile goes now; the tile going is the confirmation.
        let ids = vec![id.clone()];
        self.hide_rows(&ids, cx);
        if close_viewer {
            self.close_lightbox(window, cx);
        }
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(grok_generations::REMOVE, &IdArgs { id }, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| this.settle_removed(&ids, result.is_ok(), cx));
            if let Err(error) = result {
                notify(
                    window_handle,
                    Notification::error(format!(
                        "Couldn\u{2019}t delete the generation. {}",
                        error.user_message()
                    )),
                    cx,
                );
            }
        })
        .detach();
    }

    /// One question for the whole selection, worded by what is in it.
    pub(super) fn confirm_delete_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.deleting {
            return;
        }
        let rows: Vec<Arc<ApiGeneration>> = self
            .content
            .rows
            .iter()
            .filter(|row| self.selection.is_selected(&row.id))
            .cloned()
            .collect();
        if rows.is_empty() {
            return;
        }
        let hosted_running = rows
            .iter()
            .filter(|row| row.is_running() && !is_self_hosted_video(row))
            .count();
        let clips_running = rows
            .iter()
            .filter(|row| row.is_running() && is_self_hosted_video(row))
            .count();
        let mut description = String::from("Finished media goes with them.");
        if hosted_running > 0 {
            description.push_str(&format!(
                " {hosted_running} still running cannot be cancelled: they will still be charged for, you just won't get the results."
            ));
        }
        if clips_running > 0 {
            description.push_str(&format!(
                " {clips_running} unfinished clip{} will be cancelled on the video pod.",
                if clips_running == 1 { "" } else { "s" }
            ));
        }
        let title = format!("Delete {}?", generations_label(rows.len()));
        let description: SharedString = description.into();
        let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            let ids = ids.clone();
            alert
                .title(title.clone())
                .description(description.clone())
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let ids = ids.clone();
                    let _ = view.update(cx, |this, cx| this.delete_rows(ids, window, cx));
                    true
                })
        });
    }

    fn delete_rows(&mut self, ids: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.deleting = true;
        self.hide_rows(&ids, cx);
        self.exit_selection(cx);
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = remove_in_chunks(ids.clone(), cx).await;
            let _ = this.update(cx, |this, cx| {
                this.deleting = false;
                // A part-way failure brings every tile back; the ones that did
                // go are already out of the live rows.
                this.settle_removed(&ids, result.is_ok(), cx);
                cx.notify();
            });
            let notification = match result {
                Ok(removed) => {
                    Notification::success(format!("Deleted {}", generations_label(removed)))
                }
                Err(error) => Notification::error(format!(
                    "Couldn\u{2019}t delete the generations. {}",
                    error.user_message()
                )),
            };
            notify(window_handle, notification, cx);
        })
        .detach();
    }

    /// Removes the failures without asking: what they hold is an error message,
    /// not media. The API tab's server-side sweep keeps rows that were already
    /// billed, so the toast accounts for the tiles that stay. The self-hosted
    /// video tab removes only its own loaded failures, by id; the sweep would
    /// clear the API tab's too.
    pub(super) fn remove_all_failed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.removing_failed {
            return;
        }
        let failed: Vec<String> = self
            .rows
            .iter()
            .filter(|row| row.is_failed())
            .map(|row| row.id.clone())
            .collect();
        let failed_before = failed.len();
        self.removing_failed = true;
        cx.notify();
        let kind = self.kind;
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = match kind {
                ResultsKind::Api => {
                    let task = cx.update(|cx| {
                        Backend::global(cx).update(cx, |backend, cx| {
                            backend.mutate(grok_generations::REMOVE_ALL_FAILED, &NoArgs {}, cx)
                        })
                    });
                    task.await.map(|removed| removed as usize)
                }
                ResultsKind::SelfHostedVideo => remove_in_chunks(failed, cx).await,
            };
            let _ = this.update(cx, |this, cx| {
                this.removing_failed = false;
                cx.notify();
            });
            let notification = match result {
                Ok(removed) => {
                    // The loaded failures only, so this can undercount kept rows
                    // when older ones are unpaged — never overcount.
                    let kept = failed_before.saturating_sub(removed);
                    let plural = if removed == 1 { "" } else { "s" };
                    let mut message = format!("Removed {removed} failed generation{plural}");
                    if kept > 0 && kind == ResultsKind::Api {
                        message.push_str(&format!(" · kept {kept} you were already charged for"));
                    }
                    Notification::success(message)
                }
                Err(error) => Notification::error(format!(
                    "Couldn\u{2019}t remove the failed generations. {}",
                    error.user_message()
                )),
            };
            notify(window_handle, notification, cx);
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::generations_label;

    #[test]
    fn counts_generations() {
        assert_eq!(generations_label(1), "1 generation");
        assert_eq!(generations_label(200), "200 generations");
    }
}
