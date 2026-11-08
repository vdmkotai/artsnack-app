//! The paid-launch confirmation, with the models the new pod will download
//! (the web's `PodLaunchDialog`).
//!
//! Everything provision.sh would fetch that a pod can do without is listed as
//! the gist groups it, checked; what the user unchecks goes to the launch
//! action as `skipModels`. It is a skip list on purpose, here and in the
//! saved preference: a model added to the gist since then was never
//! unchecked, so it downloads. If the list cannot be read the pod downloads
//! everything, as it did before the dialog existed.
//!
//! The dialog does not launch anything itself. It emits
//! [`PodLaunchEvent::Launch`]; the panel that opened it owns the request, and
//! pushes its busy state and errors back in.

use std::collections::HashSet;

use artsnack_backend::api::{
    pod_downloads::PodProfile,
    pod_launch_models::{self, ListArgs, PodModelGroup, PodModelOption},
};
use artsnack_settings::{PreferenceFamily, Preferences};
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Subscription, Task, WeakEntity, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Sizable as _, WindowExt as _,
        alert::Alert,
        button::{Button, ButtonVariants as _},
        checkbox::Checkbox,
        dialog::{DialogClose, DialogFooter},
        h_flex,
        input::{Input, InputEvent, InputState},
        scroll::ScrollableElement as _,
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    rems,
};

use crate::{act, controls::GroupCheckbox};

/// The models unchecked at the last launch of each profile.
const SKIPPED: PreferenceFamily<Vec<String>> = PreferenceFamily::new("podLaunch.skip", Vec::new);

/// Enhance's checkpoint for images it knows no checkpoint for
/// (`FACE_FIX_FALLBACK_CHECKPOINT` in packages/shared/enhance-workflows.ts).
const FACE_FIX_FALLBACK_CHECKPOINT: &str = "sd_xl_base_1.0.safetensors";

fn always_downloaded(profile: PodProfile) -> &'static str {
    match profile {
        PodProfile::Image => {
            "Always downloaded: the 4x-UltraSharp upscaler and the Face Fix detectors."
        }
        PodProfile::Video => {
            "Always downloaded: the MiniMax H3 base set \u{2014} both models, the text encoder, the VAEs and the turbo LoRAs."
        }
    }
}

fn profile_key(profile: PodProfile) -> &'static str {
    match profile {
        PodProfile::Image => "image",
        PodProfile::Video => "video",
    }
}

/// The user confirmed: launch without these `dir|filename` models.
#[derive(Clone, Debug)]
pub enum PodLaunchEvent {
    Launch { skip_models: Vec<String> },
}

/// The body of the launch confirmation: the rental summary, the model list
/// and the notes, plus the busy state and error its owner reports.
pub struct PodLaunchPanel {
    profile: PodProfile,
    summary: Vec<SharedString>,
    /// `None` while the manifest is being read.
    groups: Option<Vec<PodModelGroup>>,
    load_error: Option<SharedString>,
    skipped: HashSet<String>,
    filter: Entity<InputState>,
    busy: bool,
    error: Option<SharedString>,
    _load: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<PodLaunchEvent> for PodLaunchPanel {}

impl PodLaunchPanel {
    /// `summary` says what is rented and at what price, one paragraph each.
    pub fn new(
        profile: PodProfile,
        summary: Vec<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter models"));
        let subscriptions = vec![cx.subscribe(&filter, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        })];
        let request = act(pod_launch_models::LIST, &ListArgs { profile }, cx);
        let load = cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(groups) => {
                        this.skipped = restore_skipped(&groups, profile, cx);
                        this.groups = Some(groups);
                    }
                    Err(error) => this.load_error = Some(error.user_message()),
                }
                cx.notify();
            });
        });
        Self {
            profile,
            summary,
            groups: None,
            load_error: None,
            skipped: HashSet::new(),
            filter,
            busy: false,
            error: None,
            _load: load,
            _subscriptions: subscriptions,
        }
    }

    pub fn set_summary(&mut self, summary: Vec<SharedString>, cx: &mut Context<Self>) {
        if self.summary != summary {
            self.summary = summary;
            cx.notify();
        }
    }

    /// The owner's launch is in flight: the confirm button waits.
    pub fn set_busy(&mut self, busy: bool, cx: &mut Context<Self>) {
        if self.busy != busy {
            self.busy = busy;
            cx.notify();
        }
    }

    pub fn set_error(&mut self, error: Option<SharedString>, cx: &mut Context<Self>) {
        if self.error != error {
            self.error = error;
            cx.notify();
        }
    }

    fn total(&self) -> usize {
        self.groups
            .iter()
            .flatten()
            .map(|group| group.models.len())
            .sum()
    }

    fn selected(&self) -> usize {
        self.total().saturating_sub(self.skipped.len())
    }

    /// The manifest was read, or reading it failed and launching will
    /// download everything.
    fn is_ready(&self) -> bool {
        self.groups.is_some() || self.load_error.is_some()
    }

    fn query(&self, cx: &App) -> String {
        self.filter.read(cx).value().trim().to_lowercase()
    }

    /// The groups and models the filter lets through.
    fn visible_groups(&self, cx: &App) -> Vec<(&PodModelGroup, Vec<&PodModelOption>)> {
        let needle = self.query(cx);
        self.groups
            .iter()
            .flatten()
            .filter_map(|group| {
                let models: Vec<&PodModelOption> = group
                    .models
                    .iter()
                    .filter(|model| {
                        needle.is_empty()
                            || model.label.to_lowercase().contains(&needle)
                            || model.filename.to_lowercase().contains(&needle)
                    })
                    .collect();
                (!models.is_empty()).then_some((group, models))
            })
            .collect()
    }

    fn set_checked(&mut self, keys: Vec<String>, checked: bool, cx: &mut Context<Self>) {
        for key in keys {
            if checked {
                self.skipped.remove(&key);
            } else {
                self.skipped.insert(key);
            }
        }
        cx.notify();
    }

    fn set_visible_checked(&mut self, checked: bool, cx: &mut Context<Self>) {
        let keys = self
            .visible_groups(cx)
            .into_iter()
            .flat_map(|(_, models)| models.into_iter().map(|model| model.key.clone()))
            .collect();
        self.set_checked(keys, checked, cx);
    }

    fn confirm(&mut self, cx: &mut Context<Self>) {
        if self.busy || !self.is_ready() {
            return;
        }
        let skip_models: Vec<String> = if self.groups.is_some() {
            let mut keys: Vec<String> = self.skipped.iter().cloned().collect();
            keys.sort();
            Preferences::set_member(cx, &SKIPPED, profile_key(self.profile), keys.clone());
            keys
        } else {
            Vec::new()
        };
        cx.emit(PodLaunchEvent::Launch { skip_models });
    }

    fn render_list(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let total = self.total();
        let visible = self.visible_groups(cx);
        let query = self.filter.read(cx).value().trim().to_string();
        let muted = cx.theme().muted_foreground;
        let no_match = total > 0 && visible.is_empty();

        let groups: Vec<_> = visible
            .into_iter()
            .map(|(group, models)| {
                let keys: Vec<String> =
                    group.models.iter().map(|model| model.key.clone()).collect();
                let unchecked = keys
                    .iter()
                    .filter(|key| self.skipped.contains(*key))
                    .count();
                let checked = keys.len() - unchecked;
                let header = GroupCheckbox::new(
                    SharedString::from(format!("launch-group:{}", group.title)),
                    group.title.clone(),
                )
                .checked_count(checked, keys.len())
                .suffix(
                    div()
                        .text_color(muted)
                        .child(format!("{checked}/{}", keys.len())),
                )
                .on_change({
                    let panel = cx.entity().downgrade();
                    move |checked, _, cx| {
                        let _ = panel
                            .update(cx, |this, cx| this.set_checked(keys.clone(), checked, cx));
                    }
                });
                let rows = models.into_iter().map(|model| {
                    let key = model.key.clone();
                    Checkbox::new(SharedString::from(format!("launch-model:{}", model.key)))
                        .checked(!self.skipped.contains(&model.key))
                        .tooltip(format!("{}/{}", model.dir, model.filename))
                        .accessibility_label(model.label.clone())
                        .min_w_0()
                        .child(div().min_w_0().truncate().child(model.label.clone()))
                        .on_change(cx.listener(move |this, checked: &bool, _, cx| {
                            this.set_checked(vec![key.clone()], *checked, cx)
                        }))
                });
                v_flex().gap_1().child(header).child(
                    div()
                        .grid()
                        .grid_cols(2)
                        .gap_x_4()
                        .gap_y_1()
                        .pl_6()
                        .children(rows),
                )
            })
            .collect();

        // The list scrolls on its own so the filter and the notes stay in view.
        // The height cap sits on a wrapper column, not on the scrolled
        // element: `overflow_y_scrollbar` sizes its scroll area at 100% of
        // the element, which a bare `max_h` leaves indefinite, so the list
        // was clipped at the cap and never scrolled.
        let list = v_flex()
            .flex_1()
            .gap_3()
            .p_3()
            .children(groups)
            .when(total == 0, |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(muted)
                        .child("This pod has no optional models to choose."),
                )
            })
            .when(no_match, |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(muted)
                        .child(format!("No model matches \u{201c}{query}\u{201d}.")),
                )
            })
            .overflow_y_scrollbar();
        v_flex()
            .max_h(rems(22.))
            .rounded(cx.theme().radius_lg)
            .border_1()
            .border_color(cx.theme().border)
            .child(list)
    }

    /// The dialog's footer: Cancel, and the confirmation with how many models
    /// will download.
    fn render_footer(panel: &Entity<Self>, cx: &App) -> impl IntoElement {
        let this = panel.read(cx);
        let label = if this.groups.is_some() {
            format!(
                "Confirm and launch \u{b7} {} of {} models",
                this.selected(),
                this.total()
            )
        } else {
            "Confirm and launch".to_string()
        };
        let enabled = !this.busy && this.is_ready();
        let panel = panel.clone();
        DialogFooter::new()
            .gap_2()
            .child(DialogClose::new().child(Button::new("cancel-launch").outline().label("Cancel")))
            .child(
                Button::new("confirm-launch")
                    .primary()
                    .label(label)
                    .loading(this.busy)
                    .disabled(!enabled)
                    .on_click(move |_, _, cx| panel.update(cx, |this, cx| this.confirm(cx))),
            )
    }
}

fn restore_skipped(groups: &[PodModelGroup], profile: PodProfile, cx: &App) -> HashSet<String> {
    let present: HashSet<&str> = groups
        .iter()
        .flat_map(|group| group.models.iter().map(|model| model.key.as_str()))
        .collect();
    Preferences::get_member(cx, &SKIPPED, profile_key(profile))
        .into_iter()
        .filter(|key| present.contains(key.as_str()))
        .collect()
}

impl Render for PodLaunchPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let fallback_skipped = self.profile == PodProfile::Image
            && self
                .skipped
                .contains(&format!("checkpoints|{FACE_FIX_FALLBACK_CHECKPOINT}"));
        let fallback_name = FACE_FIX_FALLBACK_CHECKPOINT.trim_end_matches(".safetensors");

        v_flex()
            .gap_3()
            .child(
                v_flex().gap_1().text_sm().text_color(muted).children(
                    self.summary
                        .iter()
                        .map(|paragraph| div().child(paragraph.clone())),
                ),
            )
            .when(!self.is_ready(), |this| {
                this.child(
                    h_flex()
                        .justify_center()
                        .gap_2()
                        .py_8()
                        .text_sm()
                        .text_color(muted)
                        .child(Spinner::new().small())
                        .child("Reading the provisioning manifest\u{2026}"),
                )
            })
            .when_some(self.load_error.clone(), |this, error| {
                this.child(Alert::warning(
                    "launch-models-unreadable",
                    format!(
                        "The model list could not be read ({error}). Launching now downloads every model, as before."
                    ),
                ))
            })
            .when(self.groups.is_some(), |this| {
                this.child(
                    h_flex()
                        .gap_2()
                        .child(
                            div().flex_1().min_w_0().child(
                                Input::new(&self.filter)
                                    .small()
                                    .prefix(Icon::new(IconName::Search).small())
                                    .cleanable(true),
                            ),
                        )
                        .child(
                            Button::new("check-all")
                                .small()
                                .outline()
                                .label("All")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.set_visible_checked(true, cx)
                                })),
                        )
                        .child(
                            Button::new("check-none")
                                .small()
                                .outline()
                                .label("None")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.set_visible_checked(false, cx)
                                })),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_sm()
                                .text_color(muted)
                                .child(format!("{} of {} selected", self.selected(), self.total())),
                        ),
                )
                .child(self.render_list(cx))
                .child(
                    div()
                        .text_sm()
                        .text_color(muted)
                        .child(always_downloaded(self.profile)),
                )
                .when(fallback_skipped, |this| {
                    this.child(Alert::warning(
                        "face-fix-fallback",
                        format!(
                            "Enhance falls back to {fallback_name} when it does not know an image\u{2019}s checkpoint (uploads, API images). Without it those Enhance jobs fail on this pod."
                        ),
                    ))
                })
            })
            .when_some(self.error.clone(), |this, error| {
                this.child(Alert::error("launch-error", error))
            })
    }
}

/// Opens the launch confirmation over whatever is open. The returned handle
/// tells its owner whether the dialog is still up.
pub(crate) fn open<T: 'static>(
    title: SharedString,
    profile: PodProfile,
    summary: Vec<SharedString>,
    on_launch: fn(&mut T, Vec<String>, &mut Window, &mut Context<T>),
    window: &mut Window,
    cx: &mut Context<T>,
) -> LaunchDialog {
    let panel = cx.new(|cx| PodLaunchPanel::new(profile, summary, window, cx));
    let subscription = cx.subscribe_in(&panel, window, move |this, _, event, window, cx| {
        let PodLaunchEvent::Launch { skip_models } = event;
        on_launch(this, skip_models.clone(), window, cx);
    });
    let handle = LaunchDialog {
        panel: panel.downgrade(),
        _subscription: subscription,
    };
    window.open_dialog(cx, move |dialog, window, cx| {
        dialog
            .title(title.clone())
            .w(rems(42.).to_pixels(window.rem_size()))
            // Renting is never one keystroke away: Enter in the filter must
            // not launch, or even close, a paid confirmation.
            .on_ok(|_, _, _| false)
            .child(panel.clone())
            .footer(PodLaunchPanel::render_footer(&panel, cx))
    });
    handle
}

/// An open launch confirmation, as its owner sees it. The dialog holds the
/// only strong reference, so the panel is gone once the dialog closes.
pub(crate) struct LaunchDialog {
    panel: WeakEntity<PodLaunchPanel>,
    _subscription: Subscription,
}

impl LaunchDialog {
    pub fn is_open(&self) -> bool {
        self.panel.upgrade().is_some()
    }

    /// Mirrors the owner's state into the dialog, if it is still open.
    pub fn sync(
        &self,
        busy: bool,
        error: Option<SharedString>,
        summary: Option<Vec<SharedString>>,
        cx: &mut App,
    ) {
        if let Some(panel) = self.panel.upgrade() {
            panel.update(cx, |panel, cx| {
                panel.set_busy(busy, cx);
                panel.set_error(error, cx);
                if let Some(summary) = summary {
                    panel.set_summary(summary, cx);
                }
            });
        }
    }

    /// Closes the dialog after a launch went through, unless the user already
    /// did — closing then would close whatever is under it.
    pub fn close(&self, window: &mut Window, cx: &mut App) {
        if self.is_open() {
            window.close_dialog(cx);
        }
    }
}
