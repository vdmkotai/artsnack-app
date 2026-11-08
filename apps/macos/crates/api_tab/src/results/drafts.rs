//! "Finish in 1080p" for a Seedance 2.5 draft: one `atlas:start` on the
//! completion endpoint, which renders the final from the draft itself. What to
//! send comes from the worker (`rowMeta(...).draft`, built by
//! packages/shared/atlas-drafts.ts); this only checks the seven days against
//! the clock and submits.

use std::time::{SystemTime, UNIX_EPOCH};

use artsnack_backend::{
    Backend,
    api::atlas::{self, StartArgs},
};
use artsnack_ui::TileAction;
use gpui_kit::{
    WeakEntity,
    assets::IconName,
    component::{WindowExt as _, notification::Notification},
};

use super::{ApiResults, meta::DraftCompletion};

/// The viewer action for a finished draft.
pub(super) fn finish_draft_action(
    view: &WeakEntity<ApiResults>,
    draft: &DraftCompletion,
) -> TileAction {
    let view = view.clone();
    let draft = draft.clone();
    let label = match draft.usd {
        Some(usd) => format!("Finish in 1080p · ≈{}", super::meta::format_usd(usd)),
        None => "Finish in 1080p".to_string(),
    };
    TileAction::new(
        "finish-draft",
        IconName::Sparkles,
        label,
        move |window, cx| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as f64)
                .unwrap_or_default();
            if now > draft.expires_at {
                window.push_notification(
                Notification::error(
                    "This draft can no longer be finished \u{2014} Atlas keeps drafts for seven days.",
                ),
                cx,
            );
                return;
            }
            let _ = view.update(cx, |this, cx| this.close_lightbox(window, cx));
            let args = StartArgs {
                model: draft.model.clone(),
                prompt: draft.prompt.clone(),
                params: draft.params.clone(),
                reference_storage_ids: None,
                reference_source_keys: None,
                jobs: 1.0,
            };
            let task = Backend::global(cx)
                .update(cx, |backend, cx| backend.mutate(atlas::START, &args, cx));
            let window_handle = window.window_handle();
            cx.spawn(async move |cx| {
                let notification = match task.await {
                    Ok(_) => Notification::success("Rendering the draft at 1080p"),
                    Err(error) => Notification::error(format!(
                        "Couldn\u{2019}t finish the draft. {}",
                        error.user_message()
                    )),
                };
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(notification, cx)
                });
            })
            .detach();
        },
    )
}
