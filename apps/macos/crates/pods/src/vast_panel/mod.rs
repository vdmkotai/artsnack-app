//! The managed Vast.ai instance (the Vast half of the web's
//! `BackendManagerDialog`): an offer browser while there is none, and its
//! card while there is.
//!
//! Searching hits Vast's API, so it runs once when the browser comes into view
//! and afterwards only when asked; typing a filter never searches. Renting,
//! starting, stopping, destroying and releasing an uncertain launch run only
//! from a click, and the server re-checks every offer's price before it rents.

mod browser;
mod card;

use std::time::Duration;

use artsnack_backend::{
    Backend, LiveQuery, NoArgs, QueryState,
    api::{
        runpod_backends::{self, BackendState, Provider, Selection},
        self_hosted_selection::{self, SetArgs},
        vast_backends::{
            self, BackendIdArgs, GpuType, LaunchArgs, Offer, OfferSort, OffersArgs, VastBackend,
        },
    },
};
use gpui_kit::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Subscription, Task, Window,
    component::{
        alert::Alert,
        input::{InputEvent, InputState},
        searchable_list::SearchableVec,
        select::{SelectEvent, SelectState},
        v_flex,
    },
    prelude::FluentBuilder as _,
};

use crate::{
    act,
    controls::{GpuChoice, is_changing, loading, number_input, number_value},
    format::{plain_number, usd},
    launch_dialog::{self, LaunchDialog},
    polling::{FAST_POLL, Poller, SLOW_POLL},
};
use browser::{clamp_disk_gb, gpu_choices};

const ANY_GPU: &str = "__any__";
const DEFAULT_GPU: &str = "H100 SXM";
const GPU_COUNTS: [u32; 4] = [1, 2, 4, 8];
// packages/shared/vast-backend.ts; the server clamps and caps again.
const DEFAULT_DISK_GB: f64 = 300.0;
const MIN_DISK_GB: f64 = 40.0;
const MAX_DISK_GB: f64 = 1000.0;
const DEFAULT_MIN_DISK_SPEED: f64 = 1000.0;
const MAX_HOURLY_USD: f64 = 10.0;
/// After this many failed status reads in a row, say so and back off.
const MAX_MISSED_POLLS: u32 = 5;
const MISSED_POLL_BACKOFF: Duration = Duration::from_secs(30);
/// See the RunPod panel: never report a launch failed while Vast is still
/// creating the instance.
const LAUNCH_DEADLINE: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, PartialEq)]
struct InstanceKey {
    id: String,
    state: BackendState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FormBusy {
    Search,
    Launch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lifecycle {
    Start,
    Stop,
    Destroy,
    /// "Check Vast.ai and release lock".
    Clear,
}

pub(crate) struct VastBackendPanel {
    open: bool,
    backend: Entity<LiveQuery<Option<VastBackend>>>,
    selection: Entity<LiveQuery<Option<Selection>>>,
    gpu_types: Vec<GpuType>,
    credit: Option<f64>,
    gpu_select: Entity<SelectState<SearchableVec<GpuChoice>>>,
    gpu_name: SharedString,
    num_gpus: u32,
    disk: Entity<InputState>,
    min_disk_speed: Entity<InputState>,
    min_download: Entity<InputState>,
    min_reliability: Entity<InputState>,
    max_price: Entity<InputState>,
    sort: OfferSort,
    offers: Vec<Offer>,
    /// The disk the shown offers were priced with.
    offers_disk_gb: f64,
    /// The offer being confirmed.
    chosen: Option<Offer>,
    // Scoped like the RunPod panel's: searching and launching exclude each
    // other, the lifecycle buttons exclude each other, selecting stands alone.
    form_busy: Option<FormBusy>,
    lifecycle: Option<Lifecycle>,
    selecting: bool,
    confirm_destroy: bool,
    error: Option<SharedString>,
    notice: Option<SharedString>,
    /// Whether the browser was showing at the last change, to search once
    /// when it comes into view.
    browsing: bool,
    /// Failed polls in a row, for one key.
    missed: (Option<InstanceKey>, u32),
    browse_tasks: Vec<Task<()>>,
    search_task: Option<Task<()>>,
    launch: Option<LaunchDialog>,
    poller: Poller<InstanceKey>,
    _subscriptions: Vec<Subscription>,
}

impl VastBackendPanel {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let backend = LiveQuery::new(vast_backends::CURRENT, &NoArgs {}, cx);
        let selection = LiveQuery::new(runpod_backends::SELECTION, &NoArgs {}, cx);
        let gpu_select = cx.new(|cx| {
            let mut select = SelectState::new(
                SearchableVec::new(gpu_choices(&[], DEFAULT_GPU)),
                None,
                window,
                cx,
            )
            .searchable(true);
            select.set_selected_value(&SharedString::from(DEFAULT_GPU), window, cx);
            select
        });
        let disk = number_input(
            DEFAULT_DISK_GB,
            10.0,
            MIN_DISK_GB,
            Some(MAX_DISK_GB),
            window,
            cx,
        );
        let min_disk_speed = number_input(DEFAULT_MIN_DISK_SPEED, 100.0, 0.0, None, window, cx);
        let min_download = number_input(500.0, 100.0, 0.0, None, window, cx);
        let min_reliability = number_input(98.0, 0.1, 0.0, Some(100.0), window, cx);
        let max_price = number_input(MAX_HOURLY_USD, 0.1, 0.0, Some(MAX_HOURLY_USD), window, cx);

        let mut subscriptions = vec![
            cx.observe_in(&backend, window, |this, _, window, cx| {
                this.sync(window, cx)
            }),
            cx.observe_in(&selection, window, |_, _, _, cx| cx.notify()),
            cx.subscribe_in(
                &gpu_select,
                window,
                |this, _, event: &SelectEvent<SearchableVec<GpuChoice>>, _, cx| {
                    if let SelectEvent::Confirm(Some(name)) = event {
                        this.gpu_name = name.clone();
                        cx.notify();
                    }
                },
            ),
        ];
        for input in [
            &disk,
            &min_disk_speed,
            &min_download,
            &min_reliability,
            &max_price,
        ] {
            subscriptions.push(cx.subscribe(input, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }));
        }

        let poller = Poller::new(window, cx, Self::poller, Self::poll_instance);
        let mut this = Self {
            open: true,
            backend,
            selection,
            gpu_types: Vec::new(),
            credit: None,
            gpu_select,
            gpu_name: DEFAULT_GPU.into(),
            num_gpus: 1,
            disk,
            min_disk_speed,
            min_download,
            min_reliability,
            max_price,
            sort: OfferSort::Price,
            offers: Vec::new(),
            offers_disk_gb: DEFAULT_DISK_GB,
            chosen: None,
            form_busy: None,
            lifecycle: None,
            selecting: false,
            confirm_destroy: false,
            error: None,
            notice: None,
            browsing: false,
            missed: (None, 0),
            browse_tasks: Vec::new(),
            search_task: None,
            launch: None,
            poller,
            _subscriptions: subscriptions,
        };
        this.sync(window, cx);
        this
    }

    /// Whether the Vast tab is showing. Polling, and the search when the
    /// browser appears, run only while it is.
    pub fn set_open(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.open != open {
            self.open = open;
            self.sync(window, cx);
        }
    }

    /// The instance, `Some(None)` when there is none, `None` while unknown.
    fn known(&self, cx: &App) -> Option<Option<VastBackend>> {
        match self.backend.read(cx).state() {
            QueryState::Ready { data, .. } => Some((**data).clone()),
            _ => None,
        }
    }

    fn instance(&self, cx: &App) -> Option<VastBackend> {
        self.known(cx).flatten()
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let known = self.known(cx);
        let instance = known.clone().flatten();
        let key = instance
            .as_ref()
            .filter(|row| self.open && row.active && row.state != BackendState::Destroyed)
            .map(|row| InstanceKey {
                id: row.id.clone(),
                state: row.state,
            });
        self.poller.set_key(key);

        let browsing = self.open && matches!(known, Some(None));
        if browsing && !self.browsing {
            self.load_catalog(cx);
            self.search(window, cx);
        }
        self.browsing = browsing;
        if instance.is_none() {
            self.confirm_destroy = false;
        }
        cx.notify();
    }

    fn poller(this: &mut Self) -> &mut Poller<InstanceKey> {
        &mut this.poller
    }

    fn poll_instance(_: &mut Self, key: InstanceKey, cx: &mut Context<Self>) -> Task<Duration> {
        let request = act(
            vast_backends::REFRESH,
            &BackendIdArgs { id: key.id.clone() },
            cx,
        );
        cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                if this.missed.0.as_ref() != Some(&key) {
                    this.missed = (Some(key.clone()), 0);
                }
                match result {
                    Ok(()) => this.missed.1 = 0,
                    Err(error) => {
                        this.missed.1 += 1;
                        if this.missed.1 >= MAX_MISSED_POLLS && this.poller.is_current(&key) {
                            this.error = Some(
                                format!(
                                    "Vast.ai status could not be refreshed: {}",
                                    error.user_message()
                                )
                                .into(),
                            );
                            cx.notify();
                        }
                    }
                }
                if !is_changing(key.state) {
                    SLOW_POLL
                } else if this.missed.1 >= MAX_MISSED_POLLS {
                    MISSED_POLL_BACKOFF
                } else {
                    FAST_POLL
                }
            })
            .unwrap_or(SLOW_POLL)
        })
    }

    // MARK: The offer browser

    /// The GPU picker's types and the account's credit. A failure leaves the
    /// picker as it was; the bare name list stands in for the rich catalogue.
    fn load_catalog(&mut self, cx: &mut Context<Self>) {
        let types = act(vast_backends::GPU_TYPES, &NoArgs {}, cx);
        let types = cx.spawn(async move |this, cx| {
            let types = match types.await {
                Ok(types) => Some(types),
                Err(_) => {
                    let Ok(names) =
                        this.update(cx, |_, cx| act(vast_backends::GPU_NAMES, &NoArgs {}, cx))
                    else {
                        return;
                    };
                    names
                        .await
                        .ok()
                        .map(|names| names.into_iter().map(GpuType::named).collect())
                }
            };
            if let Some(types) = types {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.gpu_types = types;
                    let choices = gpu_choices(&this.gpu_types, &this.gpu_name);
                    let selected = this.gpu_name.clone();
                    this.gpu_select.update(cx, |select, cx| {
                        select.set_items(SearchableVec::new(choices), window, cx);
                        select.set_selected_value(&selected, window, cx);
                    });
                    cx.notify();
                });
            }
        });
        let credit = act(vast_backends::ACCOUNT_CREDIT, &NoArgs {}, cx);
        let credit = cx.spawn(async move |this, cx| {
            if let Ok(credit) = credit.await {
                let _ = this.update(cx, |this, cx| {
                    this.credit = credit;
                    cx.notify();
                });
            }
        });
        self.browse_tasks = vec![types, credit];
    }

    fn search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let positive = |value: f64| (value > 0.0).then_some(value);
        let disk_gb = number_value(&self.disk, cx);
        let args = OffersArgs {
            gpu_name: (self.gpu_name.as_ref() != ANY_GPU).then(|| self.gpu_name.to_string()),
            num_gpus: self.num_gpus,
            disk_gb,
            min_disk_bandwidth: positive(number_value(&self.min_disk_speed, cx)),
            min_download_mbps: positive(number_value(&self.min_download, cx)),
            min_reliability: positive(number_value(&self.min_reliability, cx))
                .map(|percent| percent / 100.0),
            max_hourly_usd: positive(number_value(&self.max_price, cx)),
            sort: self.sort,
        };
        let searched_disk_gb = clamp_disk_gb(disk_gb);
        self.form_busy = Some(FormBusy::Search);
        self.error = None;
        self.chosen = None;
        cx.notify();
        let request = act(vast_backends::OFFERS, &args, cx);
        self.search_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(offers) => {
                        this.offers = offers;
                        this.offers_disk_gb = searched_disk_gb;
                    }
                    Err(error) => {
                        this.error = Some(error.user_message());
                        this.offers.clear();
                    }
                }
                this.form_busy = None;
                cx.notify();
            });
        }));
    }

    fn choose(&mut self, offer: Offer, window: &mut Window, cx: &mut Context<Self>) {
        if self.form_busy.is_some() || !offer.compatible {
            return;
        }
        self.error = None;
        let summary = self.launch_summary(&offer);
        self.chosen = Some(offer);
        self.launch = Some(launch_dialog::open(
            "Confirm paid rental".into(),
            artsnack_backend::api::pod_downloads::PodProfile::Image,
            summary,
            Self::rent,
            window,
            cx,
        ));
        cx.notify();
    }

    fn launch_summary(&self, offer: &Offer) -> Vec<SharedString> {
        let mut summary = vec![
            format!(
                "Rent {}\u{d7} {} with {} GB of disposable local disk for {}/hr. The server re-checks availability and price before charging; a change over 10% requires a fresh confirmation. Bandwidth is separate: \u{2193} {}/TB and \u{2191} {}/TB on this host.",
                offer.num_gpus.round() as u32,
                offer.gpu_name,
                plain_number(self.offers_disk_gb),
                usd(offer.hourly_usd),
                usd(offer.download_cost_per_tb_usd),
                usd(offer.upload_cost_per_tb_usd),
            )
            .into(),
        ];
        if let Some(credit) = self.credit
            && offer.hourly_usd > 0.0
        {
            summary.push(
                format!(
                    "Your {} Vast credit covers roughly {:.1} hours at this rate before other charges.",
                    usd(credit),
                    credit / offer.hourly_usd
                )
                .into(),
            );
        }
        summary
    }

    /// The confirmation's "Confirm and launch".
    fn rent(&mut self, skip_models: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        if self.form_busy.is_some() {
            return;
        }
        let Some(offer) = self.chosen.clone() else {
            return;
        };
        let args = LaunchArgs {
            offer_id: offer.id,
            disk_gb: self.offers_disk_gb,
            displayed_hourly_usd: offer.hourly_usd,
            skip_models: Some(skip_models),
        };
        self.form_busy = Some(FormBusy::Launch);
        self.error = None;
        self.sync_launch(cx);
        cx.notify();
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.act_within(vast_backends::LAUNCH, &args, LAUNCH_DEADLINE, cx)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.form_busy = None;
                match result {
                    Ok(_) => {
                        this.chosen = None;
                        if let Some(launch) = this.launch.take() {
                            launch.close(window, cx);
                        }
                    }
                    Err(error) => this.error = Some(error.user_message()),
                }
                this.sync_launch(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn sync_launch(&self, cx: &mut Context<Self>) {
        if let Some(launch) = &self.launch {
            launch.sync(self.form_busy.is_some(), self.error.clone(), None, cx);
        }
    }

    // MARK: The instance's card

    fn control(&mut self, kind: Lifecycle, cx: &mut Context<Self>) {
        let Some(instance) = self.instance(cx) else {
            return;
        };
        if self.lifecycle.is_some() {
            return;
        }
        self.lifecycle = Some(kind);
        self.error = None;
        self.notice = None;
        cx.notify();
        let args = BackendIdArgs { id: instance.id };
        if kind == Lifecycle::Clear {
            let request = act(vast_backends::CLEAR_UNCERTAIN_LAUNCH, &args, cx);
            cx.spawn(async move |this, cx| {
                let result = request.await;
                let _ = this.update(cx, |this, cx| {
                    this.lifecycle = None;
                    match result {
                        Ok(cleared) if cleared.found_instance => {
                            this.notice = Some(
                                "Vast.ai found the instance and restored control of it. You can now destroy it safely."
                                    .into(),
                            );
                        }
                        Ok(_) => {}
                        Err(error) => this.error = Some(error.user_message()),
                    }
                    cx.notify();
                });
            })
            .detach();
            return;
        }
        let request = match kind {
            Lifecycle::Start => act(vast_backends::START, &args, cx),
            Lifecycle::Stop => act(vast_backends::STOP, &args, cx),
            _ => act(vast_backends::DESTROY, &args, cx),
        };
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.lifecycle = None;
                match result {
                    Ok(()) => this.confirm_destroy = false,
                    Err(error) => this.error = Some(error.user_message()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn use_for_generations(&mut self, cx: &mut Context<Self>) {
        if self.selecting {
            return;
        }
        self.selecting = true;
        self.error = None;
        cx.notify();
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(
                self_hosted_selection::SET,
                &SetArgs {
                    provider: Provider::Vast,
                },
                cx,
            )
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.selecting = false;
                if let Err(error) = result {
                    this.error = Some(error.user_message());
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for VastBackendPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let failure = self.backend.read(cx).error().cloned();
        let body = match (self.known(cx), failure) {
            (Some(Some(instance)), _) => self.render_instance(&instance, cx),
            (Some(None), _) => self.render_browser(cx),
            // Without the row it is unknown whether an instance is running;
            // the offer browser would invite renting a second one.
            (None, Some(message)) => Alert::error("vast-state-error", message)
                .title("Could not read the Vast.ai state")
                .into_any_element(),
            (None, None) => loading("Loading backend state\u{2026}", cx).into_any_element(),
        };
        v_flex()
            .gap_4()
            .when_some(self.error.clone(), |this, error| {
                this.child(Alert::error("vast-error", error))
            })
            .when_some(self.notice.clone(), |this, notice| {
                this.child(Alert::info("vast-notice", notice))
            })
            .child(body)
    }
}
