//! The video pods: the chip in the tab's header, the "Video pods" dialog
//! behind it, and each ready pod's "Models on the pod" (the web's
//! `h3/video-pod-status.tsx`).
//!
//! Several pods may run side by side (say an RTX PRO 6000 for H3 and a B200
//! for LTX); each gets its own card with the shared RunPod panel, and one more
//! can be rented below them. The dialog's panels live as long as it is open,
//! so closing it stops their polling.
//!
//! A rent form outlives the moment its pod appears. The server writes the
//! pod's row (a reservation) before RunPod has created the pod, and the
//! launch request — with its confirmation — answers to the form that sent it;
//! so the form is hidden then, but kept until the launch has answered.

use std::time::Duration;

use artsnack_backend::{
    Backend, LiveQuery,
    api::{
        pod_downloads::{self, DownloadsStatus, PodProfile, PodStatusArgs},
        runpod_backend_store::RunpodBackend,
        runpod_backends::BackendState,
    },
};
use artsnack_pods::{
    PodCatalogVersion, Poller, RunpodBackendPanel, RunpodPanelEvent, RunpodPanelOptions,
};
use gpui_kit::{
    App, AppContext as _, ClickEvent, Context, Entity, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Sizable as _, WindowExt as _,
        alert::Alert,
        button::Button,
        dialog::{DialogClose, DialogFooter},
        h_flex,
        progress::Progress,
        spinner::Spinner,
        tag::Tag,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    relative, rems,
};

/// Active video pods at once (`MAX_VIDEO_PODS` in runpodBackendStore.ts).
const MAX_VIDEO_PODS: usize = 4;
/// While a file is arriving the bar should move; otherwise the list changes
/// only when a "To pod" order lands, so a slow look is enough.
const DOWNLOAD_POLL: Duration = Duration::from_secs(3);
const IDLE_DOWNLOAD_POLL: Duration = Duration::from_secs(30);

pub(crate) type VideoPods = Entity<LiveQuery<Vec<RunpodBackend>>>;

/// Short name for a pod in lists and the "Run on" picker (`videoPodLabel`):
/// "2× RTX PRO 6000 · abcde".
pub(crate) fn video_pod_label(pod: &RunpodBackend) -> String {
    let gpu = pod
        .gpu_name
        .strip_prefix("NVIDIA ")
        .unwrap_or(&pod.gpu_name);
    let count = if pod.num_gpus > 1.0 {
        format!("{}× ", pod.num_gpus as u32)
    } else {
        String::new()
    };
    let id = pod
        .pod_id
        .as_deref()
        .map(|id| format!(" · {}", id.chars().take(5).collect::<String>()))
        .unwrap_or_default();
    format!("{count}{gpu}{id}")
}

/// A ready pod whose boot finished with problems (its message says so).
pub(crate) fn has_warnings(pod: &RunpodBackend) -> bool {
    pod.message.to_lowercase().contains("with warnings")
}

/// B300 (Blackwell Ultra) has almost no INT8 throughput.
pub(crate) fn is_b300(pod: &RunpodBackend) -> bool {
    pod.gpu_name.to_lowercase().contains("b300")
}

/// The header's chip: how the video pods are, and the way into the dialog.
pub(crate) fn render_chip(
    pods: Option<&[RunpodBackend]>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    let list = pods.unwrap_or_default();
    let ready: Vec<&RunpodBackend> = list
        .iter()
        .filter(|pod| pod.state == BackendState::Ready)
        .collect();
    let booting = list.iter().find(|pod| pod.state.is_booting());
    let degraded = ready.iter().any(|pod| has_warnings(pod));
    let progress = booting.map(|pod| pod.progress.clamp(0.0, 100.0));
    let label: SharedString = match (pods, list) {
        (None, _) => "Video pod".into(),
        (Some(_), []) => "Start video pod".into(),
        (Some(_), [_]) if degraded => "Video pod has problems".into(),
        (Some(_), [pod]) if pod.state == BackendState::Ready => {
            let label = video_pod_label(pod);
            let gpu = label.split(" · ").next().unwrap_or_default();
            format!("Video pod ready · {gpu}").into()
        }
        (Some(_), [pod]) => format!("Video pod · {}", pod.state.label()).into(),
        (Some(_), _) => format!("{} video pods · {} ready", list.len(), ready.len()).into(),
    };
    let dot = if booting.is_some() || degraded {
        theme.warning
    } else if !ready.is_empty() {
        theme.success
    } else if pods.is_none() {
        theme.muted_foreground
    } else {
        theme.danger
    };
    let tooltip = booting
        .map(|pod| pod.message.clone())
        .filter(|message| !message.is_empty());
    let bar = theme.primary;
    let badge = theme.primary.opacity(0.25);

    div()
        .relative()
        .child(
            Button::new("video-pods")
                .outline()
                .small()
                .child(div().size_2().rounded_full().bg(dot))
                .child(label)
                .when_some(progress, |this, progress| {
                    this.child(
                        div()
                            .px_1()
                            .rounded(theme.radius)
                            .bg(badge)
                            .text_xs()
                            .font_family(theme.mono_font_family.clone())
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(format!("{}%", progress.round() as i64)),
                    )
                })
                .map(|this| {
                    if pods.is_none() {
                        this.child(Spinner::new().xsmall())
                    } else {
                        this.child(Icon::new(IconName::Settings2).xsmall())
                    }
                })
                .when_some(tooltip, |this, message| this.tooltip(message))
                .on_click(on_click),
        )
        .when_some(progress, |this, progress| {
            // The boot's progress along the chip's bottom edge, tracking the
            // same number the pod's card shows.
            this.child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .h_0p5()
                    .w(relative((progress.max(2.0) / 100.0) as f32))
                    .bg(bar),
            )
        })
}

/// Opens "Video pods" with fresh panels; closing it drops them.
pub(crate) fn open_dialog(pods: VideoPods, window: &mut Window, cx: &mut App) {
    let content = cx.new(|cx| VideoPodsDialog::new(pods, window, cx));
    window.open_dialog(cx, move |dialog, window, _| {
        dialog
            .title(
                h_flex()
                    .gap_2()
                    .child(Icon::new(IconName::Video).small())
                    .child("Video pods (MiniMax H3 · LTX 2.3)"),
            )
            .w(rems(48.).to_pixels(window.rem_size()))
            // Nothing here commits on Enter: an Enter typed into a rent form
            // must not close a dialog that manages paid pods.
            .on_ok(|_, _, _| false)
            .child(content.clone())
            .footer(DialogFooter::new().child(
                DialogClose::new().child(Button::new("close-video-pods").outline().label("Close")),
            ))
    });
}

struct PodCard {
    id: String,
    panel: Entity<RunpodBackendPanel>,
    /// Only while the pod is ready: before that there is no downloader to ask.
    downloads: Option<Entity<PodDownloads>>,
}

/// A rent form and the subscription that hears its launch.
struct LaunchSlot {
    panel: Entity<RunpodBackendPanel>,
    _subscription: Subscription,
}

impl LaunchSlot {
    fn is_launching(&self, cx: &App) -> bool {
        self.panel.read(cx).is_launching()
    }
}

struct VideoPodsDialog {
    pods: VideoPods,
    cards: Vec<PodCard>,
    /// The rent form while no video pod exists (and after, until its launch
    /// has answered).
    first: Option<LaunchSlot>,
    /// "Rent another video pod", once asked for.
    another: Option<LaunchSlot>,
    _subscriptions: Vec<Subscription>,
}

impl VideoPodsDialog {
    fn new(pods: VideoPods, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subscriptions =
            vec![cx.observe_in(&pods, window, |this, _, window, cx| this.sync(window, cx))];
        let mut this = Self {
            pods,
            cards: Vec::new(),
            first: None,
            another: None,
            _subscriptions: subscriptions,
        };
        this.sync(window, cx);
        this
    }

    fn list(&self, cx: &App) -> Option<Vec<RunpodBackend>> {
        self.pods.read(cx).data().map(|pods| pods.as_ref().clone())
    }

    /// A card per pod, in the query's order (oldest first).
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(list) = self.list(cx) else {
            return;
        };
        let mut cards = Vec::with_capacity(list.len());
        for pod in &list {
            let mut card = match self.cards.iter().position(|card| card.id == pod.id) {
                Some(ix) => self.cards.remove(ix),
                None => PodCard {
                    id: pod.id.clone(),
                    panel: cx.new(|cx| {
                        RunpodBackendPanel::new(
                            RunpodPanelOptions::video().with_backend_id(pod.id.clone()),
                            window,
                            cx,
                        )
                    }),
                    downloads: None,
                },
            };
            if pod.state == BackendState::Ready {
                if card.downloads.is_none() {
                    let id = pod.id.clone();
                    card.downloads = Some(cx.new(|cx| PodDownloads::new(id, window, cx)));
                }
            } else {
                card.downloads = None;
            }
            cards.push(card);
        }
        self.cards = cards;

        // A form whose launch has not answered stays, hidden if need be.
        if list.is_empty() {
            if self.first.is_none() {
                self.first = Some(self.launch_slot(window, cx));
            }
        } else if self
            .first
            .as_ref()
            .is_some_and(|slot| !slot.is_launching(cx))
        {
            self.first = None;
        }
        if (list.is_empty() || list.len() >= MAX_VIDEO_PODS)
            && self
                .another
                .as_ref()
                .is_some_and(|slot| !slot.is_launching(cx))
        {
            self.another = None;
        }
        cx.notify();
    }

    fn launch_slot(&mut self, window: &mut Window, cx: &mut Context<Self>) -> LaunchSlot {
        let panel = cx.new(|cx| {
            RunpodBackendPanel::new(RunpodPanelOptions::video().launch_only(true), window, cx)
        });
        // The new pod arrives through the query and gets its own card; the
        // rent form for "another" has done its job. Either way the launch has
        // answered, so a form kept only for it can go.
        let subscription = cx.subscribe_in(
            &panel,
            window,
            |this, panel, event: &RunpodPanelEvent, window, cx| {
                if matches!(event, RunpodPanelEvent::Launched { .. })
                    && this
                        .another
                        .as_ref()
                        .is_some_and(|slot| slot.panel == *panel)
                {
                    this.another = None;
                }
                this.sync(window, cx);
            },
        );
        LaunchSlot {
            panel,
            _subscription: subscription,
        }
    }
}

impl Render for VideoPodsDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let list = self.list(cx).unwrap_or_default();
        let any_ready = list.iter().any(|pod| pod.state == BackendState::Ready);
        let room = !list.is_empty() && list.len() < MAX_VIDEO_PODS;
        let theme = cx.theme().clone();
        v_flex()
            .gap_4()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child("RunPod pods for video. Each boots the H3 base models in a few minutes; LTX 2.3 and your checkpoints and LoRAs from \u{201c}To pod\u{201d} follow right after. Several can run at once — pick one per clip in the form, or let Auto send each clip to the least busy pod that has its models. Each bills by the hour until you stop or destroy it."),
            )
            .when(list.is_empty(), |this| {
                this.children(self.first.as_ref().map(|slot| slot.panel.clone()))
            })
            .children(self.cards.iter().filter_map(|card| {
                let pod = list.iter().find(|pod| pod.id == card.id)?;
                let warning = pod.state == BackendState::Ready && has_warnings(pod);
                Some(
                    v_flex()
                        .gap_3()
                        .p_3()
                        .rounded(theme.radius_lg)
                        .border_1()
                        .border_color(theme.border)
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.muted_foreground)
                                .child(video_pod_label(pod)),
                        )
                        .when(warning, |this| {
                            this.child(Alert::warning(
                                SharedString::from(format!("video-pod-warning-{}", pod.id)),
                                format!(
                                    "{} Generations on this pod will likely fail; destroying it and renting a new one usually fixes it.",
                                    pod.message
                                ),
                            ))
                        })
                        .child(card.panel.clone())
                        .children(card.downloads.clone()),
                )
            }))
            .when(room, |this| match self.another.as_ref().map(|slot| &slot.panel) {
                Some(panel) => this.child(
                    v_flex()
                        .gap_2()
                        .p_3()
                        .rounded(theme.radius_lg)
                        .border_1()
                        .border_dashed()
                        .border_color(theme.border)
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .child("Another video pod"),
                        )
                        .child(panel.clone()),
                ),
                None => this.child(
                    Button::new("rent-another-video-pod")
                        .outline()
                        .w_full()
                        .icon(IconName::Plus)
                        .label("Rent another video pod…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.another = Some(this.launch_slot(window, cx));
                            cx.notify();
                        })),
                ),
            })
            .when(any_ready, |this| {
                this.child(
                    h_flex()
                        .gap_1p5()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(Icon::new(IconName::Download).xsmall())
                        .child("New models appear in the tab\u{2019}s lists as soon as they finish."),
                )
            })
    }
}

/// What a ready video pod is fetching (`VideoPodDownloads`). The base set at
/// boot is not on this list — provision.sh downloads it before the pod
/// reports ready — but every custom checkpoint and LoRA from the provisioning
/// manifest after boot is.
struct PodDownloads {
    status: Option<DownloadsStatus>,
    /// The last answer that came back, kept through a failed read so a
    /// download that finished meanwhile is still noticed.
    last_read: Option<DownloadsStatus>,
    poller: Poller<String>,
}

impl PodDownloads {
    fn new(backend_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut poller = Poller::new(window, cx, |this: &mut Self| &mut this.poller, Self::poll);
        poller.set_key(Some(backend_id));
        Self {
            status: None,
            last_read: None,
            poller,
        }
    }

    fn poll(&mut self, backend_id: String, cx: &mut Context<Self>) -> Task<Duration> {
        let args = PodStatusArgs {
            profile: Some(PodProfile::Video),
            backend_id: Some(backend_id.clone()),
        };
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(pod_downloads::POD_STATUS, &args, cx)
        });
        cx.spawn(async move |this, cx| {
            // A failed read hides the list, as the web's `.catch(() => null)`.
            let status = request.await.ok();
            let downloading = status
                .as_ref()
                .is_some_and(|status| status.jobs.iter().any(|job| job.status == "downloading"));
            let _ = this.update(cx, |this, cx| {
                if !this.poller.is_current(&backend_id) {
                    return;
                }
                if let Some(after) = &status {
                    // A model that just landed belongs in the form's lists
                    // now, not at the next fallback read.
                    let landed = this
                        .last_read
                        .as_ref()
                        .is_some_and(|before| newly_done(before, after));
                    this.last_read = Some(after.clone());
                    if landed {
                        PodCatalogVersion::bump(cx);
                    }
                }
                // An identical answer changes nothing on screen.
                if this.status != status {
                    this.status = status;
                    cx.notify();
                }
            });
            if downloading {
                DOWNLOAD_POLL
            } else {
                IDLE_DOWNLOAD_POLL
            }
        })
    }
}

/// Whether a job is done in `after` that was not in `before` (it was still
/// downloading, or arrived and finished between two reads). The first read
/// has no `before`: what it finds done was there already.
fn newly_done(before: &DownloadsStatus, after: &DownloadsStatus) -> bool {
    after.jobs.iter().any(|job| {
        job.status == "done"
            && !before.jobs.iter().any(|old| {
                old.dir == job.dir && old.filename == job.filename && old.status == "done"
            })
    })
}

fn gigabytes(bytes: f64) -> String {
    format!("{:.1} GB", bytes / 1e9)
}

impl Render for PodDownloads {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(status) = &self.status else {
            return div().into_any_element();
        };
        let theme = cx.theme().clone();
        v_flex()
            .gap_2()
            .p_3()
            .rounded(theme.radius_lg)
            .border_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Models on the pod"),
                    )
                    .when_some(status.disk.as_ref(), |this, disk| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(format!(
                                    "{} GB free of {} GB",
                                    crate::form::plain(disk.free_gb),
                                    crate::form::plain(disk.total_gb)
                                )),
                        )
                    }),
            )
            .map(|this| {
                if status.jobs.is_empty() {
                    return this.child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("No downloads yet. Custom checkpoints and LoRAs from the provisioning manifest appear here while they download."),
                    );
                }
                this.children(status.jobs.iter().map(|job| {
                    let path = format!("{}/{}", job.dir, job.filename);
                    let percent = job
                        .expected_bytes
                        .filter(|expected| *expected > 0.0)
                        .map(|expected| (job.bytes / expected * 100.0).round().min(100.0));
                    let failed = job.status == "error";
                    let state: SharedString = match job.status.as_str() {
                        "done" => "ready".into(),
                        "error" => "failed".into(),
                        _ => match percent {
                            Some(percent) => format!("{}%", percent as i64).into(),
                            None => gigabytes(job.bytes).into(),
                        },
                    };
                    v_flex()
                        .id(SharedString::from(format!("download-{path}")))
                        .gap_1()
                        .tooltip({
                            let path = SharedString::from(path.clone());
                            move |window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(path.clone())
                                    .build(window, cx)
                            }
                        })
                        .child(
                            h_flex()
                                .justify_between()
                                .gap_2()
                                .text_xs()
                                .child(div().min_w_0().truncate().child(job.filename.clone()))
                                .child(if failed {
                                    Tag::danger().xsmall().child(state).into_any_element()
                                } else {
                                    div()
                                        .flex_shrink_0()
                                        .text_color(theme.muted_foreground)
                                        .child(state)
                                        .into_any_element()
                                }),
                        )
                        .when(job.status == "downloading", |this| {
                            this.child(
                                Progress::new(SharedString::from(format!("download-bar-{path}")))
                                    .value(percent.unwrap_or(5.0) as f32),
                            )
                        })
                        .when_some(job.error.clone(), |this, error| {
                            this.child(div().text_xs().text_color(theme.danger).child(error))
                        })
                }))
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use artsnack_backend::api::pod_downloads::{DownloadJob, DownloadsStatus};

    use super::newly_done;

    fn status(jobs: &[(&str, &str)]) -> DownloadsStatus {
        DownloadsStatus {
            jobs: jobs
                .iter()
                .map(|(filename, status)| DownloadJob {
                    filename: filename.to_string(),
                    dir: "loras".into(),
                    status: status.to_string(),
                    bytes: 0.0,
                    expected_bytes: None,
                    error: None,
                })
                .collect(),
            disk: None,
        }
    }

    #[test]
    fn a_download_that_finishes_is_news_one_already_done_is_not() {
        let before = status(&[("a.safetensors", "downloading"), ("b.safetensors", "done")]);
        assert!(newly_done(
            &before,
            &status(&[("a.safetensors", "done"), ("b.safetensors", "done")])
        ));
        assert!(!newly_done(
            &before,
            &status(&[("a.safetensors", "downloading"), ("b.safetensors", "done")])
        ));
        // Ordered and finished between two reads.
        assert!(newly_done(&before, &status(&[("c.safetensors", "done")])));
    }
}
