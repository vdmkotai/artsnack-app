//! The commands a self-hosted image offers on a tile and in the viewer —
//! Reproduce, Send to Enhance, Send to API, Copy prompt, Download — shared by
//! Gallery and History. Hand-offs to other screens are only reported, as
//! [`MediaCommand`]s; the shell routes them.

use std::{sync::Arc, time::Duration};

use artsnack_backend::api::generations::Generation;
use artsnack_media::Media;
use artsnack_ui::TileAction;
use gpui_kit::{
    App, ClipboardItem, Context, EventEmitter, SharedString, Task, WeakEntity, assets::IconName,
};

use crate::command::{MediaCommand, ReproduceSource};

/// How long a Copy button shows its check mark.
const COPIED_FOR: Duration = Duration::from_millis(1500);

/// Which Copy button last copied, until its check mark times out.
#[derive(Default)]
pub(crate) struct CopiedMark {
    key: Option<SharedString>,
    _reset: Option<Task<()>>,
}

impl CopiedMark {
    pub fn is(&self, key: &str) -> bool {
        self.key.as_deref() == Some(key)
    }

    /// Copies `text` and marks `key` for a moment. `mark` finds this value in
    /// the view again when the moment is over.
    pub fn copy<V: 'static>(
        &mut self,
        key: SharedString,
        text: String,
        mark: fn(&mut V) -> &mut CopiedMark,
        cx: &mut Context<V>,
    ) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.key = Some(key);
        self._reset = Some(cx.spawn(async move |view, cx| {
            cx.background_executor().timer(COPIED_FOR).await;
            let _ = view.update(cx, |view, cx| {
                mark(view).key = None;
                cx.notify();
            });
        }));
        cx.notify();
    }
}

/// A screen that shows self-hosted images and reports their hand-offs.
pub(crate) trait ImageScreen: EventEmitter<MediaCommand> + Sized + 'static {
    fn copied_mark(&mut self) -> &mut CopiedMark;
}

fn emit<V: ImageScreen>(view: &WeakEntity<V>, command: MediaCommand, cx: &mut App) {
    let _ = view.update(cx, |_, cx| cx.emit(command));
}

/// Reproduce, Send to Enhance, Send to API and Copy prompt for one image, in
/// the web's order. `copy_key` names the Copy button's check mark; `copied`
/// is whether that mark is showing.
///
/// Built for every visible tile on every frame, so the form and URLs are only
/// worked out when an action runs.
pub(crate) fn image_actions<V: ImageScreen>(
    view: &WeakEntity<V>,
    generation: &Arc<Generation>,
    b2_key: &str,
    copy_key: SharedString,
    copied: bool,
) -> Vec<TileAction> {
    let mut actions = Vec::with_capacity(4);

    let reproduce_view = view.clone();
    let reproduce_generation = generation.clone();
    actions.push(TileAction::new(
        "reproduce",
        IconName::RefreshCw,
        "Reproduce",
        move |_, cx| {
            let source = ReproduceSource::SelfHosted {
                form_state: reproduce_generation.form_state.to_value(),
            };
            emit(&reproduce_view, MediaCommand::Reproduce(source), cx);
        },
    ));

    let enhance_view = view.clone();
    let enhance_generation = generation.clone();
    let enhance_key = b2_key.to_string();
    actions.push(TileAction::new(
        "enhance",
        IconName::Zap,
        "Send to Enhance",
        move |_, cx| {
            let command = MediaCommand::Enhance {
                image_url: Media::urls(cx).original(&enhance_key).into(),
                form_state: Some(enhance_generation.form_state.to_value()),
            };
            emit(&enhance_view, command, cx);
        },
    ));

    let reference_view = view.clone();
    let reference_key = b2_key.to_string();
    actions.push(TileAction::new(
        "reference",
        IconName::Sparkles,
        "Send to API as reference",
        move |_, cx| {
            let command = MediaCommand::UseAsReference {
                image_url: Media::urls(cx).original(&reference_key).into(),
            };
            emit(&reference_view, command, cx);
        },
    ));

    if !generation.form_state.prompt.trim().is_empty() {
        let copy_view = view.clone();
        let copy_generation = generation.clone();
        actions.push(TileAction::new(
            "copy-prompt",
            if copied {
                IconName::Check
            } else {
                IconName::Copy
            },
            if copied {
                "Prompt copied"
            } else {
                "Copy prompt"
            },
            move |_, cx| {
                let key = copy_key.clone();
                let prompt = copy_generation.form_state.prompt.clone();
                let _ = copy_view.update(cx, |screen, cx| {
                    screen.copied_mark().copy(key, prompt, V::copied_mark, cx)
                });
            },
        ));
    }
    actions
}

/// Download, the viewers' button (`TileAction::download`).
pub(crate) fn download_action(b2_key: &str, cx: &App) -> TileAction {
    TileAction::download(b2_key, cx)
}
