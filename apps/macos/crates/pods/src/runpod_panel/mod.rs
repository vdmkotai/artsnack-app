//! One managed RunPod pod (the web's `RunpodBackendPanel`): the rent form
//! while there is none, and its card while there is.
//!
//! The backend manager shows the image pod's panel. The self-hosted video tab
//! embeds the same panel with the video purpose — once per running video pod,
//! by id, and once more launch-only to rent another. A video pod boots the
//! video provisioning profile, always on the CUDA 13.0 image, and never takes
//! part in the image pod's "use for new generations" choice.
//!
//! Renting, starting, stopping and destroying run only from a click. The server
//! re-checks the price at launch and rejects a rise of more than 10% or a price
//! over its cap; this form also refuses to send what it can already see is
//! over the cap or out of stock.

mod card;
mod catalog;
mod form;

use std::time::Duration;

use artsnack_backend::{
    Backend, CallError, LiveQuery, NoArgs, QueryState,
    api::{
        pod_downloads::PodProfile,
        runpod_backend_actions::{self, BackendIdArgs, CloudAvailability, GpuType, LaunchArgs},
        runpod_backend_store::{self, ByIdArgs, CloudType, RunpodBackend, TemplateProfile},
        runpod_backends::{self, BackendState, Provider, Purpose, RunpodCurrentArgs, Selection},
        self_hosted_selection::{self, SetArgs},
    },
};
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, IntoElement, Render, SharedString,
    Subscription, Task, Window,
    component::{
        alert::Alert,
        input::{InputEvent, InputState},
        searchable_list::SearchableVec,
        select::{SelectEvent, SelectState},
    },
};

use crate::{
    act,
    controls::{GpuChoice, is_changing, loading, number_input, number_value},
    format::{plain_number, usd},
    launch_dialog::{self, LaunchDialog},
    polling::{FAST_POLL, Poller, SLOW_POLL},
};
use catalog::{
    default_gpu_id, gpu_description, is_offered, is_rentable, offers_count, total_hourly_usd,
};

// The form's defaults and limits, as packages/shared/runpod-backend.ts sets
// them; the server clamps the disks and caps the price again.
const IMAGE_CONTAINER_DISK_GB: f64 = 300.0;
/// The video pod holds H3 and LTX 2.3 side by side: two base sets, the
/// community checkpoints (20–30 GB each) and their LoRAs.
const VIDEO_CONTAINER_DISK_GB: f64 = 500.0;
const MIN_CONTAINER_DISK_GB: f64 = 40.0;
const MAX_CONTAINER_DISK_GB: f64 = 1000.0;
const MAX_VOLUME_DISK_GB: f64 = 1000.0;
/// The server's default safety cap, and the form's ceiling.
const MAX_HOURLY_USD: f64 = 10.0;
const GPU_COUNTS: [u32; 5] = [1, 2, 3, 4, 8];

/// Launching creates the pod and waits for RunPod's answer. Waiting as long as
/// Convex lets an action run means the form never reports a failure — and so
/// invites a second rental — while the first is still being made.
const LAUNCH_DEADLINE: Duration = Duration::from_secs(600);
/// Failed status reads in a row stretch the wait between polls, up to this.
const MAX_REFRESH_BACKOFF: Duration = Duration::from_secs(300);

/// The wait before the next status read: the state's pace, doubled for each
/// failure in a row, up to [`MAX_REFRESH_BACKOFF`].
fn refresh_wait(base: Duration, failures: u32) -> Duration {
    if failures == 0 {
        return base;
    }
    base.saturating_mul(1 << failures.min(8))
        .min(MAX_REFRESH_BACKOFF.max(base))
}

/// Which pod a [`RunpodBackendPanel`] manages.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunpodPanelOptions {
    purpose: Purpose,
    backend_id: Option<String>,
    launch_only: bool,
}

impl RunpodPanelOptions {
    /// The image pod: the active one's card, or the form to rent it.
    pub fn image() -> Self {
        Self::default()
    }

    /// A video pod: the oldest active one, unless narrowed by
    /// [`Self::with_backend_id`] or [`Self::launch_only`].
    pub fn video() -> Self {
        Self {
            purpose: Purpose::Video,
            ..Self::default()
        }
    }

    /// Manage this pod (`runpodBackends` id); video pods run side by side.
    pub fn with_backend_id(mut self, id: impl Into<String>) -> Self {
        self.backend_id = Some(id.into());
        self
    }

    /// Show only the rent form, for another pod next to running ones.
    pub fn launch_only(mut self, launch_only: bool) -> Self {
        self.launch_only = launch_only;
        self
    }

    pub fn purpose(&self) -> Purpose {
        self.purpose
    }

    pub fn backend_id(&self) -> Option<&str> {
        self.backend_id.as_deref()
    }

    pub fn is_launch_only(&self) -> bool {
        self.launch_only
    }
}

/// What the poll is for: the state is part of it, so every transition polls at once.
#[derive(Clone, Debug, PartialEq)]
struct PodKey {
    id: String,
    pod_id: String,
    state: BackendState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FormBusy {
    Catalog,
    Launch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lifecycle {
    Start,
    Stop,
    Destroy,
}

/// A launch's outcome, for an owner that lays out several panels (the video
/// tab adds a card for the new pod from its own query, and keeps a rent form
/// alive until its launch has answered — see [`RunpodBackendPanel::is_launching`]).
#[derive(Clone, Debug)]
pub enum RunpodPanelEvent {
    Launched {
        pod_id: String,
    },
    /// The launch was refused or failed; the panel shows why.
    LaunchFailed,
}

/// Launch and manage one RunPod pod. See the module docs, and
/// [`RunpodPanelOptions`] for which pod.
///
/// The panel polls RunPod while it is open and its pod exists — every 5 s
/// while the pod is changing state, every 60 s otherwise, stretched after
/// failed reads — and loads the GPU catalogue when it opens without a pod. An
/// owner that keeps the panel while it is off screen says so with
/// [`Self::set_open`].
///
/// Status reads and Start/Stop/Destroy never overlap: a refresh that went out
/// before a click could otherwise write back the state the click replaced
/// (an old "stopped" over a fresh "starting"). Refresh goes through the poll,
/// so there is at most one read out; a lifecycle click waits for a read in
/// flight, and no read goes out while the action runs.
pub struct RunpodBackendPanel {
    options: RunpodPanelOptions,
    open: bool,
    /// `None` when launch-only: there is no pod to show.
    backend: Option<Entity<LiveQuery<Option<RunpodBackend>>>>,
    selection: Entity<LiveQuery<Option<Selection>>>,
    gpus: Vec<GpuType>,
    balance: Option<f64>,
    gpu_type_id: Option<SharedString>,
    gpu_count: u32,
    cloud: CloudType,
    template: TemplateProfile,
    gpu_select: Entity<SelectState<SearchableVec<GpuChoice>>>,
    container_disk: Entity<InputState>,
    volume_disk: Entity<InputState>,
    min_disk_speed: Entity<InputState>,
    min_download: Entity<InputState>,
    max_price: Entity<InputState>,
    // Busy is scoped per kind of action: a slow Refresh or Stop must not lock
    // buttons it has nothing to do with. Start, Stop and Destroy exclude one
    // another; the catalogue load and the launch exclude one another.
    form_busy: Option<FormBusy>,
    lifecycle: Option<Lifecycle>,
    /// A lifecycle click waiting for the status read that was out.
    queued_lifecycle: Option<(Lifecycle, String)>,
    /// Refresh was pressed and its read has not answered yet.
    refreshing: bool,
    /// Refresh was pressed; the next status read is its read.
    refresh_requested: bool,
    /// A status read (poll or Refresh) is out.
    refresh_in_flight: bool,
    /// Failed status reads in a row.
    refresh_failures: u32,
    selecting: bool,
    confirm_destroy: bool,
    error: Option<SharedString>,
    refresh_error: Option<SharedString>,
    /// Whether the catalogue was wanted at the last change, to load it when
    /// the form appears rather than on every change.
    catalog_wanted: bool,
    catalog_task: Option<Task<()>>,
    launch: Option<LaunchDialog>,
    poller: Poller<PodKey>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<RunpodPanelEvent> for RunpodBackendPanel {}

impl RunpodBackendPanel {
    pub fn new(options: RunpodPanelOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let video = options.purpose == Purpose::Video;
        let backend = if options.launch_only {
            None
        } else if let Some(id) = &options.backend_id {
            Some(LiveQuery::new(
                runpod_backend_store::BY_ID,
                &ByIdArgs { id: id.clone() },
                cx,
            ))
        } else {
            Some(LiveQuery::new(
                runpod_backend_store::CURRENT,
                &RunpodCurrentArgs {
                    // Named even for the image pod: the status button subscribes
                    // with no purpose and a narrower row type, and the two must
                    // not overwrite each other's remembered result.
                    purpose: Some(options.purpose),
                },
                cx,
            ))
        };
        let selection = LiveQuery::new(runpod_backends::SELECTION, &NoArgs {}, cx);
        let gpu_select = cx.new(|cx| {
            SelectState::new(
                SearchableVec::new(Vec::<GpuChoice>::new()),
                None,
                window,
                cx,
            )
            .searchable(true)
        });
        let container_disk = number_input(
            if video {
                VIDEO_CONTAINER_DISK_GB
            } else {
                IMAGE_CONTAINER_DISK_GB
            },
            10.0,
            MIN_CONTAINER_DISK_GB,
            Some(MAX_CONTAINER_DISK_GB),
            window,
            cx,
        );
        let volume_disk = number_input(0.0, 10.0, 0.0, Some(MAX_VOLUME_DISK_GB), window, cx);
        let min_disk_speed = number_input(1000.0, 100.0, 0.0, None, window, cx);
        let min_download = number_input(500.0, 100.0, 0.0, None, window, cx);
        let max_price = number_input(MAX_HOURLY_USD, 0.1, 0.0, Some(MAX_HOURLY_USD), window, cx);

        let mut subscriptions = vec![
            cx.observe_in(&selection, window, |_, _, _, cx| cx.notify()),
            cx.subscribe_in(
                &gpu_select,
                window,
                |this, _, event: &SelectEvent<SearchableVec<GpuChoice>>, _, cx| {
                    let SelectEvent::Confirm(Some(id)) = event else {
                        return;
                    };
                    this.gpu_type_id = Some(id.clone());
                    this.follow_cloud();
                    cx.notify();
                },
            ),
        ];
        for input in [
            &container_disk,
            &volume_disk,
            &min_disk_speed,
            &min_download,
            &max_price,
        ] {
            subscriptions.push(cx.subscribe(input, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }));
        }
        if let Some(backend) = &backend {
            subscriptions
                .push(cx.observe_in(backend, window, |this, _, window, cx| this.sync(window, cx)));
        }

        let poller = Poller::new(window, cx, Self::poller, Self::poll_pod);
        let mut this = Self {
            options,
            open: true,
            backend,
            selection,
            gpus: Vec::new(),
            balance: None,
            gpu_type_id: None,
            gpu_count: 1,
            cloud: CloudType::Secure,
            template: TemplateProfile::Cuda13_0,
            gpu_select,
            container_disk,
            volume_disk,
            min_disk_speed,
            min_download,
            max_price,
            form_busy: None,
            lifecycle: None,
            queued_lifecycle: None,
            refreshing: false,
            refresh_requested: false,
            refresh_in_flight: false,
            refresh_failures: 0,
            selecting: false,
            confirm_destroy: false,
            error: None,
            refresh_error: None,
            catalog_wanted: false,
            catalog_task: None,
            launch: None,
            poller,
            _subscriptions: subscriptions,
        };
        this.sync(window, cx);
        this
    }

    pub fn options(&self) -> &RunpodPanelOptions {
        &self.options
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Whether a rental is being confirmed or is on its way. The owner must
    /// keep the panel until it is not: the confirmation and the request
    /// answer to it, even after the new pod's row has appeared.
    pub fn is_launching(&self) -> bool {
        self.form_busy == Some(FormBusy::Launch)
            || self.launch.as_ref().is_some_and(LaunchDialog::is_open)
    }

    /// Whether the panel is on screen (the web's `open`). Polling and the
    /// catalogue load run only while it is; a panel starts open.
    pub fn set_open(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.open != open {
            self.open = open;
            self.sync(window, cx);
        }
    }

    fn is_video(&self) -> bool {
        self.options.purpose == Purpose::Video
    }

    fn profile(&self) -> PodProfile {
        match self.options.purpose {
            Purpose::Image => PodProfile::Image,
            Purpose::Video => PodProfile::Video,
        }
    }

    /// The pod, `Some(None)` when there is none, `None` while unknown.
    fn known(&self, cx: &App) -> Option<Option<RunpodBackend>> {
        let Some(backend) = &self.backend else {
            return Some(None);
        };
        match backend.read(cx).state() {
            QueryState::Ready { data, .. } => Some((**data).clone()),
            _ => None,
        }
    }

    fn pod(&self, cx: &App) -> Option<RunpodBackend> {
        self.known(cx).flatten()
    }

    /// Brings polling, the catalogue and the confirmation in line with the
    /// pod and whether the panel is open.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let known = self.known(cx);
        let pod = known.clone().flatten();
        let key = pod
            .as_ref()
            .filter(|pod| self.open && pod.active && pod.state != BackendState::Destroyed)
            .and_then(|pod| {
                Some(PodKey {
                    id: pod.id.clone(),
                    pod_id: pod.pod_id.clone()?,
                    state: pod.state,
                })
            });
        if key.is_none() {
            self.refresh_error = None;
        }
        self.poller.set_key(key);

        let wants_catalog = self.open && matches!(known, Some(None));
        if wants_catalog && !self.catalog_wanted {
            self.load_catalog(None, window, cx);
        }
        self.catalog_wanted = wants_catalog;
        if pod.is_none() {
            self.confirm_destroy = false;
        }
        cx.notify();
    }

    fn poller(this: &mut Self) -> &mut Poller<PodKey> {
        &mut this.poller
    }

    fn poll_pod(this: &mut Self, key: PodKey, cx: &mut Context<Self>) -> Task<Duration> {
        let base = if is_changing(key.state) {
            FAST_POLL
        } else {
            SLOW_POLL
        };
        if this.lifecycle.is_some() {
            // Start, Stop or Destroy is out: a read now could write back the
            // state it is replacing. Its own change of state polls again.
            return Task::ready(FAST_POLL);
        }
        let manual = std::mem::take(&mut this.refresh_requested);
        this.refresh_in_flight = true;
        let request = act(
            runpod_backend_actions::REFRESH,
            &BackendIdArgs { id: key.id.clone() },
            cx,
        );
        cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this.refresh_in_flight = false;
                if manual {
                    this.refreshing = false;
                }
                match result {
                    Ok(_) => {
                        this.refresh_failures = 0;
                        if this.poller.is_current(&key) {
                            this.refresh_error = None;
                        }
                    }
                    Err(error) => {
                        this.refresh_failures = this.refresh_failures.saturating_add(1);
                        if this.poller.is_current(&key) {
                            this.refresh_error = Some(refresh_failure(error));
                        }
                    }
                }
                this.send_queued_lifecycle(cx);
                cx.notify();
                refresh_wait(base, this.refresh_failures)
            })
            .unwrap_or(base)
        })
    }

    // MARK: The rent form

    /// Loads RunPod's GPU types and credit. `then_error` is shown once the
    /// fresh catalogue is in, after a launch the server refused.
    fn load_catalog(
        &mut self,
        then_error: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.form_busy = Some(FormBusy::Catalog);
        self.error = None;
        self.sync_launch(cx);
        let types = act(runpod_backend_actions::GPU_TYPES, &NoArgs {}, cx);
        let balance = act(runpod_backend_actions::ACCOUNT_BALANCE, &NoArgs {}, cx);
        let video = self.is_video();
        self.catalog_task = Some(cx.spawn_in(window, async move |this, cx| {
            let types = types.await;
            let balance = balance.await.ok().flatten();
            let _ = this.update_in(cx, |this, window, cx| {
                match types {
                    Ok(types) => {
                        this.gpus = types;
                        this.balance = balance;
                        this.gpu_type_id =
                            default_gpu_id(&this.gpus, this.gpu_type_id.as_deref(), video);
                        this.follow_cloud();
                    }
                    Err(error) => {
                        this.error = Some(error.user_message());
                        this.gpus.clear();
                    }
                }
                this.load_gpu_choices(window, cx);
                if then_error.is_some() {
                    this.error = then_error;
                }
                this.form_busy = None;
                this.sync_launch(cx);
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn load_gpu_choices(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Rentable first; the rest stay listed (stock changes by the minute)
        // but sink to the bottom and say why they cannot be rented.
        let (rentable, unavailable): (Vec<&GpuType>, Vec<&GpuType>) =
            self.gpus.iter().partition(|gpu| is_rentable(gpu));
        let choices: Vec<GpuChoice> = rentable
            .into_iter()
            .chain(unavailable)
            .map(|gpu| GpuChoice {
                value: gpu.id.clone().into(),
                name: gpu.display_name.clone().into(),
                description: gpu_description(gpu).into(),
            })
            .collect();
        let selected = self.gpu_type_id.clone();
        self.gpu_select.update(cx, |select, cx| {
            select.set_items(SearchableVec::new(choices), window, cx);
            if let Some(id) = &selected {
                select.set_selected_value(id, window, cx);
            }
        });
    }

    fn selected_gpu(&self) -> Option<&GpuType> {
        let id = self.gpu_type_id.as_ref()?;
        self.gpus.iter().find(|gpu| gpu.id == id.as_ref())
    }

    /// A GPU is often sold in one cloud only — RunPod lists the other with no
    /// price and `UNKNOWN` stock, which cannot be rented. Follow the GPU to the
    /// cloud that sells it.
    fn follow_cloud(&mut self) {
        let Some(gpu) = self.selected_gpu() else {
            return;
        };
        if !is_offered(gpu.availability(self.cloud))
            && is_offered(gpu.availability(self.cloud.other()))
        {
            self.cloud = self.cloud.other();
        }
    }

    fn availability(&self) -> Option<&CloudAvailability> {
        self.selected_gpu().map(|gpu| gpu.availability(self.cloud))
    }

    /// The total starting price for the chosen count.
    fn hourly_usd(&self) -> f64 {
        self.availability()
            .map(|availability| total_hourly_usd(availability, self.gpu_count))
            .unwrap_or(0.0)
    }

    fn template(&self) -> TemplateProfile {
        // H3's int8 kernels need the CUDA 13.0 image; the server forces it too.
        if self.is_video() {
            TemplateProfile::Cuda13_0
        } else {
            self.template
        }
    }

    /// Why the current selection cannot be rented, if it cannot.
    fn rent_blocker(&self, cx: &App) -> Option<SharedString> {
        let Some(gpu) = self.selected_gpu() else {
            return Some("Choose a GPU first.".into());
        };
        let availability = gpu.availability(self.cloud);
        let hourly = self.hourly_usd();
        if availability.hourly_usd.is_none() || hourly <= 0.0 {
            return Some(
                format!(
                    "No {} {} is for rent right now.",
                    self.cloud.label().to_lowercase(),
                    gpu.display_name
                )
                .into(),
            );
        }
        if !offers_count(availability, self.gpu_count) {
            return Some(format!("{}× is not in stock right now.", self.gpu_count).into());
        }
        let cap = number_value(&self.max_price, cx);
        if hourly > cap {
            return Some(
                format!(
                    "{}/hr is over your maximum of {}/hr.",
                    usd(hourly),
                    usd(cap)
                )
                .into(),
            );
        }
        None
    }

    fn launch_summary(&self, cx: &App) -> Vec<SharedString> {
        let Some(gpu) = self.selected_gpu() else {
            return Vec::new();
        };
        vec![
            format!(
                "Launch {}× {} in {} cloud with CUDA {}, {} GB disposable container disk, and {} GB persistent volume. Current GPU starting price is {}/hr; Convex rejects a price change over 10% or the server cap before creating the pod.",
                self.gpu_count,
                gpu.display_name,
                self.cloud.label().to_lowercase(),
                self.template().cuda_version(),
                plain_number(number_value(&self.container_disk, cx)),
                plain_number(number_value(&self.volume_disk, cx)),
                usd(self.hourly_usd()),
            )
            .into(),
        ]
    }

    fn open_launch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.form_busy.is_some() || self.rent_blocker(cx).is_some() {
            return;
        }
        self.error = None;
        let title = if self.is_video() {
            "Confirm paid video pod rental"
        } else {
            "Confirm paid RunPod rental"
        };
        self.launch = Some(launch_dialog::open(
            title.into(),
            self.profile(),
            self.launch_summary(cx),
            Self::launch_selected,
            window,
            cx,
        ));
        cx.notify();
    }

    /// The confirmation's "Confirm and launch".
    fn launch_selected(
        &mut self,
        skip_models: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.form_busy.is_some() {
            return;
        }
        // Re-checked at the click: the catalogue may have been reloaded since
        // the dialog opened.
        if let Some(blocker) = self.rent_blocker(cx) {
            self.error = Some(blocker);
            self.sync_launch(cx);
            cx.notify();
            return;
        }
        let Some(gpu) = self.selected_gpu() else {
            return;
        };
        let args = LaunchArgs {
            gpu_type_id: gpu.id.clone(),
            gpu_name: gpu.display_name.clone(),
            gpu_count: self.gpu_count,
            cloud_type: self.cloud,
            template_profile: self.template(),
            container_disk_gb: number_value(&self.container_disk, cx),
            volume_disk_gb: number_value(&self.volume_disk, cx),
            min_disk_bandwidth_mbps: number_value(&self.min_disk_speed, cx),
            min_download_mbps: number_value(&self.min_download, cx),
            displayed_hourly_usd: self.hourly_usd(),
            max_hourly_usd: number_value(&self.max_price, cx),
            purpose: Some(self.options.purpose),
            skip_models: Some(skip_models),
        };
        self.form_busy = Some(FormBusy::Launch);
        self.error = None;
        self.sync_launch(cx);
        cx.notify();
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.act_within(runpod_backend_actions::LAUNCH, &args, LAUNCH_DEADLINE, cx)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.form_busy = None;
                match result {
                    Ok(launched) => {
                        if let Some(launch) = this.launch.take() {
                            launch.close(window, cx);
                        }
                        cx.emit(RunpodPanelEvent::Launched {
                            pod_id: launched.pod_id,
                        });
                    }
                    // The price or stock moved: show the fresh catalogue with
                    // the reason, so the next confirmation is for real numbers.
                    Err(error) => {
                        this.load_catalog(Some(error.user_message()), window, cx);
                        cx.emit(RunpodPanelEvent::LaunchFailed);
                    }
                }
                this.sync_launch(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// Mirrors busy, error and the summary into an open confirmation.
    fn sync_launch(&self, cx: &mut Context<Self>) {
        if let Some(launch) = &self.launch {
            let summary = self.launch_summary(cx);
            launch.sync(
                self.form_busy.is_some(),
                self.error.clone(),
                Some(summary),
                cx,
            );
        }
    }

    // MARK: The pod's card

    fn control(&mut self, kind: Lifecycle, cx: &mut Context<Self>) {
        let Some(pod) = self.pod(cx) else { return };
        if self.lifecycle.is_some() {
            return;
        }
        self.lifecycle = Some(kind);
        self.error = None;
        cx.notify();
        if self.refresh_in_flight {
            // Sent once the read that is out has written its state.
            self.queued_lifecycle = Some((kind, pod.id));
        } else {
            self.send_lifecycle(kind, pod.id, cx);
        }
    }

    fn send_queued_lifecycle(&mut self, cx: &mut Context<Self>) {
        if let Some((kind, id)) = self.queued_lifecycle.take() {
            self.send_lifecycle(kind, id, cx);
        }
    }

    fn send_lifecycle(&mut self, kind: Lifecycle, id: String, cx: &mut Context<Self>) {
        let args = BackendIdArgs { id };
        let request = match kind {
            Lifecycle::Start => act(runpod_backend_actions::START, &args, cx),
            Lifecycle::Stop => act(runpod_backend_actions::STOP, &args, cx),
            Lifecycle::Destroy => act(runpod_backend_actions::DESTROY, &args, cx),
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
                    provider: Provider::Runpod,
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

    /// Refresh: the poll's next read, at once (or right after the one that
    /// is out). Without a poll — the pod is not active — one read of its own,
    /// which a lifecycle click also waits for.
    fn refresh_pod(&mut self, cx: &mut Context<Self>) {
        let Some(pod) = self.pod(cx) else { return };
        if self.refreshing || self.lifecycle.is_some() {
            return;
        }
        self.refreshing = true;
        self.error = None;
        self.refresh_error = None;
        cx.notify();
        if self.poller.has_key() {
            self.refresh_requested = true;
            self.poller.poll_now();
            return;
        }
        self.refresh_in_flight = true;
        let request = act(
            runpod_backend_actions::REFRESH,
            &BackendIdArgs { id: pod.id },
            cx,
        );
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.refreshing = false;
                this.refresh_in_flight = false;
                if let Err(error) = result {
                    this.refresh_error = Some(refresh_failure(error));
                }
                this.send_queued_lifecycle(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn visible_error(&self) -> Option<SharedString> {
        self.error.clone().or_else(|| self.refresh_error.clone())
    }
}

impl Render for RunpodBackendPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let failure = self
            .backend
            .as_ref()
            .and_then(|backend| backend.read(cx).error().cloned());
        match (self.known(cx), failure) {
            (Some(Some(pod)), _) => self.render_pod(&pod, cx),
            (Some(None), _) => self.render_form(cx),
            // Without the row it is unknown whether a pod is running; the rent
            // form would invite renting a second one.
            (None, Some(message)) => Alert::error("runpod-state-error", message)
                .title("Could not read the RunPod state")
                .into_any_element(),
            (None, None) => loading("Loading RunPod state\u{2026}", cx).into_any_element(),
        }
    }
}

fn refresh_failure(error: CallError) -> SharedString {
    format!("RunPod status refresh failed: {}", error.user_message()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_reads_stretch_the_wait_up_to_a_cap() {
        assert_eq!(refresh_wait(FAST_POLL, 0), FAST_POLL);
        assert_eq!(refresh_wait(FAST_POLL, 1), FAST_POLL * 2);
        assert_eq!(refresh_wait(FAST_POLL, 3), FAST_POLL * 8);
        assert_eq!(refresh_wait(FAST_POLL, 40), MAX_REFRESH_BACKOFF);
        assert_eq!(refresh_wait(SLOW_POLL, 2), SLOW_POLL * 4);
        assert_eq!(refresh_wait(SLOW_POLL, 9), MAX_REFRESH_BACKOFF);
    }
}
