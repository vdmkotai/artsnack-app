//! "Self-hosted backend": the dialog behind the backend status button (the
//! web's `BackendManagerDialog`). RunPod and Vast.ai can run at once; the
//! dialog switches between managing either, and each ready one can be chosen
//! for new generations.
//!
//! Both panels live as long as the dialog. The hidden one is told it is
//! closed, so only the provider on screen is polled — and the RunPod form
//! keeps what was typed into it across a switch.

use gpui_kit::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Sizable as _, WindowExt as _,
        button::Button,
        dialog::{DialogClose, DialogFooter},
        h_flex,
        tab::{Tab, TabBar},
        v_flex,
    },
    div, rems,
};

use crate::{
    runpod_panel::{RunpodBackendPanel, RunpodPanelOptions},
    vast_panel::VastBackendPanel,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderTab {
    Runpod,
    Vast,
}

struct BackendManager {
    tab: ProviderTab,
    runpod: Entity<RunpodBackendPanel>,
    /// Made the first time the Vast tab is chosen, so opening the dialog for
    /// RunPod costs Vast nothing.
    vast: Option<Entity<VastBackendPanel>>,
}

impl BackendManager {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let runpod = cx.new(|cx| RunpodBackendPanel::new(RunpodPanelOptions::image(), window, cx));
        Self {
            tab: ProviderTab::Runpod,
            runpod,
            vast: None,
        }
    }

    fn select(&mut self, tab: ProviderTab, window: &mut Window, cx: &mut Context<Self>) {
        if self.tab == tab {
            return;
        }
        self.tab = tab;
        let vast = tab == ProviderTab::Vast;
        self.runpod
            .update(cx, |panel, cx| panel.set_open(!vast, window, cx));
        match &self.vast {
            Some(panel) => panel.update(cx, |panel, cx| panel.set_open(vast, window, cx)),
            None if vast => {
                self.vast = Some(cx.new(|cx| VastBackendPanel::new(window, cx)));
            }
            None => {}
        }
        cx.notify();
    }
}

impl Render for BackendManager {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let panel = match (self.tab, &self.vast) {
            (ProviderTab::Vast, Some(vast)) => vast.clone().into_any_element(),
            _ => self.runpod.clone().into_any_element(),
        };
        v_flex()
            .gap_4()
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("Vast.ai and RunPod can stay online together. Choose which provider to manage here and which ready backend receives new generations."),
            )
            .child(
                TabBar::new("backend-provider")
                    .segmented()
                    .selected_index(match self.tab {
                        ProviderTab::Runpod => 0,
                        ProviderTab::Vast => 1,
                    })
                    .child(Tab::new().label("RunPod"))
                    .child(Tab::new().label("Vast.ai"))
                    .on_click(cx.listener(|this, ix: &usize, window, cx| {
                        let tab = if *ix == 0 {
                            ProviderTab::Runpod
                        } else {
                            ProviderTab::Vast
                        };
                        this.select(tab, window, cx);
                    })),
            )
            .child(panel)
    }
}

/// Opens the dialog with fresh panels. Closing it drops them, which stops
/// their polling.
pub(crate) fn open(window: &mut Window, cx: &mut App) {
    let manager = cx.new(|cx| BackendManager::new(window, cx));
    window.open_dialog(cx, move |dialog, window, _| {
        dialog
            .title(
                h_flex()
                    .gap_2()
                    .child(Icon::new(IconName::Cpu).small())
                    .child("Self-hosted backend"),
            )
            .w(rems(56.).to_pixels(window.rem_size()))
            // Nothing here commits on Enter: an Enter typed into one of the
            // form's fields must not close a dialog that manages paid pods.
            .on_ok(|_, _, _| false)
            .child(manager.clone())
            .footer(DialogFooter::new().child(
                DialogClose::new().child(Button::new("close-backends").outline().label("Close")),
            ))
    });
}
