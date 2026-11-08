//! A Copy button's check mark: copies, then shows the tick for a moment (the
//! web's 1.5 s), the same as the library screens' copy buttons.

use std::time::Duration;

use gpui_kit::{ClipboardItem, Context, SharedString, Task};

const COPIED_FOR: Duration = Duration::from_millis(1500);

/// Which Copy button last copied, until its tick times out.
#[derive(Default)]
pub(crate) struct CopiedMark {
    key: Option<SharedString>,
    _reset: Option<Task<()>>,
}

impl CopiedMark {
    pub fn is(&self, key: &str) -> bool {
        self.key.as_deref() == Some(key)
    }

    /// Copies `text` and marks `key`. `mark` finds this value in the view again
    /// when the moment is over.
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
