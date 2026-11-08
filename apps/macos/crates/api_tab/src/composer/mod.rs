//! The API composer: provider and model, prompt, references, the controls the
//! selected model takes, the live price and the Generate button.
//!
//! The rules — which controls exist, what each option costs, what an edit
//! clamps, what a submit sends — are the shared TypeScript's, run on a worker
//! by `crates/rules/js/composer.ts`. This side keeps the form as the JSON the
//! rules return and draws the description that comes back. A clicked option
//! shows as selected at once; prices and clamps follow a few milliseconds
//! later.
//!
//! Everything that changes the form goes through one queue, in order
//! ([`Queued`], `pump`):
//!
//! - **Edits** reach the rules one at a time, so two quick clicks never race.
//!   A run of edits to one value (a slider dragged, a number typed) folds into
//!   its last, and an edit made on the controls of a model the form has since
//!   left is dropped rather than applied to the next model's settings.
//! - **Reproduce** restores a row where the queue reaches it: edits made while
//!   its references downloaded are applied first and the row's settings win
//!   over them; edits made after it apply on top. A later Reproduce supersedes
//!   an earlier one still downloading.
//! - **Generate** is a barrier: it plans from the form every edit made before
//!   it has produced, never from a snapshot older than what the screen shows.

mod engine;
mod fields;
mod grok;
mod picker;
mod preview;
mod references;
mod stars;
mod switcher;

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use artsnack_backend::{
    Backend, LiveQuery, Mutation, NoArgs,
    api::{
        atlas::{self, AtlasBalance},
        feature_flags::{self, FeatureFlags},
        grok_auth::{self, GrokConnection},
        grok_generations::{self, ApiGeneration, ApiProvider},
        grok_processor::{self, DescribeSourceVideoArgs, SourceVideoFacts, UploadSourceVideoArgs},
        higgsfield::{self, CachedCost, HiggsfieldAccount, RefreshBalanceArgs},
    },
};
use artsnack_media::{Media, upload};
use artsnack_prompts::{ContextReader, PromptEnhance, PromptLibrary, PromptReader, PromptWriter};
use artsnack_rules::Rules;
use artsnack_settings::{Preference, Preferences};
use gpui_kit::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Context, Entity, EventEmitter,
    ExternalPaths, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyBinding,
    ParentElement as _, PathPromptOptions, Render, RenderImage, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::{InputEvent, TextareaState},
        notification::Notification,
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};
use serde_json::{Value, json};

use crate::mention::{PromptMentions, TagInserted, TaggableReferences};

use engine::ComposerView;
use engine::{Edit, Estimate, GrokSource, Plan, Recreated, Shared, Step, ViewContext};
pub use grok::GrokConnect;
use references::Reference;
pub use switcher::SwitcherAction;

actions!(api_composer, [Submit]);

const CONTEXT: &str = "ApiComposer";

pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-enter", Submit, Some(CONTEXT)),
        KeyBinding::new("cmd-enter", Submit, Some(&artsnack_ui::field_in(CONTEXT))),
    ]);
    picker::init(cx);
}

/// The whole form, as the rules shape it (`artsnack_api_form` on the web).
const SAVED_FORM: Preference<Option<Value>> = Preference::new("api.form", || None);
/// How long typing in the prompt settles before Atlas re-routes on it.
const PROMPT_SETTLE: Duration = Duration::from_millis(300);
/// The first wait before asking Higgsfield again for a price it could not
/// give; it doubles per failure up to [`QUOTE_RETRY_MAX`].
const QUOTE_RETRY_FIRST: Duration = Duration::from_secs(5);
const QUOTE_RETRY_MAX: Duration = Duration::from_secs(300);
/// How long a balance that failed to load waits before it is asked for again.
const BALANCE_RETRY: Duration = Duration::from_secs(30);

const START_IMAGE: Mutation<Value, Value> = Mutation::new("grokGenerations:startImage");
const START_VIDEO: Mutation<Value, Value> = Mutation::new("grokGenerations:startVideo");
const START_ATLAS: Mutation<Value, Value> = Mutation::new("atlas:start");

/// What the composer asks of the tab around it.
#[derive(Clone, Debug)]
pub enum ComposerEvent {
    /// A self-hosted clip was reproduced: it belongs to the video tab.
    ReproduceVideo(Arc<ApiGeneration>),
    /// A job was started (the Atlas balance moves).
    Started,
    /// "Write with AI": open Prompt Studio, or close it.
    ToggleStudio,
    /// A hand-off to another screen (a reference's own generation:
    /// Reproduce on Generate or Enhance, Send to Enhance).
    Media(artsnack_library::MediaCommand),
}

type Barrier = Box<dyn FnOnce(&mut ApiComposer, &mut Context<ApiComposer>)>;

/// One step of the form's queue (see the module documentation).
enum Queued {
    /// A change to the form. `identity` is the view the control that made it
    /// was drawn for (`ComposerView::identity`); `None` for a change that is
    /// not made on one model's controls (provider, model, references).
    Edit {
        edit: Edit,
        identity: Option<String>,
    },
    /// A row's settings and references (Reproduce).
    Restore(Box<Restore>),
    /// Runs once everything queued before it has been applied.
    Barrier(Barrier),
}

/// A Reproduce whose references are ready.
struct Restore {
    /// Which Reproduce this is; only the latest restores.
    request: u64,
    /// The row, as `recreate` reads it.
    row: Value,
    references: Vec<Reference>,
}

/// How a balance fetch stands.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Fetch {
    #[default]
    Idle,
    Loading,
    Done,
    /// Failed; asked again once this has passed.
    Failed(Instant),
}

impl Fetch {
    fn is_due(self) -> bool {
        match self {
            Fetch::Idle => true,
            Fetch::Failed(retry_at) => Instant::now() >= retry_at,
            Fetch::Loading | Fetch::Done => false,
        }
    }
}

/// The providers' balances, each fetched on demand (they are actions, not
/// queries) and asked again after a failure.
#[derive(Default)]
struct Balances {
    atlas: Option<AtlasBalance>,
    atlas_fetch: Fetch,
    /// `higgsfield.refreshBalance` writes the account `hf_account` reads.
    higgsfield_fetch: Fetch,
    _retry: Option<Task<()>>,
}

/// A Higgsfield price asked for. `attempts` counts the failures so far.
#[derive(Clone, Copy, Debug)]
enum Asked {
    /// On its way, or answered and on its way into `higgsfield.listCosts`.
    Pending { attempts: u32 },
    /// Higgsfield could not price it; asked again once `retry_at` has passed.
    Failed { attempts: u32, retry_at: Instant },
}

impl Asked {
    fn attempts(self) -> u32 {
        match self {
            Asked::Pending { attempts } | Asked::Failed { attempts, .. } => attempts,
        }
    }
}

#[derive(Default)]
struct Quotes {
    asked: HashMap<String, Asked>,
    /// A batch is being asked for, one configuration at a time.
    running: bool,
    /// The form changed while a batch ran: look again when it ends.
    stale: bool,
    /// When the next failed price is due again, with the timer that asks.
    retry: Option<(Instant, Task<()>)>,
}

/// The attachments on disk, written by one writer at a time.
#[derive(Default)]
struct ReferenceStore {
    /// The latest attachments not yet written.
    unsaved: Option<Vec<Reference>>,
    writing: bool,
}

pub struct ApiComposer {
    focus_handle: FocusHandle,
    window: AnyWindowHandle,
    /// The form as the rules last returned it. Its prompt may be stale: the
    /// text field owns the prompt (`prompt_text`).
    form: Option<Arc<Value>>,
    view: Option<Rc<ComposerView>>,
    /// `view.identity` as last drawn: what the controls on screen are for.
    rendered_identity: Option<String>,
    /// Values shown for controls whose edits are still on the worker.
    optimistic: HashMap<String, Value>,
    queue: VecDeque<Queued>,
    /// An edit or a restore is on the worker.
    stepping: bool,
    /// The edit on the worker, so an identical one right behind it is not
    /// sent again.
    in_flight: Option<Edit>,
    /// What the rules read besides the form, built once per change of it.
    context: Option<Arc<ViewContext>>,
    /// The form and prompt last saved, so a burst of edits is saved once.
    saved: Option<(Arc<Value>, String)>,
    prompt: Entity<TextareaState>,
    prompt_text: String,
    /// The prompt's placeholder as last set (it says whether `@` tags work).
    placeholder: SharedString,
    /// The prompt field with its `@image` menu and tag tokens.
    mentions: Entity<PromptMentions>,
    library: Entity<PromptLibrary>,
    enhancer: Entity<PromptEnhance>,
    /// Prompt Studio is open beside the form.
    studio_open: bool,
    _prompt_settle: Option<Task<()>>,
    references: Vec<Reference>,
    store: ReferenceStore,
    /// Attachments being decoded and resized: slots reserved for them.
    preparing: usize,
    /// A Grok source clip is uploading.
    source_uploading: bool,
    /// Hand-offs from other screens that arrived together (Search sends an
    /// ordered selection as one command per image); attached as one batch.
    handoffs: Vec<SharedString>,
    /// While a submit is running: what it is doing.
    status: Option<SharedString>,
    /// The latest Reproduce; an earlier one finishing later is dropped.
    restore_request: u64,
    restoring: bool,
    grok: Entity<LiveQuery<GrokConnection>>,
    flags: Entity<LiveQuery<Option<FeatureFlags>>>,
    favorites: Entity<stars::AtlasStars>,
    costs: Entity<LiveQuery<Vec<CachedCost>>>,
    hf_account: Entity<LiveQuery<Option<HiggsfieldAccount>>>,
    quotes: Quotes,
    balances: Balances,
    controls: HashMap<String, fields::ControlState>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ComposerEvent> for ApiComposer {}

impl ApiComposer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(4, 16)
                .placeholder("Describe what you want to see...")
        });
        let grok = LiveQuery::new(grok_auth::CONNECTION, &NoArgs {}, cx);
        let flags = LiveQuery::new(feature_flags::MINE, &NoArgs {}, cx);
        let favorites = stars::AtlasStars::global(cx);
        let costs = LiveQuery::new(higgsfield::COSTS, &NoArgs {}, cx);
        let hf_account = LiveQuery::new(higgsfield::ACCOUNT, &NoArgs {}, cx);
        let mut subscriptions = vec![
            cx.subscribe(&prompt, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.prompt_text = state.read(cx).value().to_string();
                    this.prompt_changed(cx);
                    cx.notify();
                }
            }),
            cx.observe(&grok, |_, _, cx| cx.notify()),
            cx.observe(&hf_account, |_, _, cx| cx.notify()),
            // Inputs of the view: a change re-asks the rules for it.
            cx.observe(&flags, |this, _, cx| {
                this.context = None;
                this.edit(Edit::Normalize, cx)
            }),
            cx.observe(&favorites, |this, _, cx| {
                this.context = None;
                this.edit(Edit::Normalize, cx)
            }),
            cx.observe(&costs, |this, _, cx| {
                this.context = None;
                if this.provider() == Some("higgsfield") {
                    this.edit(Edit::Normalize, cx);
                }
            }),
            // GPUI keeps a drawn image in the atlas until told; the
            // thumbnails go with the composer.
            cx.on_release(|this: &mut Self, cx| {
                let previews: Vec<Arc<RenderImage>> = this
                    .references
                    .iter()
                    .map(|reference| reference.preview.clone())
                    .collect();
                release_images(previews, cx);
            }),
        ];
        let read: PromptReader = {
            let prompt = prompt.clone();
            Rc::new(move |cx| prompt.read(cx).value().to_string())
        };
        let write: PromptWriter = {
            let view = cx.entity().downgrade();
            Rc::new(move |text, window, cx| {
                let _ = view.update(cx, |this, cx| this.replace_prompt(text, window, cx));
            })
        };
        let context: ContextReader = {
            let view = cx.entity().downgrade();
            Rc::new(move |cx| {
                view.upgrade()
                    .and_then(|view| view.read(cx).view.as_ref().map(|view| view.enhance.clone()))
                    .unwrap_or_else(|| json!({ "media": "image" }))
            })
        };
        // `@imageN` names the selection, where the model reads tags at all.
        let taggable: TaggableReferences = {
            let view = cx.entity().downgrade();
            Rc::new(move |cx| {
                let Some(view) = view.upgrade() else {
                    return Vec::new();
                };
                let this = view.read(cx);
                if !this.view.as_ref().is_some_and(|view| view.prompt.tagging) {
                    return Vec::new();
                }
                this.selected()
                    .map(|reference| reference.preview.clone())
                    .collect()
            })
        };
        let mentions = cx.new(|cx| PromptMentions::new(prompt.clone(), taggable, window, cx));
        subscriptions.push(cx.subscribe(&mentions, |this, _, _: &TagInserted, cx| {
            this.prompt_text = this.prompt.read(cx).value().to_string();
            this.prompt_changed(cx);
            cx.notify();
        }));
        let library = cx.new(|cx| PromptLibrary::new(read.clone(), write.clone(), window, cx));
        let enhancer = cx.new(|cx| PromptEnhance::new(read, write, context, window, cx));
        let mut this = Self {
            focus_handle: cx.focus_handle(),
            window: window.window_handle(),
            form: None,
            view: None,
            rendered_identity: None,
            optimistic: HashMap::new(),
            queue: VecDeque::new(),
            stepping: false,
            in_flight: None,
            context: None,
            saved: None,
            prompt,
            prompt_text: String::new(),
            placeholder: SharedString::default(),
            mentions,
            library,
            enhancer,
            studio_open: false,
            _prompt_settle: None,
            references: Vec::new(),
            store: ReferenceStore::default(),
            preparing: 0,
            source_uploading: false,
            handoffs: Vec::new(),
            status: None,
            restore_request: 0,
            restoring: false,
            grok,
            flags,
            favorites,
            costs,
            hf_account,
            quotes: Quotes::default(),
            balances: Balances::default(),
            controls: HashMap::new(),
            _subscriptions: subscriptions,
        };
        this.hydrate(cx);
        this
    }

    // --- The form and the rules -------------------------------------------

    /// Restores the saved form, then the attachments of the last session.
    fn hydrate(&mut self, cx: &mut Context<Self>) {
        let saved = Preferences::get(cx, &SAVED_FORM).map(|form| form.to_string());
        let task = engine::call::<_, Value>(cx, "hydrate", (saved,));
        cx.spawn(async move |this, cx| {
            let form = match task.await {
                Ok(form) => form,
                Err(error) => {
                    tracing::error!(?error, "could not restore the API form");
                    return;
                }
            };
            let prompt = form["prompt"].as_str().unwrap_or_default().to_string();
            let _ = this.update(cx, |this, cx| {
                this.form = Some(Arc::new(form));
                this.prompt_text = prompt.clone();
                this.set_prompt_text(prompt, cx);
                this.edit(Edit::Normalize, cx);
                this.restore_references(cx);
            });
        })
        .detach();
    }

    /// A saved prompt inserted, an enhancement, or Undo of either.
    pub(crate) fn replace_prompt(
        &mut self,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.mentions
            .update(cx, |mentions, cx| mentions.set_text(&text, window, cx));
        self.prompt_text = text;
        self.prompt_changed(cx);
        cx.notify();
    }

    fn set_prompt_text(&mut self, text: String, cx: &mut Context<Self>) {
        let mentions = self.mentions.clone();
        let _ = self.window.update(cx, |_, window, cx| {
            mentions.update(cx, |mentions, cx| mentions.set_text(&text, window, cx));
        });
    }

    /// The form with the prompt as typed: the text field owns it, and the rules
    /// read it (Atlas routes on whether it tags anything).
    fn current_form(&self) -> Option<Value> {
        Some(with_prompt(self.form.as_ref()?, &self.prompt_text))
    }

    pub fn provider(&self) -> Option<&str> {
        self.form.as_ref()?.get("provider")?.as_str()
    }

    /// Queues a change that is not made on one model's controls.
    pub(crate) fn edit(&mut self, edit: Edit, cx: &mut Context<Self>) {
        self.enqueue(edit, None, cx);
    }

    /// Queues a change made on a control of the form on screen: dropped if,
    /// by its turn, the form has moved to another model.
    pub(crate) fn edit_from_control(&mut self, edit: Edit, cx: &mut Context<Self>) {
        let identity = self.rendered_identity.clone();
        self.enqueue(edit, identity, cx);
    }

    /// An edit made on a control: shown at once, confirmed by the rules.
    pub(crate) fn edit_control(
        &mut self,
        key: &str,
        edit: Edit,
        value: Value,
        cx: &mut Context<Self>,
    ) {
        self.optimistic.insert(key.to_string(), value);
        self.edit_from_control(edit, cx);
        cx.notify();
    }

    /// A choice that moves the whole form (media type, provider, model):
    /// shown at once, and never dropped for being made on an older form.
    pub(crate) fn edit_choice(
        &mut self,
        key: &str,
        edit: Edit,
        value: Value,
        cx: &mut Context<Self>,
    ) {
        self.optimistic.insert(key.to_string(), value);
        self.edit(edit, cx);
        cx.notify();
    }

    fn enqueue(&mut self, edit: Edit, identity: Option<String>, cx: &mut Context<Self>) {
        // A setter right behind another of the same value replaces it: while
        // a slider is dragged or a number typed, only the latest is worth a
        // trip to the rules.
        if let Some(Queued::Edit {
            edit: last,
            identity: last_identity,
        }) = self.queue.back_mut()
            && *last_identity == identity
            && edit.target().is_some()
            && last.target() == edit.target()
        {
            *last = edit;
            return;
        }
        // The same value again (a slider's release after its last move).
        if self.queue.is_empty()
            && edit.target().is_some()
            && self.in_flight.as_ref() == Some(&edit)
        {
            return;
        }
        self.queue.push_back(Queued::Edit { edit, identity });
        self.pump(cx);
    }

    /// Runs `then` once everything queued so far has been applied.
    fn after_queued(
        &mut self,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, &mut Context<Self>) + 'static,
    ) {
        self.queue.push_back(Queued::Barrier(Box::new(then)));
        self.pump(cx);
    }

    /// What the rules read besides the form: built once per change of the
    /// selection, the quotes, the flags or the stars, and shared with the
    /// worker without copying.
    fn view_context(&mut self, cx: &App) -> Arc<ViewContext> {
        if let Some(context) = &self.context {
            return context.clone();
        }
        let quotes = self
            .costs
            .read(cx)
            .data()
            .map(|costs| {
                costs
                    .iter()
                    .map(|cost| (cost.signature.clone(), Value::from(cost.credits)))
                    .collect()
            })
            .unwrap_or_default();
        let mut hidden = Vec::new();
        if let Some(Some(flags)) = self.flags.read(cx).data().map(|flags| **flags) {
            if !flags.higgsfield {
                hidden.push("higgsfield".to_string());
            }
            if !flags.fal {
                hidden.push("fal".to_string());
            }
        }
        let context = Arc::new(ViewContext {
            refs: self.selected().map(Reference::info).collect(),
            quotes,
            hidden_providers: hidden,
            favorites: self.favorites.read(cx).ids().cloned().unwrap_or_default(),
        });
        self.context = Some(context.clone());
        context
    }

    /// Works through the queue: one edit or restore on the worker at a time,
    /// barriers as they are reached.
    fn pump(&mut self, cx: &mut Context<Self>) {
        // Changes made before the saved form is back wait for it.
        while !self.stepping && self.form.is_some() {
            let Some(next) = self.queue.pop_front() else {
                break;
            };
            match next {
                Queued::Barrier(then) => then(self, cx),
                Queued::Restore(restore) => self.send_restore(*restore, cx),
                Queued::Edit { edit, identity } => {
                    let current = self.view.as_ref().map(|view| view.identity.as_str());
                    if identity.is_some() && identity.as_deref() != current {
                        // Made on the controls of a model the form has left.
                        continue;
                    }
                    // A run of refreshes is one refresh.
                    if matches!(edit, Edit::Normalize) {
                        while matches!(
                            self.queue.front(),
                            Some(Queued::Edit {
                                edit: Edit::Normalize,
                                ..
                            })
                        ) {
                            self.queue.pop_front();
                        }
                    }
                    self.send_step(edit, cx);
                }
            }
        }
        if !self.stepping && self.queue.is_empty() && self.form.is_some() {
            // Settled: what the controls show is what the form holds.
            if !self.optimistic.is_empty() {
                self.optimistic.clear();
                cx.notify();
            }
            self.persist_form(cx);
        }
    }

    fn send_step(&mut self, edit: Edit, cx: &mut Context<Self>) {
        let Some(form) = self.form.clone() else {
            return;
        };
        self.stepping = true;
        self.in_flight = Some(edit.clone());
        let context = self.view_context(cx);
        let task = engine::call::<_, Step>(
            cx,
            "step",
            (
                Shared(form),
                self.prompt_text.clone(),
                edit,
                Shared(context),
            ),
        );
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| this.stepped(result, cx));
        })
        .detach();
    }

    fn stepped(&mut self, result: anyhow::Result<Step>, cx: &mut Context<Self>) {
        self.stepping = false;
        self.in_flight = None;
        match result {
            Ok(step) => {
                self.form = Some(Arc::new(step.form));
                self.view = Some(Rc::new(step.view));
                self.sync_placeholder(cx);
                self.request_quotes(cx);
                self.fetch_balance_if_needed(cx);
            }
            Err(error) => {
                tracing::error!(?error, "the composer rules failed");
                self.notify(
                    Notification::error(format!("Couldn\u{2019}t apply that change: {error}")),
                    cx,
                );
            }
        }
        cx.notify();
        self.pump(cx);
        // After the pump: once the queue has settled, boxes take the rules'
        // values; while it has not, the ones with edits on the way keep theirs.
        self.sync_controls(cx);
    }

    /// Saves the form once a burst of edits has settled, not per edit.
    fn persist_form(&mut self, cx: &mut Context<Self>) {
        let Some(form) = &self.form else {
            return;
        };
        let unchanged = self
            .saved
            .as_ref()
            .is_some_and(|(saved, prompt)| Arc::ptr_eq(saved, form) && *prompt == self.prompt_text);
        if unchanged {
            return;
        }
        self.saved = Some((form.clone(), self.prompt_text.clone()));
        Preferences::set(cx, &SAVED_FORM, Some(with_prompt(form, &self.prompt_text)));
    }

    fn sync_placeholder(&mut self, cx: &mut Context<Self>) {
        let Some(view) = &self.view else {
            return;
        };
        let placeholder: SharedString = view.prompt.placeholder.clone().into();
        if placeholder == self.placeholder {
            return;
        }
        self.placeholder = placeholder.clone();
        let prompt = self.prompt.clone();
        let _ = self.window.update(cx, |_, window, cx| {
            prompt.update(cx, |state, cx| {
                state.set_placeholder(placeholder, window, cx)
            });
        });
    }

    fn prompt_changed(&mut self, cx: &mut Context<Self>) {
        // Atlas picks its endpoint partly from the prompt; the others only need
        // it saved.
        self._prompt_settle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PROMPT_SETTLE).await;
            let _ = this.update(cx, |this, cx| {
                if this.provider() == Some("atlas") {
                    this.edit(Edit::Normalize, cx);
                } else if !this.stepping && this.queue.is_empty() {
                    this.persist_form(cx);
                }
            });
        }));
    }

    pub(crate) fn notify(&self, notification: Notification, cx: &mut App) {
        let _ = self.window.update(cx, |_, window, cx| {
            window.push_notification(notification, cx)
        });
    }

    // --- References ---------------------------------------------------------

    /// The prompt as typed.
    pub(crate) fn prompt_text(&self) -> &str {
        &self.prompt_text
    }

    /// Prompt Studio's `StudioContext` for the form on screen.
    pub(crate) fn studio_context(&self) -> Option<&Value> {
        self.view
            .as_ref()
            .map(|view| &view.studio)
            .filter(|context| context.is_object())
    }

    /// The selected references in `@imageN` order, for Prompt Studio.
    pub(crate) fn studio_references(&self) -> Vec<crate::studio::StudioReference> {
        self.selected()
            .map(|reference| crate::studio::StudioReference {
                id: reference.id.clone(),
                jpeg: reference.jpeg.clone(),
                preview: reference.preview.clone(),
            })
            .collect()
    }

    /// Resolves once every change made to the form so far is in the view, so
    /// what Prompt Studio then reads (context, prompt, references) agrees.
    /// Resolves at once, too, if the composer goes away.
    pub(crate) fn settled(&mut self, cx: &mut Context<Self>) -> impl Future<Output = ()> + use<> {
        let (done, settled) = futures::channel::oneshot::channel::<()>();
        self.after_queued(cx, move |_, _| {
            let _ = done.send(());
        });
        async move {
            let _ = settled.await;
        }
    }

    /// Shown on the "Write with AI" button.
    pub(crate) fn set_studio_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.studio_open != open {
            self.studio_open = open;
            cx.notify();
        }
    }

    fn selected(&self) -> impl Iterator<Item = &Reference> {
        self.references
            .iter()
            .filter(|reference| reference.selected)
    }

    fn selected_ids(&self) -> Vec<String> {
        self.selected()
            .map(|reference| reference.id.to_string())
            .collect()
    }

    /// Replaces the attachments and tells the rules which are selected.
    fn set_references(&mut self, next: Vec<Reference>, cx: &mut Context<Self>) {
        let previous = self.selected_ids();
        self.replace_references(next, cx);
        let next = self.selected_ids();
        self.edit(Edit::References { previous, next }, cx);
        cx.notify();
    }

    /// Swaps the attachments, letting go of the thumbnails of those gone, and
    /// saves them.
    fn replace_references(&mut self, next: Vec<Reference>, cx: &mut Context<Self>) {
        let gone: Vec<Arc<RenderImage>> = self
            .references
            .iter()
            .filter(|reference| !next.iter().any(|kept| kept.id == reference.id))
            .map(|reference| reference.preview.clone())
            .collect();
        release_images(gone, cx);
        self.references = next;
        self.context = None;
        self.save_references(cx);
    }

    /// Writes the attachments to disk. One writer at a time, always the
    /// latest attachments: a burst of changes is written once or twice, and
    /// an older write never lands after a newer one.
    fn save_references(&mut self, cx: &mut Context<Self>) {
        self.store.unsaved = Some(self.references.clone());
        if self.store.writing {
            return;
        }
        self.store.writing = true;
        cx.spawn(async move |this, cx| {
            loop {
                let next = this.update(cx, |this, _| {
                    let next = this.store.unsaved.take();
                    this.store.writing = next.is_some();
                    next
                });
                let Ok(Some(references)) = next else {
                    break;
                };
                let written = cx
                    .background_executor()
                    .spawn(async move { references::save(&references) })
                    .await;
                if let Err(error) = written {
                    tracing::warn!(?error, "could not save the API references");
                }
            }
        })
        .detach();
    }

    fn restore_references(&mut self, cx: &mut Context<Self>) {
        let task = cx
            .background_executor()
            .spawn(async move { references::load() });
        cx.spawn(async move |this, cx| {
            let Ok(stored) = task.await else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                // A hand-off or reproduce that landed first wins.
                if !stored.is_empty() && this.references.is_empty() && !this.restoring {
                    this.set_references(stored, cx);
                }
            });
        })
        .detach();
    }

    fn fal_limits(cx: &App) -> Option<upload::ProfileLimits> {
        Rules::global(cx)?
            .get("referenceProfile.REFERENCE_PROFILES.fal")
            .ok()
    }

    fn grok_limits(cx: &App) -> Option<upload::ProfileLimits> {
        Rules::global(cx)?
            .get("referenceProfile.REFERENCE_PROFILES.grok")
            .ok()
    }

    fn add_limit(&self) -> usize {
        self.view.as_ref().map(|view| view.add_limit).unwrap_or(0)
    }

    /// Files picked or dropped: refused, not made room for, past the limit.
    /// Slots are reserved before any file is read, and the files are prepared
    /// one after another — a drop of a hundred photos onto one free slot
    /// decodes one.
    fn add_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let Some(limits) = Self::fal_limits(cx) else {
            return;
        };
        let (mut accepted, refused): (Vec<_>, Vec<_>) = paths
            .into_iter()
            .partition(|path| references::is_accepted(path));
        if !refused.is_empty() {
            self.notify(
                Notification::error(
                    "Use PNG, JPEG, WebP or GIF images (AVIF and HEIC aren\u{2019}t supported yet)",
                ),
                cx,
            );
        }
        if accepted.is_empty() {
            return;
        }
        let limit = self.add_limit();
        if limit == 0 {
            self.notify(
                Notification::error("This model does not take reference images"),
                cx,
            );
            return;
        }
        let room = limit.saturating_sub(self.references.len() + self.preparing);
        if accepted.len() > room {
            let left = accepted.len() - room;
            self.notify(
                Notification::warning(format!(
                    "{left} {} not attached — maximum {limit} reference images",
                    if left == 1 {
                        "image was"
                    } else {
                        "images were"
                    }
                )),
                cx,
            );
            accepted.truncate(room);
        }
        if accepted.is_empty() {
            return;
        }
        self.preparing += accepted.len();
        cx.notify();
        cx.spawn(async move |this, cx| {
            for path in accepted {
                let limits = limits.clone();
                let prepared = cx
                    .background_executor()
                    .spawn(async move {
                        let bytes = std::fs::read(&path)?;
                        references::prepare(&bytes, &limits, None)
                    })
                    .await;
                let attached = this.update(cx, |this, cx| {
                    this.preparing -= 1;
                    match prepared {
                        // Capacity is re-read now: the model may have changed
                        // while the image was being prepared.
                        Ok(reference) => {
                            let limit = this.add_limit();
                            if limit == 0 {
                                this.notify(
                                    Notification::error(
                                        "This model does not take reference images",
                                    ),
                                    cx,
                                );
                            } else if this.references.len() >= limit {
                                this.notify(
                                    Notification::error(format!(
                                        "Maximum {limit} reference images"
                                    )),
                                    cx,
                                );
                            } else {
                                let mut next = this.references.clone();
                                next.push(reference);
                                this.set_references(next, cx);
                            }
                        }
                        Err(error) => this.notify(
                            Notification::error(format!("Failed to process image: {error}")),
                            cx,
                        ),
                    }
                    cx.notify();
                });
                if attached.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    pub(crate) fn pick_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let _ = window;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                let _ = this.update(cx, |this, cx| this.add_files(paths, cx));
            }
        })
        .detach();
    }

    // --- Grok Edit/Extend's source clip ----------------------------------------

    pub(crate) fn is_uploading_source(&self) -> bool {
        self.source_uploading
    }

    /// "Upload mp4" on the source slot: the file goes to Convex storage, then
    /// through `grokProcessor:uploadSourceVideo`, which checks it is an MP4,
    /// measures it and parks it in B2 — uploaded once, however many edits follow.
    pub(crate) fn pick_source_video(&mut self, cx: &mut Context<Self>) {
        if self.source_uploading {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Use as source".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let _ = this.update(cx, |this, cx| this.upload_source_video(path, cx));
        })
        .detach();
    }

    fn upload_source_video(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let is_mp4 = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"));
        if !is_mp4 {
            self.notify(
                Notification::error("Grok edits and extends MP4 video only"),
                cx,
            );
            return;
        }
        self.source_uploading = true;
        cx.notify();
        let read = cx
            .background_executor()
            .spawn(async move { std::fs::read(&path) });
        cx.spawn(async move |this, cx| {
            let outcome: Result<SourceVideoFacts, String> = async {
                let bytes = read.await.map_err(|error| error.to_string())?;
                let url = cx
                    .update(|cx| {
                        Backend::global(cx).update(cx, |backend, cx| {
                            backend.mutate(grok_generations::UPLOAD_URL, &NoArgs {}, cx)
                        })
                    })
                    .await
                    .map_err(|error| error.user_message().to_string())?;
                let upload = cx.update(|cx| {
                    artsnack_runtime::spawn_result(cx, async move {
                        upload::upload_bytes(&url, bytes, "video/mp4").await
                    })
                });
                let storage_id = upload.await.map_err(|error| error.to_string())?;
                cx.update(|cx| {
                    Backend::global(cx).update(cx, |backend, cx| {
                        backend.act(
                            grok_processor::UPLOAD_SOURCE_VIDEO,
                            &UploadSourceVideoArgs { storage_id },
                            cx,
                        )
                    })
                })
                .await
                .map_err(|error| error.user_message().to_string())
            }
            .await;
            let _ = this.update(cx, |this, cx| {
                this.source_uploading = false;
                match outcome {
                    Ok(facts) => this.set_source_video(facts, None, cx),
                    Err(message) => this.notify(
                        Notification::error(format!("Failed to upload the video: {message}")),
                        cx,
                    ),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// "Edit/Extend with Grok" on a result: the clip is already in B2, so it
    /// is only measured (`grokProcessor:describeSourceVideo`) and set.
    pub fn use_source_video(&mut self, key: String, mode: &str, cx: &mut Context<Self>) {
        let mode = mode.to_string();
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(
                grok_processor::DESCRIBE_SOURCE_VIDEO,
                &DescribeSourceVideoArgs { key },
                cx,
            )
        });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |this, cx| match outcome {
                Ok(facts) => this.set_source_video(facts, Some(mode), cx),
                Err(error) => this.notify(
                    Notification::error(format!(
                        "Could not read that clip. {}",
                        error.user_message()
                    )),
                    cx,
                ),
            });
        })
        .detach();
    }

    fn set_source_video(
        &mut self,
        facts: SourceVideoFacts,
        mode: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(seconds) = facts.seconds else {
            self.notify(
                Notification::error("The clip does not say how long it is, so Grok cannot use it"),
                cx,
            );
            return;
        };
        let message = match mode.as_deref() {
            Some("edit") => format!("Clip set as the source \u{2014} Grok Edit ({seconds} s)"),
            Some("extend") => format!("Clip set as the source \u{2014} Grok Extend ({seconds} s)"),
            _ => "Source video uploaded".to_string(),
        };
        self.edit(
            Edit::GrokSource {
                source: Some(GrokSource {
                    key: facts.key,
                    seconds,
                    resolution: facts.resolution.unwrap_or_else(|| "720p".into()),
                }),
                mode,
            },
            cx,
        );
        self.notify(Notification::success(message), cx);
    }

    pub(crate) fn drop_files(&mut self, paths: &ExternalPaths, cx: &mut Context<Self>) {
        self.add_files(paths.paths().to_vec(), cx);
    }

    pub(crate) fn open_gallery(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        artsnack_library::open_reference_picker(window, cx, move |picked, _, cx| {
            let _ = view.update(cx, |this, cx| {
                this.attach_url(picked.url, Some(picked.b2_key), None, cx)
            });
        });
    }

    /// A hand-off ("Send to API", "Use as reference", "Make video", a gallery
    /// pick): attaches the image, making room by dropping the newest ones when
    /// full. `to_video` moves the form first — `Some(true)` to video,
    /// `Some(false)` back to images, `None` leaves it — so the image is
    /// measured against the model it is attached for.
    pub fn attach_url(
        &mut self,
        url: SharedString,
        source_key: Option<String>,
        to_video: Option<bool>,
        cx: &mut Context<Self>,
    ) {
        let was_video = self.view.as_ref().map(|view| view.is_video());
        let switch = to_video.filter(|video| was_video != Some(*video));
        if let Some(video) = switch {
            self.edit(
                Edit::field("mediaType", if video { "video" } else { "image" }),
                cx,
            );
        }
        // "Make video" means animate this image: a Grok form left on Edit or
        // Extend would file it in a strip those modes do not show.
        let grok_editing = self
            .form
            .as_ref()
            .and_then(|form| form["grokVideoMode"].as_str())
            .is_some_and(|mode| mode != "generate");
        if to_video == Some(true) && self.provider() == Some("grok") && grok_editing {
            self.edit(Edit::field("grokVideoMode", "generate"), cx);
        }
        self.after_queued(cx, move |this, cx| {
            this.attach_url_now(url, source_key, switch, cx)
        });
    }

    /// [`Self::attach_url`] once the form is on the media type it asked for;
    /// `switched` is the one it moved to, for the notification.
    fn attach_url_now(
        &mut self,
        url: SharedString,
        source_key: Option<String>,
        switched: Option<bool>,
        cx: &mut Context<Self>,
    ) {
        if self.view.is_some() && self.add_limit() == 0 {
            self.notify(
                Notification::error("This model does not take reference images"),
                cx,
            );
            return;
        }
        let Some(limits) = Self::fal_limits(cx) else {
            return;
        };
        let source_key = source_key.or_else(|| Media::urls(cx).key_of(&url).map(str::to_string));
        let fetcher = Media::fetcher(cx);
        self.preparing += 1;
        cx.notify();
        let url_text = url.to_string();
        let download =
            artsnack_runtime::spawn_result(cx, async move { fetcher.image_bytes(&url_text).await });
        let background = cx.background_executor().clone();
        cx.spawn(async move |this, cx| {
            let prepared = async {
                let bytes = download.await?;
                background
                    .spawn(async move { references::prepare(&bytes, &limits, source_key) })
                    .await
            }
            .await;
            let _ = this.update(cx, |this, cx| {
                this.preparing -= 1;
                cx.notify();
                let reference = match prepared {
                    Ok(reference) => reference,
                    Err(error) => {
                        this.notify(
                            Notification::error(format!("Failed to attach reference: {error}")),
                            cx,
                        );
                        return;
                    }
                };
                let capacity = this.add_limit();
                if capacity == 0 {
                    this.notify(
                        Notification::error("This model does not take reference images"),
                        cx,
                    );
                    return;
                }
                // The newest attachments give way, never the oldest: references
                // are positional, and dropping from the front would shift every
                // survivor into another slot.
                let surplus = (this.references.len() + 1).saturating_sub(capacity);
                let mut next = this.references.clone();
                next.truncate(next.len() - surplus.min(next.len()));
                next.push(reference);
                this.set_references(next, cx);

                let what = match surplus {
                    0 => "Reference attached".to_string(),
                    1 => "Reference attached — replaced the last one".to_string(),
                    count => format!("Reference attached — replaced the last {count}"),
                };
                let text = match switched {
                    Some(true) => format!("{what} — video mode"),
                    Some(false) => format!("{what} — image mode"),
                    None => what,
                };
                this.notify(Notification::success(text), cx);
            });
        })
        .detach();
    }

    /// "Send to API" from another screen. Several in the same moment are one
    /// batch, so they do not push each other out.
    pub fn queue_handoff(&mut self, url: SharedString, cx: &mut Context<Self>) {
        let first = self.handoffs.is_empty();
        self.handoffs.push(url);
        if first {
            let view = cx.entity().downgrade();
            cx.defer(move |cx| {
                let _ = view.update(cx, |this, cx| this.flush_handoffs(cx));
            });
        }
    }

    fn flush_handoffs(&mut self, cx: &mut Context<Self>) {
        let mut urls = std::mem::take(&mut self.handoffs);
        match urls.len() {
            0 => {}
            1 => self.attach_url(urls.remove(0), None, None, cx),
            _ => self.after_queued(cx, move |this, cx| this.attach_batch(urls, cx)),
        }
    }

    /// Several hand-offs at once (the web's `addReferencesFromUrls` with
    /// `planReferenceBatch`): existing attachments keep their slots from the
    /// front, the newest give way, and the batch is appended in its order.
    fn attach_batch(&mut self, urls: Vec<SharedString>, cx: &mut Context<Self>) {
        let limit = self.add_limit();
        if self.view.is_some() && limit == 0 {
            self.notify(
                Notification::error("This model does not take reference images"),
                cx,
            );
            return;
        }
        let Some(limits) = Self::fal_limits(cx) else {
            return;
        };
        let requested = urls.len();
        let accepted: Vec<SharedString> = if self.view.is_some() {
            urls.into_iter().take(limit).collect()
        } else {
            urls
        };
        let urls_api = Media::urls(cx).clone();
        let fetcher = Media::fetcher(cx);
        let background = cx.background_executor().clone();
        let tasks: Vec<_> = accepted
            .iter()
            .map(|url| {
                let (url_text, fetcher, limits, background) = (
                    url.to_string(),
                    fetcher.clone(),
                    limits.clone(),
                    background.clone(),
                );
                let source_key = urls_api.key_of(url).map(str::to_string);
                let download = artsnack_runtime::spawn_result(cx, async move {
                    fetcher.image_bytes(&url_text).await
                });
                async move {
                    let bytes = download.await?;
                    background
                        .spawn(async move { references::prepare(&bytes, &limits, source_key) })
                        .await
                }
            })
            .collect();
        self.preparing += accepted.len();
        cx.notify();
        let attempted = accepted.len();
        cx.spawn(async move |this, cx| {
            let mut ready = Vec::with_capacity(tasks.len());
            for task in tasks {
                if let Ok(reference) = task.await {
                    ready.push(reference);
                }
            }
            let _ = this.update(cx, |this, cx| {
                this.preparing -= attempted;
                cx.notify();
                if ready.is_empty() {
                    this.notify(
                        Notification::error("Failed to attach selected references"),
                        cx,
                    );
                    return;
                }
                // Re-read: the model may have changed while the batch downloaded.
                let capacity = this.add_limit();
                if capacity == 0 {
                    this.notify(
                        Notification::error("This model does not take reference images"),
                        cx,
                    );
                    return;
                }
                let ready_count = ready.len();
                ready.truncate(capacity);
                let keep = capacity.saturating_sub(ready.len());
                let dropped = this.references.len().saturating_sub(keep);
                let mut next: Vec<Reference> = this.references.iter().take(keep).cloned().collect();
                let attached = ready.len();
                next.extend(ready);
                this.set_references(next, cx);

                let plural = |count: usize, one: &str, many: &str| {
                    if count == 1 {
                        one.to_string()
                    } else {
                        many.to_string()
                    }
                };
                let replaced = if dropped == 0 {
                    String::new()
                } else {
                    format!(
                        " — replaced the last {dropped} existing {}",
                        plural(dropped, "reference", "references")
                    )
                };
                this.notify(
                    Notification::success(format!(
                        "{attached} {} attached{replaced}",
                        plural(attached, "reference", "references")
                    )),
                    cx,
                );
                let skipped = requested - attempted + (ready_count - attached);
                let failed = attempted - ready_count;
                if skipped + failed > 0 {
                    let count = skipped + failed;
                    let tail = if skipped > 0 {
                        format!(" — this model accepts {capacity}")
                    } else {
                        String::new()
                    };
                    this.notify(
                        Notification::warning(format!(
                            "{count} selected {} not attached{tail}",
                            plural(count, "image was", "images were")
                        )),
                        cx,
                    );
                }
            });
        })
        .detach();
    }

    pub(crate) fn toggle_reference(&mut self, id: &SharedString, cx: &mut Context<Self>) {
        let next = self
            .references
            .iter()
            .cloned()
            .map(|mut reference| {
                if &reference.id == id {
                    reference.selected = !reference.selected;
                }
                reference
            })
            .collect();
        self.set_references(next, cx);
    }

    pub(crate) fn remove_reference(&mut self, id: &SharedString, cx: &mut Context<Self>) {
        let next = self
            .references
            .iter()
            .filter(|reference| &reference.id != id)
            .cloned()
            .collect();
        self.set_references(next, cx);
    }

    // --- Higgsfield quotes and balances -------------------------------------

    /// Asks Higgsfield, one at a time, for the prices of the configurations
    /// on screen that have none yet. The answers land in `higgsfield.listCosts`.
    /// A price Higgsfield could not give is asked for again later, waiting
    /// longer each time; a form changed while a batch runs is looked at again
    /// when it ends.
    fn request_quotes(&mut self, cx: &mut Context<Self>) {
        if self.provider() != Some("higgsfield") {
            return;
        }
        if self.quotes.running {
            self.quotes.stale = true;
            return;
        }
        let Some(form) = self.current_form() else {
            return;
        };
        let now = Instant::now();
        let mut known: Vec<String> = self
            .quotes
            .asked
            .iter()
            .filter(|(_, asked)| match asked {
                Asked::Pending { .. } => true,
                Asked::Failed { retry_at, .. } => *retry_at > now,
            })
            .map(|(signature, _)| signature.clone())
            .collect();
        if let Some(costs) = self.costs.read(cx).data() {
            known.extend(costs.iter().map(|cost| cost.signature.clone()));
        }
        let count = self.selected().count();
        let task =
            engine::call::<_, Vec<engine::QuoteRequest>>(cx, "quoteRequests", (form, count, known));
        self.quotes.running = true;
        self.quotes.stale = false;
        cx.spawn(async move |this, cx| {
            let requests = task.await.unwrap_or_default();
            for request in requests {
                let Ok(estimate) = this.update(cx, |this, cx| {
                    let attempts = this
                        .quotes
                        .asked
                        .get(&request.signature)
                        .map_or(0, |asked| asked.attempts());
                    this.quotes
                        .asked
                        .insert(request.signature.clone(), Asked::Pending { attempts });
                    Backend::global(cx).update(cx, |backend, cx| {
                        backend.act(higgsfield::ESTIMATE_COST, &request.args, cx)
                    })
                }) else {
                    return;
                };
                let priced = estimate
                    .await
                    .ok()
                    .and_then(|answer| serde_json::from_value::<Estimate>(answer).ok())
                    .and_then(|estimate| estimate.credits)
                    .is_some();
                if !priced {
                    let _ = this.update(cx, |this, cx| {
                        this.quote_failed(request.signature.clone(), cx)
                    });
                }
            }
            let _ = this.update(cx, |this, cx| {
                this.quotes.running = false;
                if this.quotes.stale {
                    this.request_quotes(cx);
                }
            });
        })
        .detach();
    }

    /// Higgsfield could not price `signature` (or could not be reached): it is
    /// asked again later, waiting twice as long after each failure, and the
    /// option shows no price meanwhile.
    fn quote_failed(&mut self, signature: String, cx: &mut Context<Self>) {
        let attempts = self
            .quotes
            .asked
            .get(&signature)
            .map_or(0, |asked| asked.attempts())
            + 1;
        let wait = QUOTE_RETRY_FIRST
            .saturating_mul(2u32.saturating_pow(attempts.min(16) - 1))
            .min(QUOTE_RETRY_MAX);
        self.quotes.asked.insert(
            signature,
            Asked::Failed {
                attempts,
                retry_at: Instant::now() + wait,
            },
        );
        self.schedule_quote_retry(cx);
    }

    /// Keeps a timer for the earliest failed price that is due again.
    fn schedule_quote_retry(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let Some(due) = self
            .quotes
            .asked
            .values()
            .filter_map(|asked| match asked {
                Asked::Failed { retry_at, .. } if *retry_at > now => Some(*retry_at),
                _ => None,
            })
            .min()
        else {
            return;
        };
        if self
            .quotes
            .retry
            .as_ref()
            .is_some_and(|(scheduled, _)| *scheduled <= due && *scheduled > now)
        {
            return;
        }
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(due - now).await;
            let _ = this.update(cx, |this, cx| {
                this.quotes.retry = None;
                this.request_quotes(cx);
                this.schedule_quote_retry(cx);
            });
        });
        self.quotes.retry = Some((due, task));
    }

    fn fetch_balance_if_needed(&mut self, cx: &mut Context<Self>) {
        match self.provider() {
            Some("atlas") if self.balances.atlas_fetch.is_due() => self.refresh_balance(cx),
            Some("higgsfield") if self.balances.higgsfield_fetch.is_due() => {
                self.balances.higgsfield_fetch = Fetch::Loading;
                let task = Backend::global(cx).update(cx, |backend, cx| {
                    backend.act(
                        higgsfield::REFRESH_BALANCE,
                        &RefreshBalanceArgs::default(),
                        cx,
                    )
                });
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    let _ = this.update(cx, |this, cx| {
                        this.balances.higgsfield_fetch = match result {
                            Ok(()) => Fetch::Done,
                            Err(error) => {
                                tracing::warn!(?error, "could not refresh the Higgsfield balance");
                                this.retry_balance(cx)
                            }
                        };
                    });
                })
                .detach();
            }
            _ => {}
        }
    }

    /// Asks Atlas for its balance now (also after a job started: it moves).
    fn refresh_balance(&mut self, cx: &mut Context<Self>) {
        self.balances.atlas_fetch = Fetch::Loading;
        cx.notify();
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.act(atlas::BALANCE, &NoArgs {}, cx)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.balances.atlas_fetch = match result {
                    Ok(balance) => {
                        this.balances.atlas = balance;
                        Fetch::Done
                    }
                    Err(error) => {
                        tracing::warn!(?error, "could not read the Atlas balance");
                        this.retry_balance(cx)
                    }
                };
                cx.notify();
            });
        })
        .detach();
    }

    /// A balance failed to load: it is asked for again after a while, if its
    /// provider is still the one on screen.
    fn retry_balance(&mut self, cx: &mut Context<Self>) -> Fetch {
        self.balances._retry = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(BALANCE_RETRY).await;
            let _ = this.update(cx, |this, cx| this.fetch_balance_if_needed(cx));
        }));
        Fetch::Failed(Instant::now() + BALANCE_RETRY)
    }

    fn grok_connected(&self, cx: &App) -> Option<bool> {
        self.grok
            .read(cx)
            .data()
            .map(|connection| connection.connected)
    }

    /// The Grok provider is on and the account is not connected.
    pub fn needs_grok_connection(&self, cx: &App) -> bool {
        self.provider() == Some("grok") && self.grok_connected(cx) == Some(false)
    }

    pub fn grok_connection(&self, cx: &App) -> Option<GrokConnection> {
        self.grok
            .read(cx)
            .data()
            .map(|connection| connection.as_ref().clone())
    }

    pub(crate) fn disconnect_grok(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            alert
                .title("Disconnect your Grok account?")
                .description("Grok generations need it connected again.")
                .confirm()
                .ok_text("Disconnect")
                .on_ok(move |_, _, cx| {
                    let task = Backend::global(cx).update(cx, |backend, cx| {
                        backend.mutate(grok_auth::DISCONNECT, &NoArgs {}, cx)
                    });
                    let view = view.clone();
                    cx.spawn(async move |cx| {
                        let result = task.await;
                        let _ = view.update(cx, |this, cx| match result {
                            Ok(()) => {
                                this.notify(Notification::success("Grok account disconnected"), cx)
                            }
                            Err(error) => {
                                this.notify(Notification::error(error.user_message()), cx)
                            }
                        });
                    })
                    .detach();
                    true
                })
        });
    }

    // --- Submit -------------------------------------------------------------

    /// Generate (the button or Cmd-Enter, also from inside a field). What is
    /// typed but not yet committed goes in first, then the plan waits for
    /// every change queued before it.
    pub(crate) fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if self.status.is_some() || self.restoring || self.preparing > 0 || self.view.is_none() {
            return;
        }
        self.commit_drafts(cx);
        // Atlas routes on the prompt: settle it now, not after the debounce.
        if self.provider() == Some("atlas") {
            self._prompt_settle = None;
            self.edit(Edit::Normalize, cx);
        }
        self.status = Some("Starting...".into());
        cx.notify();
        self.after_queued(cx, |this, cx| this.start_submit(cx));
    }

    fn start_submit(&mut self, cx: &mut Context<Self>) {
        let ready = self.view.clone().filter(|view| {
            !view
                .references
                .as_ref()
                .is_some_and(|references| !references.issues.is_empty())
        });
        let (Some(view), Some(form)) = (ready, self.current_form()) else {
            self.status = None;
            cx.notify();
            return;
        };
        let selected: Vec<Reference> = self.selected().cloned().collect();
        let infos: Vec<_> = selected.iter().map(Reference::info).collect();
        let connected = self.grok_connected(cx);
        let grok_limits = Self::grok_limits(cx);
        let downsize = view.downsize_for_grok;
        let plan = engine::call::<_, Plan>(cx, "plan", (form, infos, connected));

        cx.spawn(async move |this, cx| {
            let set_status = |text: String, cx: &mut gpui_kit::AsyncApp| {
                let _ = this.update(cx, |this, cx| {
                    this.status = Some(text.into());
                    cx.notify();
                });
            };
            let outcome: Result<bool, String> = async {
                let plan = plan.await.map_err(|error| error.to_string())?;
                if let Some(error) = plan.error {
                    return Err(error);
                }
                let kind = plan.kind.unwrap_or_default();
                let mut args = plan.args.unwrap_or_else(|| json!({}));
                // Grok Edit/Extend send no images: attached ones stay unsent.
                if !selected.is_empty() && !plan.skip_references {
                    let count = selected.len();
                    set_status(
                        if count == 1 {
                            "Uploading the reference...".into()
                        } else {
                            format!("Uploading {count} references...")
                        },
                        cx,
                    );
                    // The bytes first: downsizing is local work. Then every
                    // upload URL at once and every upload at once, so a batch
                    // of references costs one round trip of each, not one per
                    // reference.
                    let mut prepared = Vec::with_capacity(count);
                    for reference in &selected {
                        prepared.push(if downsize {
                            grok_bytes(reference, grok_limits.as_ref(), &this, cx).await?
                        } else {
                            reference.jpeg.as_ref().clone()
                        });
                    }
                    let url_requests: Vec<_> = this
                        .update(cx, |_, cx| {
                            (0..count)
                                .map(|_| {
                                    Backend::global(cx).update(cx, |backend, cx| {
                                        backend.mutate(grok_generations::UPLOAD_URL, &NoArgs {}, cx)
                                    })
                                })
                                .collect()
                        })
                        .map_err(|_| "The composer closed".to_string())?;
                    let urls = futures::future::join_all(url_requests)
                        .await
                        .into_iter()
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|error| error.user_message().to_string())?;
                    let uploads: Vec<_> = cx.update(|cx| {
                        urls.into_iter()
                            .zip(prepared)
                            .map(|(url, bytes)| {
                                artsnack_runtime::spawn_result(cx, async move {
                                    upload::upload_bytes(&url, bytes, "image/jpeg").await
                                })
                            })
                            .collect()
                    });
                    let ids = futures::future::join_all(uploads)
                        .await
                        .into_iter()
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|error| error.to_string())?;
                    let source_lookups: Vec<_> = cx.update(|cx| {
                        selected
                            .iter()
                            .map(|reference| {
                                engine::call::<_, Option<String>>(
                                    cx,
                                    "referenceSourceKey",
                                    (reference.source_key.clone(),),
                                )
                            })
                            .collect()
                    });
                    let sources: Vec<Option<String>> = futures::future::join_all(source_lookups)
                        .await
                        .into_iter()
                        .map(|source| source.unwrap_or(None))
                        .collect();
                    args["referenceStorageIds"] = json!(ids);
                    args["referenceSourceKeys"] = json!(sources);
                }
                set_status(
                    plan.creating
                        .unwrap_or_else(|| "Creating generation job...".into()),
                    cx,
                );
                let mutation = match kind.as_str() {
                    "atlas" => START_ATLAS,
                    "video" => START_VIDEO,
                    _ => START_IMAGE,
                };
                cx.update(|cx| {
                    Backend::global(cx)
                        .update(cx, |backend, cx| backend.mutate(mutation, &args, cx))
                })
                .await
                .map_err(|error| error.user_message().to_string())?;
                Ok(kind == "atlas")
            }
            .await;

            let _ = this.update(cx, |this, cx| {
                this.status = None;
                match outcome {
                    Ok(atlas) => {
                        if atlas {
                            this.refresh_balance(cx);
                        }
                        cx.emit(ComposerEvent::Started);
                    }
                    Err(message) => this.notify(Notification::error(message), cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- Reproduce ----------------------------------------------------------

    /// Restores a row's settings and references (the web's `recreate`). A
    /// self-hosted clip is handed to the video tab instead. The references
    /// download first; the form is then replaced where the queue has got to
    /// (see the module documentation), and only by the latest Reproduce.
    pub fn reproduce(&mut self, row: Arc<ApiGeneration>, cx: &mut Context<Self>) {
        if row.provider == Some(ApiProvider::Comfy) {
            cx.emit(ComposerEvent::ReproduceVideo(row));
            return;
        }
        let Some(limits) = Self::fal_limits(cx) else {
            return;
        };
        self.restore_request += 1;
        let request = self.restore_request;
        self.restoring = true;
        cx.notify();
        let urls = Media::urls(cx).clone();
        let fetcher = Media::fetcher(cx);
        let keys = row.reference_b2_keys.clone().unwrap_or_default();
        let sources: Vec<Option<String>> = keys
            .iter()
            .enumerate()
            .map(|(index, key)| {
                row.reference_source_keys
                    .as_ref()
                    .and_then(|sources| sources.get(index).cloned().flatten())
                    .or_else(|| Some(key.clone()))
            })
            .collect();
        let row_json = reproduce_row(&row);
        let background = cx.background_executor().clone();
        cx.spawn(async move |this, cx| {
            let mut restored = Vec::with_capacity(keys.len());
            let mut failure = None;
            for (key, source) in keys.iter().zip(sources) {
                // Superseded: a later Reproduce owns the form now.
                if this
                    .read_with(cx, |this, _| this.restore_request != request)
                    .unwrap_or(true)
                {
                    return;
                }
                let url = urls.original(key);
                let fetcher = fetcher.clone();
                let download = cx.update(|cx| {
                    artsnack_runtime::spawn_result(
                        cx,
                        async move { fetcher.image_bytes(&url).await },
                    )
                });
                let limits = limits.clone();
                let prepared = async {
                    let bytes = download.await?;
                    background
                        .spawn(async move { references::prepare(&bytes, &limits, source) })
                        .await
                }
                .await;
                match prepared {
                    Ok(reference) => restored.push(reference),
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            let _ = this.update(cx, |this, cx| {
                if this.restore_request != request {
                    return;
                }
                if let Some(error) = failure {
                    this.restoring = false;
                    this.notify(
                        Notification::error(format!(
                            "Failed to restore generation settings: {error}"
                        )),
                        cx,
                    );
                    cx.notify();
                    return;
                }
                this.queue.push_back(Queued::Restore(Box::new(Restore {
                    request,
                    row: row_json,
                    references: restored,
                })));
                this.pump(cx);
            });
        })
        .detach();
    }

    /// Recreates the form from a row, against the form as the queue has made
    /// it so far.
    fn send_restore(&mut self, restore: Restore, cx: &mut Context<Self>) {
        let Some(form) = self.current_form() else {
            return;
        };
        if restore.request != self.restore_request {
            return;
        }
        self.stepping = true;
        let count = restore.references.len();
        let task = engine::call::<_, Recreated>(cx, "recreate", (form, restore.row, count));
        let (request, references) = (restore.request, restore.references);
        cx.spawn(async move |this, cx| {
            let recreated = task.await;
            let _ = this.update(cx, |this, cx| {
                this.restored(request, references, recreated, cx)
            });
        })
        .detach();
    }

    fn restored(
        &mut self,
        request: u64,
        references: Vec<Reference>,
        recreated: anyhow::Result<Recreated>,
        cx: &mut Context<Self>,
    ) {
        self.stepping = false;
        if request == self.restore_request {
            self.restoring = false;
            match recreated {
                Ok(recreated) => {
                    let prompt = recreated.form["prompt"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    self.form = Some(Arc::new(recreated.form));
                    self.prompt_text = prompt.clone();
                    self.set_prompt_text(prompt, cx);
                    // The attachments are the row's now, all selected.
                    self.replace_references(references, cx);
                    // The view for the restored form, before anything queued
                    // after the Reproduce.
                    self.queue.push_front(Queued::Edit {
                        edit: Edit::Normalize,
                        identity: None,
                    });
                    let notification = if recreated.notice.tone == "warning" {
                        Notification::warning(recreated.notice.text)
                    } else {
                        Notification::success(recreated.notice.text)
                    };
                    self.notify(notification, cx);
                }
                Err(error) => self.notify(
                    Notification::error(format!("Failed to restore generation settings: {error}")),
                    cx,
                ),
            }
        }
        cx.notify();
        self.pump(cx);
    }

    // --- Rendering ------------------------------------------------------------

    pub(crate) fn is_busy(&self) -> bool {
        self.status.is_some() || self.restoring
    }

    fn render_generate_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let view = self.view.as_ref();
        let issues = view
            .and_then(|view| view.references.as_ref())
            .is_some_and(|references| !references.issues.is_empty());
        let retired = view.is_some_and(|view| view.retired);
        let grok_pending = self.provider() == Some("grok") && self.grok_connected(cx).is_none();
        let disabled = view.is_none()
            || self.is_busy()
            || self.preparing > 0
            || issues
            || retired
            || grok_pending
            || self.needs_grok_connection(cx);
        let busy_label = if self.restoring {
            Some(SharedString::from("Restoring..."))
        } else {
            self.status.clone()
        };
        let label: SharedString = match (&busy_label, view) {
            (Some(status), _) => status.clone(),
            (None, Some(view)) if view.price.included => view.button_label.clone().into(),
            (None, Some(view)) => format!("{} · {}", view.button_label, view.price.text).into(),
            (None, None) => "Generate".into(),
        };
        let tooltip = view.and_then(|view| view.price.tooltip.clone());
        Button::new("api-generate")
            .primary()
            .large()
            .w_full()
            .icon(IconName::Sparkles)
            .label(label)
            .loading(busy_label.is_some())
            .disabled(disabled)
            .when_some(tooltip, |button, tooltip| button.tooltip(tooltip))
            .on_click(cx.listener(|this, _, window, cx| this.submit(&Submit, window, cx)))
            .into_any_element()
    }

    fn render_prompt(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .gap_1()
            .child(
                h_flex()
                    .min_h_7()
                    .justify_between()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child("Prompt"),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(
                                Button::new("api-write-with-ai")
                                    .xsmall()
                                    .when(self.studio_open, |button| button.primary())
                                    .when(!self.studio_open, |button| button.ghost())
                                    .icon(IconName::Bot)
                                    .label("Write with AI")
                                    .tooltip(if self.studio_open {
                                        "Close Prompt Studio"
                                    } else {
                                        "Describe the idea and pick from the prompts a model writes"
                                    })
                                    .on_click(cx.listener(|_, _, _, cx| {
                                        cx.emit(ComposerEvent::ToggleStudio)
                                    })),
                            )
                            .child(self.enhancer.clone())
                            .child(self.library.clone()),
                    ),
            )
            .child(self.mentions.clone())
            .into_any_element()
    }
}

/// The Grok-sized copy of a reference, made once and kept.
async fn grok_bytes(
    reference: &Reference,
    limits: Option<&upload::ProfileLimits>,
    this: &gpui_kit::WeakEntity<ApiComposer>,
    cx: &mut gpui_kit::AsyncApp,
) -> Result<Vec<u8>, String> {
    if let Some(bytes) = &reference.grok_jpeg {
        return Ok(bytes.as_ref().clone());
    }
    let Some(limits) = limits.cloned() else {
        return Ok(reference.jpeg.as_ref().clone());
    };
    let source = reference.jpeg.clone();
    let prepared = cx
        .background_executor()
        .spawn(async move { upload::prepare(&source, &limits) })
        .await
        .map_err(|error| format!("Failed to process image: {error}"))?;
    let jpeg = Arc::new(prepared.jpeg);
    let id = reference.id.clone();
    let cached = jpeg.clone();
    let _ = this.update(cx, |this, _| {
        if let Some(reference) = this
            .references
            .iter_mut()
            .find(|candidate| candidate.id == id)
        {
            reference.grok_jpeg = Some(cached);
        }
    });
    Ok(jpeg.as_ref().clone())
}

/// The fields of a row that `recreate` reads, in the web's spelling.
fn reproduce_row(row: &ApiGeneration) -> Value {
    let provider = match row.provider {
        Some(ApiProvider::Grok) | None => None,
        Some(ApiProvider::Fal) => Some("fal"),
        Some(ApiProvider::Higgsfield) => Some("higgsfield"),
        Some(ApiProvider::Atlas) => Some("atlas"),
        Some(ApiProvider::Comfy) => Some("comfy"),
        Some(ApiProvider::Other) => Some("other"),
    };
    json!({
        "provider": provider,
        "apiModel": row.api_model,
        "atlasParams": row.atlas_params,
        "mediaType": if row.is_video() { "video" } else { "image" },
        "prompt": row.prompt,
        "aspectRatio": row.aspect_ratio,
        "count": row.count,
        "quality": row.quality,
        "resolution": row.resolution,
        "duration": row.duration,
        "videoTier": row.video_tier,
        "videoJobType": row.video_job_type,
        "videoMode": row.video_mode,
        "generateAudio": row.generate_audio,
        "bitrateMode": row.bitrate_mode,
        "referenceVoices": row.reference_voices,
        "hasReferenceImage": row.has_reference_image,
        "referenceB2Keys": row.reference_b2_keys,
        "grokVideoModel": row.grok_video_model,
        "grokVideoMode": row.grok_video_mode,
        "grokFrameRoles": row.grok_frame_roles,
        "sourceVideoKey": row.source_video_key,
        "sourceVideoSeconds": row.source_video_seconds,
    })
}

impl Focusable for ApiComposer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// `form` with `prompt` in it.
fn with_prompt(form: &Value, prompt: &str) -> Value {
    let mut form = form.clone();
    form["prompt"] = Value::String(prompt.to_string());
    form
}

/// Takes images out of every window's GPU atlas, where GPUI keeps whatever
/// was drawn until told. Deferred to where no window is being updated, so
/// the one in use is reached too.
fn release_images(images: Vec<Arc<RenderImage>>, cx: &mut App) {
    if images.is_empty() {
        return;
    }
    cx.defer(move |cx| {
        for image in images {
            cx.drop_image(image, None);
        }
    });
}

impl Render for ApiComposer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The controls drawn now are for this model; edits made on them carry it.
        self.rendered_identity = self.view.as_ref().map(|view| view.identity.clone());
        let body: AnyElement = match self.view.clone() {
            None => v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .child(Spinner::new())
                .into_any_element(),
            Some(view) => {
                let connection = self
                    .grok_connection(cx)
                    .filter(|connection| connection.connected && self.provider() == Some("grok"));
                v_flex()
                    .id("api-form")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_4()
                    .gap_3()
                    .when_some(connection, |this, connection| {
                        this.child(
                            h_flex()
                                .justify_between()
                                .gap_2()
                                .p_3()
                                .rounded(cx.theme().radius_lg)
                                .border_1()
                                .border_color(cx.theme().border)
                                .child(
                                    v_flex()
                                        .min_w_0()
                                        .child(
                                            div()
                                                .text_sm()
                                                .font_weight(gpui_kit::FontWeight::MEDIUM)
                                                .truncate()
                                                .child(
                                                    connection
                                                        .email
                                                        .unwrap_or_else(|| "Grok account".into()),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(cx.theme().muted_foreground)
                                                .child("Connected via SuperGrok"),
                                        ),
                                )
                                .child(
                                    Button::new("grok-disconnect")
                                        .outline()
                                        .small()
                                        .label("Disconnect")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.disconnect_grok(window, cx)
                                        })),
                                ),
                        )
                    })
                    .child(self.render_prompt(cx))
                    .children(self.render_references(&view, window, cx))
                    .child(self.render_fields(&view, window, cx))
                    .into_any_element()
            }
        };
        v_flex()
            .id("api-composer")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::submit))
            .size_full()
            .child(body)
            .child(
                div()
                    .p_4()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(self.render_generate_button(cx)),
            )
    }
}
