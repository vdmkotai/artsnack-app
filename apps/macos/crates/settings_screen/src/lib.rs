//! Settings: what the account shows (feature flags), the cache on this Mac,
//! and who is signed in.

use std::collections::HashMap;

use artsnack_backend::{
    Backend, LiveQuery, NoArgs,
    api::feature_flags::{self, FeatureFlag, FeatureFlags, SetFlagArgs},
};
use artsnack_media::{DISK_BUDGET, Media, disk::DiskUsage};
use artsnack_session::Session;
use artsnack_settings::Preferences;
use gpui_kit::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, Window,
    component::{
        ActiveTheme as _, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariant},
        h_flex,
        notification::Notification,
        spinner::Spinner,
        switch::Switch,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

const GIB: u64 = 1024 * 1024 * 1024;
const BUDGETS_GIB: [u64; 4] = [1, 5, 10, 20];

/// A flag flipped here that the server has not shown back yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pending {
    enabled: bool,
    /// Which flip this is; only its own request may settle it.
    revision: u64,
    /// The request succeeded; the overlay goes at the next server answer.
    settled: bool,
}

pub struct SettingsView {
    flags: Entity<LiveQuery<Option<FeatureFlags>>>,
    /// Flags flipped here and not yet confirmed by the server: shown at once.
    pending: HashMap<FeatureFlag, Pending>,
    flag_revision: u64,
    usage: Option<DiskUsage>,
    /// Bumped by each usage read, so a slow read never overwrites a newer one.
    usage_revision: u64,
    _subscriptions: Vec<Subscription>,
}

impl SettingsView {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let flags = LiveQuery::new(feature_flags::MINE, &NoArgs {}, cx);
        let subscriptions = vec![
            cx.observe(&flags, |this, _, cx| {
                // A flip whose request succeeded is in this answer (the
                // mutation resolves once its write is visible); a flip still
                // in flight keeps showing until its own request settles.
                this.pending.retain(|_, pending| !pending.settled);
                cx.notify();
            }),
            Preferences::observe(cx, &DISK_BUDGET, |_, cx| cx.notify()),
        ];
        let mut this = Self {
            flags,
            pending: HashMap::new(),
            flag_revision: 0,
            usage: None,
            usage_revision: 0,
            _subscriptions: subscriptions,
        };
        this.refresh_usage(cx);
        this
    }

    /// Reads the cache's size off the main thread. The cache is SQLite and
    /// files: blocking work for the background executor, never the network
    /// runtime's few threads.
    fn refresh_usage(&mut self, cx: &mut Context<Self>) {
        let Some(disk) = Media::disk(cx) else { return };
        self.measure(cx.background_spawn(async move { disk.usage() }), cx);
    }

    /// Shows the usage `read` resolves to, unless a newer read started since.
    fn measure(&mut self, read: Task<DiskUsage>, cx: &mut Context<Self>) {
        self.usage_revision += 1;
        let revision = self.usage_revision;
        cx.spawn(async move |this, cx| {
            let usage = read.await;
            let _ = this.update(cx, |this, cx| {
                if this.usage_revision == revision && this.usage != Some(usage) {
                    this.usage = Some(usage);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// A new budget: saved, then evicted down to before the usage is read.
    fn set_budget(&mut self, bytes: u64, cx: &mut Context<Self>) {
        Media::set_disk_budget(cx, bytes);
        let Some(disk) = Media::disk(cx) else { return };
        // `set_disk_budget` evicts in the background with no way to wait for
        // it; evicting here too is idempotent (the index lock orders the two,
        // and the second finds nothing over budget), and the usage read then
        // follows the eviction instead of racing it.
        self.measure(
            cx.background_spawn(async move {
                if let Err(error) = disk.set_budget(bytes) {
                    tracing::warn!(?error, "could not apply the media cache budget");
                }
                disk.usage()
            }),
            cx,
        );
    }

    fn set_flag(
        &mut self,
        flag: FeatureFlag,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.flag_revision += 1;
        let revision = self.flag_revision;
        self.pending.insert(
            flag,
            Pending {
                enabled,
                revision,
                settled: false,
            },
        );
        cx.notify();
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(feature_flags::SET, &SetFlagArgs { key: flag, enabled }, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                // A newer flip of the same flag owns the overlay now.
                let Some(pending) = this
                    .pending
                    .get_mut(&flag)
                    .filter(|pending| pending.revision == revision)
                else {
                    return;
                };
                let server = this.flags.read(cx).data().and_then(|flags| **flags);
                match &result {
                    // Shown back already: the overlay is done.
                    Ok(()) if server.is_some_and(|server| server.get(flag) == enabled) => {
                        this.pending.remove(&flag);
                    }
                    Ok(()) => pending.settled = true,
                    // Roll back the optimistic value.
                    Err(_) => {
                        this.pending.remove(&flag);
                    }
                }
                cx.notify();
            });
            if let Err(error) = result {
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx)
                });
            }
        })
        .detach();
    }

    fn confirm_clear_cache(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            alert
                .title("Clear the media cache?")
                .description("Images and clips are downloaded again the next time they are shown.")
                .confirm()
                .ok_text("Clear")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, _, cx| {
                    let _ = view.update(cx, |this, cx| this.clear_cache(cx));
                    true
                })
        });
    }

    fn clear_cache(&mut self, cx: &mut Context<Self>) {
        let Some(disk) = Media::disk(cx) else { return };
        self.measure(
            cx.background_spawn(async move {
                if let Err(error) = disk.clear() {
                    tracing::warn!(?error, "could not clear the media cache");
                }
                disk.usage()
            }),
            cx,
        );
    }

    fn render_flags(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.flags.read(cx);
        let flags = query.data().and_then(|flags| **flags);
        let loading = query.is_loading();

        section(
            "Feature flags",
            "Hide the API providers you are not using. A hidden provider keeps its results, and reproducing one of them still works.",
            cx,
        )
        .child(match (loading, flags) {
            (true, _) => div().py_6().flex().justify_center().child(Spinner::new()).into_any_element(),
            (false, None) => div()
                .py_6()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .child("Sign in to change settings.")
                .into_any_element(),
            (false, Some(flags)) => v_flex()
                .rounded(cx.theme().radius_lg)
                .border_1()
                .border_color(cx.theme().border)
                .children(FeatureFlag::ALL.iter().map(|flag| {
                    let flag = *flag;
                    let enabled = self
                        .pending
                        .get(&flag)
                        .map_or(flags.get(flag), |pending| pending.enabled);
                    h_flex()
                        .px_4()
                        .py_3()
                        .gap_4()
                        .justify_between()
                        .child(
                            v_flex()
                                .min_w_0()
                                .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(flag.label()))
                                .child(div().text_xs().text_color(cx.theme().muted_foreground).child(flag.description())),
                        )
                        .child(
                            Switch::new(match flag {
                                FeatureFlag::Higgsfield => "flag-higgsfield",
                                FeatureFlag::Fal => "flag-fal",
                            })
                            .checked(enabled)
                            .on_change(cx.listener(move |this, checked: &bool, window, cx| {
                                this.set_flag(flag, *checked, window, cx)
                            })),
                        )
                }))
                .into_any_element(),
        })
    }

    fn render_cache(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let budget = Preferences::get(cx, &DISK_BUDGET);
        let usage: SharedString = match self.usage {
            Some(usage) => format!(
                "{} files · {} of {}",
                usage.entries,
                format_bytes(usage.bytes),
                format_bytes(budget)
            )
            .into(),
            None if Media::disk(cx).is_none() => "The cache is unavailable on this Mac.".into(),
            None => "Measuring…".into(),
        };
        section(
            "Media cache",
            "Originals and previews are kept on this Mac so revisited images open without downloading again. Nothing here is synced.",
            cx,
        )
        .child(div().text_sm().child(usage))
        .child(
            h_flex()
                .gap_3()
                .child(div().text_sm().child("Keep up to"))
                .child(
                    ButtonGroup::new("cache-budget")
                        .small()
                        .outline()
                        .children(BUDGETS_GIB.iter().map(|gib| {
                            Button::new(("budget", *gib as usize))
                                .label(format!("{gib} GB"))
                                .selected(budget == gib * GIB)
                        }))
                        .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                            if let Some(gib) = selected.first().and_then(|ix| BUDGETS_GIB.get(*ix)) {
                                this.set_budget(gib * GIB, cx);
                            }
                        })),
                ),
        )
        .child(
            div().child(
                Button::new("clear-cache")
                    .outline()
                    .small()
                    .label("Clear cache…")
                    .on_click(cx.listener(|this, _, window, cx| this.confirm_clear_cache(window, cx))),
            ),
        )
    }

    fn render_account(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let account = Session::global(cx).read(cx).account().cloned();
        section("Account", "", cx).when_some(account, |this, account| {
            this.child(
                h_flex()
                    .gap_4()
                    .justify_between()
                    .child(
                        v_flex()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(account.display_name()),
                            )
                            .when_some(account.email(), |this, email| {
                                this.child(
                                    div()
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(email),
                                )
                            }),
                    )
                    .child(
                        Button::new("sign-out")
                            .outline()
                            .small()
                            .label("Sign Out")
                            .on_click(|_, _, cx| {
                                Session::global(cx).update(cx, |session, cx| session.sign_out(cx))
                            }),
                    ),
            )
        })
    }
}

fn section(title: &'static str, description: &'static str, cx: &gpui_kit::App) -> gpui_kit::Div {
    v_flex().gap_3().child(
        v_flex()
            .gap_1()
            .child(
                div()
                    .text_base()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title),
            )
            .when(!description.is_empty(), |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(description),
                )
            }),
    )
}

fn format_bytes(bytes: u64) -> String {
    let gib = bytes as f64 / GIB as f64;
    if gib >= 1.0 {
        format!("{gib:.1} GB")
    } else {
        format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

impl Render for SettingsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().flex().justify_center().child(
            v_flex()
                .id("settings")
                .w_full()
                .max_w(gpui_kit::rems(42.))
                .h_full()
                .overflow_y_scroll()
                .px_4()
                .py_6()
                .gap_8()
                .child(
                    v_flex()
                        .gap_1()
                        .child(div().text_2xl().font_weight(FontWeight::BOLD).child("Settings"))
                        .child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child("Flags are saved to your account, so the browser and this app match."),
                        ),
                )
                .child(self.render_flags(cx))
                .child(self.render_cache(cx))
                .child(self.render_account(cx)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::format_bytes;

    #[test]
    fn formats_sizes() {
        assert_eq!(format_bytes(5 * 1024 * 1024 * 1024), "5.0 GB");
        assert_eq!(format_bytes(300 * 1024 * 1024), "300 MB");
    }
}
