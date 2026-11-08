//! Prompt Studio: write a prompt with a model instead of by hand (the web's
//! components/prompt-studio/). "Write with AI" beside the prompt opens it in
//! the results pane; the form stays live beside it, so the target model,
//! duration, ratio and references it writes for are always the current ones.
//!
//! Describe the idea in a few words, in any language, tagging references with
//! `@image1`…; the model answers with one to three variants, each with a short
//! summary in that language. "Use this prompt" puts one in the form and
//! "Refine" answers it. A model that can see images is shown the references.
//!
//! The rules — the system prompt, the reply format, labels, the word diff —
//! are packages/shared/prompt-studio.ts: the server applies them in
//! `promptStudioRun:send`, and the diff runs here through QuickJS. Sessions
//! live in Convex (`promptStudio:*`); images are never stored, so every turn
//! sends them again.

mod card;

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

use artsnack_backend::{
    Backend, LiveQuery, NoArgs, QueryState,
    api::{
        enhance_recipes::{Recipe, RecipeMedia},
        prompt_studio::{
            self, SendArgs, SendResult, SessionArgs, StudioMessage, StudioSession,
            StudioSessionSummary, StudioVariant,
        },
    },
};
use artsnack_media::upload::{self, ProfileLimits};
use artsnack_prompts::{EnhanceModel, PromptStore, StoreEvent, enhance_models};
use artsnack_rules::Rules;
use artsnack_settings::{Preference, Preferences};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, ImageSource,
    InteractiveElement as _, IntoElement, KeyBinding, ObjectFit, ParentElement as _, Render,
    RenderImage, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Subscription, Task, WeakEntity, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariants as _},
        h_flex,
        input::{InputEvent, TextareaState},
        menu::{DropdownMenu as _, PopupMenuItem},
        notification::Notification,
        popover::Popover,
        spinner::Spinner,
        switch::Switch,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
    px, rems,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    composer::ApiComposer,
    mention::{PromptMentions, TagInserted, TaggableReferences},
    results::copied::CopiedMark,
};

pub(crate) use card::DiffSegment;

actions!(prompt_studio, [SendStudioMessage]);

const CONTEXT: &str = "PromptStudio";

/// Cmd+Enter in the studio sends its message. Without this the tab's own
/// Cmd+Enter would start a (paid) generation from inside the chat box.
pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-enter", SendStudioMessage, Some(CONTEXT)),
        KeyBinding::new(
            "cmd-enter",
            SendStudioMessage,
            Some(&format!("{CONTEXT} > Input")),
        ),
    ]);
}

/// How long the client waits for an answer: as long as Convex lets an action
/// run. A bad reply is retried once on the server and Grok falls back to
/// Atlas, so it can take minutes; the button stays busy until the server
/// gives up, so the same paid call is never sent twice.
const SEND_DEADLINE: Duration = Duration::from_secs(600);

/// A selected reference, in `@imageN` order.
#[derive(Clone)]
pub(crate) struct StudioReference {
    pub id: SharedString,
    /// The attachment as the composer keeps it (fal's profile).
    pub jpeg: Arc<Vec<u8>>,
    pub preview: Arc<RenderImage>,
}

/// What the studio remembers between visits (`prompt-studio-prefs` on the web).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StudioPrefs {
    variant_count: u32,
    /// An `ENHANCE_MODELS` id; unset follows the Enhance model setting.
    model_id: Option<String>,
    /// Show the references to a model that can see them.
    vision: bool,
    /// Recipe id per media type, or "auto".
    formats: Formats,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Formats {
    image: Option<String>,
    video: Option<String>,
}

impl Formats {
    fn get(&self, media: &str) -> Option<&str> {
        match media {
            "video" => self.video.as_deref(),
            _ => self.image.as_deref(),
        }
    }

    fn set(&mut self, media: &str, value: String) {
        match media {
            "video" => self.video = Some(value),
            _ => self.image = Some(value),
        }
    }
}

impl Default for StudioPrefs {
    fn default() -> Self {
        Self {
            variant_count: 3,
            model_id: None,
            vision: true,
            formats: Formats::default(),
        }
    }
}

const PREFS: Preference<StudioPrefs> = Preference::new("studio.prefs", StudioPrefs::default);
/// The session showing (`prompt-studio-session` on the web).
const SESSION: Preference<Option<String>> = Preference::new("studio.session", || None);

/// The limits `packages/shared/prompt-studio.ts` sets, read once.
struct Limits {
    max_images: usize,
    /// UTF-16 units, as the server counts.
    max_text: usize,
    variant_counts: Vec<u32>,
    /// The `studio` reference profile: four images fit an action's arguments.
    profile: Option<ProfileLimits>,
}

impl Limits {
    fn read(cx: &App) -> Self {
        let rules = Rules::global(cx);
        let get = |path: &str| rules.and_then(|rules| rules.get::<usize>(path).ok());
        Self {
            max_images: get("promptStudio.MAX_STUDIO_IMAGES").unwrap_or(4),
            max_text: get("promptStudio.MAX_STUDIO_TEXT").unwrap_or(4000),
            variant_counts: rules
                .and_then(|rules| rules.get("promptStudio.STUDIO_VARIANT_COUNTS").ok())
                .unwrap_or_else(|| vec![1, 2, 3]),
            profile: rules.and_then(|rules| {
                rules
                    .get("referenceProfile.REFERENCE_PROFILES.studio")
                    .inspect_err(|error| tracing::error!(?error, "no studio reference profile"))
                    .ok()
            }),
        }
    }
}

/// A message on its way, shown until the session has it.
struct Pending {
    text: String,
    reply_to: Option<String>,
    count: u32,
    started: Instant,
}

/// What the studio last drew of the form, so a change elsewhere in the
/// composer (a slider, a price) does not redraw the chat.
#[derive(PartialEq)]
struct FormSeen {
    prompt: String,
    context: Option<Value>,
    references: Vec<SharedString>,
}

/// The recipes listed for a media type, for the rows they came from.
struct Formatted {
    recipes: Arc<Vec<Recipe>>,
    media: String,
    listed: Arc<Vec<Recipe>>,
}

#[derive(Clone, Debug)]
pub(crate) enum StudioEvent {
    Close,
}

pub(crate) struct PromptStudio {
    composer: WeakEntity<ApiComposer>,
    store: Entity<PromptStore>,
    models: Vec<EnhanceModel>,
    limits: Limits,
    prefs: StudioPrefs,
    session_id: Option<String>,
    session: Option<Entity<LiveQuery<Option<StudioSession>>>>,
    /// History's rows, subscribed only while it is open.
    history: Option<Entity<LiveQuery<Vec<StudioSessionSummary>>>>,
    _session_watch: Option<Subscription>,
    _history_watch: Option<Subscription>,
    history_open: bool,
    input: Entity<TextareaState>,
    /// The message box's placeholder as last set.
    placeholder: SharedString,
    mentions: Entity<PromptMentions>,
    /// The variant the next message refines.
    reply_to: Option<String>,
    include_prompt: bool,
    pending: Option<Pending>,
    _tick: Option<Task<()>>,
    /// Each reference re-encoded once at the studio profile, by id.
    data_urls: HashMap<SharedString, Arc<str>>,
    _warm: Option<Task<Result<Vec<String>, SharedString>>>,
    /// Revisions whose prompt is open in full, by label.
    expanded: HashSet<String>,
    /// Revisions showing their own text rather than the changes, by label.
    plain: HashSet<String>,
    /// Word diffs of revisions against their parent, by label.
    diffs: HashMap<String, Option<Arc<Vec<DiffSegment>>>>,
    copied: CopiedMark,
    formatted: Option<Formatted>,
    form: FormSeen,
    scroll: ScrollHandle,
    /// The message count and pending state the chat was last scrolled for.
    scrolled_for: (usize, bool),
    /// Shown: hidden, it neither prepares images nor follows the form.
    open: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<StudioEvent> for PromptStudio {}

impl PromptStudio {
    pub fn new(composer: Entity<ApiComposer>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = PromptStore::global(cx);
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(2, 10)
                .submit_on_enter(true)
                .placeholder(EMPTY_PLACEHOLDER)
        });
        let taggable: TaggableReferences = {
            let composer = composer.downgrade();
            std::rc::Rc::new(move |cx| {
                composer
                    .upgrade()
                    .map(|composer| {
                        composer
                            .read(cx)
                            .studio_references()
                            .into_iter()
                            .map(|reference| reference.preview)
                            .collect()
                    })
                    .unwrap_or_default()
            })
        };
        let mentions =
            cx.new(|cx| PromptMentions::new(input.clone(), taggable, window, cx).menu_above());
        let subscriptions = vec![
            cx.observe(&composer, |this, _, cx| this.sync_form(cx)),
            cx.subscribe(&store, |_, _, event: &StoreEvent, cx| {
                if *event != StoreEvent::SavedPrompts {
                    cx.notify();
                }
            }),
            // Enter sends, Shift+Enter breaks the line: a chat box's convention.
            cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::PressEnter { shift: false, .. } => this.send(window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            }),
            cx.subscribe(&mentions, |_, _, _: &TagInserted, cx| cx.notify()),
        ];
        let prefs = Preferences::get(cx, &PREFS);
        let session_id = Preferences::get(cx, &SESSION);
        let mut this = Self {
            composer: composer.downgrade(),
            store,
            models: enhance_models(cx),
            limits: Limits::read(cx),
            prefs,
            session_id: None,
            session: None,
            history: None,
            _session_watch: None,
            _history_watch: None,
            history_open: false,
            input,
            placeholder: EMPTY_PLACEHOLDER.into(),
            mentions,
            reply_to: None,
            include_prompt: true,
            pending: None,
            _tick: None,
            data_urls: HashMap::new(),
            _warm: None,
            expanded: HashSet::new(),
            plain: HashSet::new(),
            diffs: HashMap::new(),
            copied: CopiedMark::default(),
            formatted: None,
            form: FormSeen {
                prompt: String::new(),
                context: None,
                references: Vec::new(),
            },
            scroll: ScrollHandle::new(),
            scrolled_for: (usize::MAX, false),
            open: false,
            _subscriptions: subscriptions,
        };
        this.show_session(session_id, cx);
        this
    }

    /// Shown or hidden by the tab. Opening focuses the message box and starts
    /// preparing the references the model will see.
    pub fn set_open(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.open == open {
            return;
        }
        self.open = open;
        if open {
            self.store.update(cx, |store, cx| store.ensure_seeded(cx));
            self.sync_form(cx);
            self.prewarm(cx);
            self.focus_input(window, cx);
            self.scrolled_for = (usize::MAX, false);
        } else {
            self.history_open = false;
            self.history = None;
            self._history_watch = None;
        }
        cx.notify();
    }

    fn focus_input(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| input.focus(window, cx));
    }

    // --- The form beside it -------------------------------------------------

    fn references(&self, cx: &App) -> Vec<StudioReference> {
        self.composer
            .upgrade()
            .map(|composer| composer.read(cx).studio_references())
            .unwrap_or_default()
    }

    /// Redraws when what the studio shows of the form changed.
    fn sync_form(&mut self, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        let Some(composer) = self.composer.upgrade() else {
            return;
        };
        let composer = composer.read(cx);
        let seen = FormSeen {
            prompt: composer.prompt_text().to_string(),
            context: composer.studio_context().cloned(),
            references: composer
                .studio_references()
                .into_iter()
                .map(|reference| reference.id)
                .collect(),
        };
        if seen == self.form {
            return;
        }
        let references_changed = seen.references != self.form.references;
        self.form = seen;
        if references_changed {
            // An encoding is kept only while its reference is attached.
            let ids: HashSet<&SharedString> = self.form.references.iter().collect();
            self.data_urls.retain(|id, _| ids.contains(id));
            self.prewarm(cx);
        }
        cx.notify();
    }

    fn media(&self) -> &str {
        self.form
            .context
            .as_ref()
            .and_then(|context| context["media"].as_str())
            .filter(|media| *media == "video")
            .unwrap_or("image")
    }

    // --- Choices --------------------------------------------------------------

    fn update_prefs(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut StudioPrefs)) {
        change(&mut self.prefs);
        Preferences::set(cx, &PREFS, self.prefs.clone());
        self.prewarm(cx);
        cx.notify();
    }

    fn variant_count(&self) -> u32 {
        if self
            .limits
            .variant_counts
            .contains(&self.prefs.variant_count)
        {
            self.prefs.variant_count
        } else {
            3
        }
    }

    /// The studio's own pick, else the Enhance model, else the first
    /// (`getEnhanceModel` falls back the same way).
    fn model(&self, cx: &App) -> Option<&EnhanceModel> {
        let enhance = self
            .store
            .read(cx)
            .settings(cx)
            .map(|settings| settings.model_id);
        let find =
            |id: Option<&str>| id.and_then(|id| self.models.iter().find(|model| model.id == id));
        find(self.prefs.model_id.as_deref())
            .or_else(|| find(enhance.as_deref()))
            .or_else(|| self.models.first())
    }

    /// The model is shown the references.
    fn seeing(&self, cx: &App) -> bool {
        self.prefs.vision
            && self.model(cx).is_some_and(|model| model.vision)
            && !self.form.references.is_empty()
    }

    /// The Enhance recipes a prompt can follow for this media type.
    fn formats(&mut self, cx: &App) -> Arc<Vec<Recipe>> {
        let Some(recipes) = self.store.read(cx).recipes(cx).data else {
            return Arc::default();
        };
        let media = self.media().to_string();
        if let Some(cached) = &self.formatted
            && Arc::ptr_eq(&cached.recipes, &recipes)
            && cached.media == media
        {
            return cached.listed.clone();
        }
        let listed = Arc::new(recipes_for(&recipes, &media, cx));
        self.formatted = Some(Formatted {
            recipes,
            media,
            listed: listed.clone(),
        });
        listed
    }

    fn format(&mut self, cx: &App) -> Option<Recipe> {
        let key = self.prefs.formats.get(self.media())?.to_string();
        self.formats(cx)
            .iter()
            .find(|recipe| recipe.id == key)
            .cloned()
    }

    fn pick_format(&mut self, id: String, cx: &mut Context<Self>) {
        let media = self.media().to_string();
        // A recipe tuned for one model (H3 structured → MiMo) brings it.
        let model = self
            .formats(cx)
            .iter()
            .find(|recipe| recipe.id == id)
            .and_then(|recipe| recipe.model_id.clone());
        self.update_prefs(cx, |prefs| {
            prefs.formats.set(&media, id);
            if model.is_some() {
                prefs.model_id = model;
            }
        });
    }

    // --- The session -------------------------------------------------------

    fn show_session(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        Preferences::set(cx, &SESSION, id.clone());
        if id != self.session_id {
            self.reply_to = None;
            self.expanded.clear();
            self.plain.clear();
            self.diffs.clear();
            self.scrolled_for = (usize::MAX, false);
        }
        self.session_id = id.clone();
        if id.is_none() {
            self._session_watch = None;
        }
        self.session = id.map(|session_id| {
            let args = SessionArgs { session_id };
            match self.session.take() {
                Some(query) => {
                    query.update(cx, |query, cx| {
                        query.set_args(prompt_studio::GET, &args, cx)
                    });
                    query
                }
                None => {
                    let query = LiveQuery::new(prompt_studio::GET, &args, cx);
                    self._session_watch = Some(cx.observe(&query, |_, _, cx| cx.notify()));
                    query
                }
            }
        });
        cx.notify();
    }

    /// The session on screen: the query's answer for the id shown, never the
    /// previous session's while the next loads.
    fn session<'a>(&'a self, cx: &'a App) -> Option<&'a StudioSession> {
        let id = self.session_id.as_deref()?;
        let data = self.session.as_ref()?.read(cx).data()?;
        data.as_ref().as_ref().filter(|session| session.id == id)
    }

    fn messages<'a>(&'a self, cx: &'a App) -> &'a [StudioMessage] {
        self.session(cx)
            .map(|session| session.messages.as_slice())
            .unwrap_or_default()
    }

    /// The session's answer has not arrived yet.
    fn session_loading(&self, cx: &App) -> bool {
        let (Some(id), Some(query)) = (self.session_id.as_deref(), self.session.as_ref()) else {
            return false;
        };
        match query.read(cx).state() {
            QueryState::Ready { data, stale } => {
                *stale
                    && data
                        .as_ref()
                        .as_ref()
                        .is_none_or(|session| session.id != id)
            }
            QueryState::Loading => true,
            QueryState::Failed(_) => false,
        }
    }

    /// The session on screen could not be read. Sending is held until it
    /// is: without its history the message would start a new session.
    fn session_error(&self, cx: &App) -> Option<SharedString> {
        self.session_id.as_ref()?;
        self.session.as_ref()?.read(cx).error().cloned()
    }

    fn retry_session(&mut self, cx: &mut Context<Self>) {
        let (Some(session_id), Some(query)) = (self.session_id.clone(), self.session.as_ref())
        else {
            return;
        };
        query.update(cx, |query, cx| {
            query.retry(prompt_studio::GET, &SessionArgs { session_id }, cx)
        });
        cx.notify();
    }

    /// The id to send to: a remembered session that was deleted since (here
    /// or elsewhere) reads as none, and the next send starts a new one.
    fn live_session_id(&self, cx: &App) -> Option<String> {
        self.session(cx).map(|session| session.id.clone())
    }

    fn loading(&self, cx: &App) -> bool {
        let store = self.store.read(cx);
        store.settings(cx).is_none()
            || store.recipes(cx).data.is_none()
            || self.session_loading(cx)
            || self.session_error(cx).is_some()
    }

    fn set_history_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.history_open = open;
        if open && self.history.is_none() {
            let query = LiveQuery::new(prompt_studio::LIST, &NoArgs {}, cx);
            self._history_watch = Some(cx.observe(&query, |_, _, cx| cx.notify()));
            self.history = Some(query);
        } else if !open {
            self.history = None;
            self._history_watch = None;
        }
        cx.notify();
    }

    fn delete_session(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.session_id.as_deref() == Some(id.as_str()) {
            self.show_session(None, cx);
        }
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(prompt_studio::REMOVE, &SessionArgs { session_id: id }, cx)
        });
        cx.spawn_in(window, async move |_, cx| {
            if let Err(error) = task.await {
                let _ = cx.update(|window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx)
                });
            }
        })
        .detach();
    }

    // --- Images ---------------------------------------------------------------

    /// The references as data URLs at the studio profile, each encoded once.
    fn encode(
        &self,
        references: Vec<StudioReference>,
        cx: &mut Context<Self>,
    ) -> Task<Result<Vec<String>, SharedString>> {
        let jobs: Vec<(StudioReference, Option<Arc<str>>)> = references
            .into_iter()
            .map(|reference| {
                let cached = self.data_urls.get(&reference.id).cloned();
                (reference, cached)
            })
            .collect();
        let profile = self.limits.profile.clone();
        cx.spawn(async move |this, cx| {
            let mut urls = Vec::with_capacity(jobs.len());
            for (reference, cached) in jobs {
                let url = match cached {
                    Some(url) => url,
                    None => {
                        let profile = profile
                            .clone()
                            .ok_or_else(|| SharedString::from("The image settings did not load"))?;
                        let jpeg = reference.jpeg.clone();
                        let url = cx
                            .background_executor()
                            .spawn(async move { data_url(&jpeg, &profile) })
                            .await
                            .map_err(|error| {
                                SharedString::from(format!("Could not prepare an image ({error})"))
                            })?;
                        let (id, kept) = (reference.id.clone(), url.clone());
                        let _ = this.update(cx, |this, _| {
                            this.data_urls.insert(id, kept);
                        });
                        url
                    }
                };
                urls.push(url.to_string());
            }
            Ok(urls)
        })
    }

    /// Encodes the references while the message is still being typed, so a
    /// send only waits for the model.
    fn prewarm(&mut self, cx: &mut Context<Self>) {
        if !self.open || !self.seeing(cx) {
            return;
        }
        let missing: Vec<StudioReference> = self
            .references(cx)
            .into_iter()
            .take(self.limits.max_images)
            .filter(|reference| !self.data_urls.contains_key(&reference.id))
            .collect();
        if !missing.is_empty() {
            self._warm = Some(self.encode(missing, cx));
        }
    }

    // --- Sending ---------------------------------------------------------------

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let body = self.input.read(cx).value().trim().to_string();
        if body.is_empty() || self.pending.is_some() || self.loading(cx) {
            return;
        }
        if body.encode_utf16().count() > self.limits.max_text {
            let message = format!(
                "Messages are limited to {} characters",
                self.limits.max_text
            );
            window.push_notification(Notification::error(message), cx);
            return;
        }
        if self.form.context.is_none() {
            window.push_notification(Notification::error("The form is still loading"), cx);
            return;
        }
        let Some(model) = self.model(cx).cloned() else {
            window.push_notification(Notification::error("No model to write with"), cx);
            return;
        };
        let Some(composer) = self.composer.upgrade() else {
            return;
        };
        let reply_to = self
            .reply_to
            .clone()
            .filter(|label| find_variant(self.messages(cx), label).is_some());
        let count = self.variant_count();
        let args = SendArgs {
            session_id: self.live_session_id(cx),
            text: body.clone(),
            reply_to: reply_to.clone(),
            variant_count: count,
            format_id: self.format(cx).map(|recipe| recipe.id),
            model_id: model.id.clone(),
            context: Value::Null,
            current_prompt: None,
            images: None,
        };
        let shows_images = self.prefs.vision && model.vision;

        self.pending = Some(Pending {
            text: body.clone(),
            reply_to: reply_to.clone(),
            count,
            started: Instant::now(),
        });
        self.reply_to = None;
        self.mentions
            .update(cx, |mentions, cx| mentions.set_text("", window, cx));
        self._tick = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        }));
        cx.notify();

        // A model, a reference or a field changed just now may still be on
        // its way into the view: the context, the prompt and the images are
        // read once it is in, so they describe the same form.
        let settled = composer.update(cx, |composer, cx| composer.settled(cx));
        cx.spawn_in(window, async move |this, cx| {
            settled.await;
            let Ok(form) = this.update(cx, |this, cx| {
                this.sync_form(cx);
                this.read_form(shows_images, cx)
            }) else {
                return;
            };
            let result: Result<SendResult, SharedString> = match form {
                Err(error) => Err(error),
                Ok((context, prompt, shown)) => {
                    let Ok(images) = this.update(cx, |this, cx| this.encode(shown, cx)) else {
                        return;
                    };
                    match images.await {
                        Err(error) => Err(error),
                        Ok(images) => {
                            let include = this
                                .read_with(cx, |this, _| this.include_prompt)
                                .unwrap_or(false);
                            let args = SendArgs {
                                context,
                                current_prompt: (include && !prompt.is_empty()).then_some(prompt),
                                images: (!images.is_empty()).then_some(images),
                                ..args
                            };
                            let task = this.update(cx, |_, cx| {
                                Backend::global(cx).update(cx, |backend, cx| {
                                    backend.act_within(
                                        prompt_studio::SEND,
                                        &args,
                                        SEND_DEADLINE,
                                        cx,
                                    )
                                })
                            });
                            match task {
                                Ok(task) => task.await.map_err(|error| error.user_message()),
                                Err(_) => return,
                            }
                        }
                    }
                }
            };
            let _ = this.update_in(cx, |this, window, cx| {
                this.finish(result, body, reply_to, window, cx)
            });
        })
        .detach();
    }

    /// The form as it is now: its `StudioContext`, its prompt, and the
    /// references to show the model (none when it is not to see them).
    fn read_form(
        &self,
        shows_images: bool,
        cx: &App,
    ) -> Result<(Value, String, Vec<StudioReference>), SharedString> {
        let composer = self
            .composer
            .upgrade()
            .ok_or_else(|| SharedString::from("The form is gone"))?;
        let composer = composer.read(cx);
        let context = composer
            .studio_context()
            .cloned()
            .ok_or_else(|| SharedString::from("The form is still loading"))?;
        let prompt = composer.prompt_text().trim().to_string();
        let shown = if shows_images {
            composer
                .studio_references()
                .into_iter()
                .take(self.limits.max_images)
                .collect()
        } else {
            Vec::new()
        };
        Ok((context, prompt, shown))
    }

    fn finish(
        &mut self,
        result: Result<SendResult, SharedString>,
        body: String,
        reply_to: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending = None;
        self._tick = None;
        match result {
            Ok(sent) => {
                if sent.fell_back {
                    let detail = format!(
                        "Grok did not answer ({}).",
                        sent.reason.as_deref().unwrap_or("unknown")
                    );
                    window.push_notification(
                        Notification::info(detail)
                            .title(format!("Answered by {} on Atlas", sent.model)),
                        cx,
                    );
                }
                self.show_session(Some(sent.session_id), cx);
            }
            Err(message) => {
                window.push_notification(Notification::error(message), cx);
                // Give the words back, unless something new was typed meanwhile.
                if self.input.read(cx).value().trim().is_empty() {
                    self.mentions
                        .update(cx, |mentions, cx| mentions.set_text(&body, window, cx));
                }
                if self.reply_to.is_none() {
                    self.reply_to = reply_to;
                }
            }
        }
        cx.notify();
    }

    // --- Variants ------------------------------------------------------------

    fn insert(&mut self, label: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(variant) = find_variant(self.messages(cx), label).cloned() else {
            return;
        };
        let Some(composer) = self.composer.upgrade() else {
            return;
        };
        let previous = composer.read(cx).prompt_text().to_string();
        let inserted = variant.prompt.clone();
        composer.update(cx, |composer, cx| {
            composer.replace_prompt(inserted.clone(), window, cx)
        });
        let weak = composer.downgrade();
        let notice = Notification::info(format!("Variant {} is in the prompt", variant.label))
            .action(move |_, _, cx| {
                let (previous, inserted, weak) = (previous.clone(), inserted.clone(), weak.clone());
                Button::new("studio-undo")
                    .small()
                    .label("Undo")
                    .on_click(cx.listener(move |notification, _, window, cx| {
                        if let Some(composer) = weak.upgrade() {
                            if composer.read(cx).prompt_text() == inserted {
                                composer.update(cx, |composer, cx| {
                                    composer.replace_prompt(previous.clone(), window, cx)
                                });
                            } else {
                                window.push_notification(
                                    Notification::info(
                                        "The prompt was changed since — nothing was undone",
                                    ),
                                    cx,
                                );
                            }
                        }
                        notification.dismiss(window, cx);
                    }))
            });
        window.push_notification(notice, cx);
    }

    fn refine(&mut self, label: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.reply_to = if self.reply_to.as_deref() == Some(label) {
            None
        } else {
            Some(label.to_string())
        };
        self.focus_input(window, cx);
        cx.notify();
    }

    /// The revision's changes against its parent, worked out once.
    fn diff(
        &mut self,
        variant: &StudioVariant,
        parent: &StudioVariant,
        cx: &App,
    ) -> Option<Arc<Vec<DiffSegment>>> {
        if let Some(cached) = self.diffs.get(&variant.label) {
            return cached.clone();
        }
        let diff = Rules::global(cx)
            .and_then(|rules| {
                rules
                    .call::<_, Option<Vec<DiffSegment>>>(
                        "promptStudio.diffWords",
                        &(&parent.prompt, &variant.prompt),
                    )
                    .inspect_err(|error| tracing::warn!(?error, "diffWords failed"))
                    .ok()
                    .flatten()
            })
            .map(Arc::new);
        self.diffs.insert(variant.label.clone(), diff.clone());
        diff
    }
}

const EMPTY_PLACEHOLDER: &str =
    "e.g. The woman from @image1 dances in the desert at sunset, the dress flowing…";

/// The newest variant with this label (`findStudioVariant`).
fn find_variant<'a>(messages: &'a [StudioMessage], label: &str) -> Option<&'a StudioVariant> {
    messages.iter().rev().find_map(|message| match message {
        StudioMessage::Assistant { variants, .. } => {
            variants.iter().find(|variant| variant.label == label)
        }
        StudioMessage::User { .. } => None,
    })
}

/// `data:image/jpeg;base64,…` at the studio profile.
fn data_url(jpeg: &[u8], profile: &ProfileLimits) -> anyhow::Result<Arc<str>> {
    const PREFIX: &str = "data:image/jpeg;base64,";
    let prepared = upload::prepare(jpeg, profile)?;
    let mut url = String::with_capacity(PREFIX.len() + prepared.jpeg.len().div_ceil(3) * 4);
    url.push_str(PREFIX);
    STANDARD.encode_string(&prepared.jpeg, &mut url);
    Ok(url.into())
}

/// The recipes for a media type, defaults first (`recipesFor`).
fn recipes_for(recipes: &[Recipe], media: &str, cx: &App) -> Vec<Recipe> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Key<'a> {
        #[serde(rename = "_id")]
        id: &'a str,
        media: RecipeMedia,
        is_default: bool,
    }
    #[derive(Deserialize)]
    struct Listed {
        #[serde(rename = "_id")]
        id: String,
    }
    let keys: Vec<Key> = recipes
        .iter()
        .map(|recipe| Key {
            id: &recipe.id,
            media: recipe.media,
            is_default: recipe.is_default,
        })
        .collect();
    let listed: Vec<Listed> = Rules::global(cx)
        .and_then(|rules| rules.call("promptEnhance.recipesFor", &(&keys, media)).ok())
        .unwrap_or_default();
    listed
        .iter()
        .filter_map(|key| recipes.iter().find(|recipe| recipe.id == key.id).cloned())
        .collect()
}

/// "Grok 4.6 · 6 s · 16:9": what the prompts are written for.
fn target_line(context: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(model) = context["targetModel"]
        .as_str()
        .filter(|model| !model.is_empty())
    {
        parts.push(model.to_string());
    }
    if context["media"] == "video"
        && let Some(duration) = context["duration"]
            .as_f64()
            .filter(|duration| *duration > 0.)
    {
        parts.push(format!("{} s", trim_number(duration)));
    }
    if let Some(ratio) = context["aspectRatio"].as_str()
        && is_ratio(ratio)
    {
        parts.push(ratio.to_string());
    }
    parts.join(" · ")
}

fn trim_number(value: f64) -> String {
    if value.fract() == 0. {
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

/// `^\d+:\d+$`.
fn is_ratio(text: &str) -> bool {
    text.split_once(':').is_some_and(|(width, height)| {
        !width.is_empty()
            && !height.is_empty()
            && width.chars().all(|c| c.is_ascii_digit())
            && height.chars().all(|c| c.is_ascii_digit())
    })
}

fn model_label(model: &EnhanceModel) -> String {
    format!(
        "{} · {}{}",
        model.label,
        if model.provider == "atlas" {
            "Atlas"
        } else {
            "subscription"
        },
        if model.vision { " · vision" } else { "" }
    )
}

// --- Rendering ------------------------------------------------------------------

impl PromptStudio {
    fn render_header(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let title = self.session(cx).map(|session| session.title.clone());
        let has_messages = !self.messages(cx).is_empty();
        let busy = self.pending.is_some();
        let view = cx.entity().downgrade();
        h_flex()
            .gap_1p5()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .child(
                gpui_kit::component::Icon::new(IconName::WandSparkles)
                    .small()
                    .text_color(theme.primary),
            )
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .child("Prompt Studio"),
            )
            .when_some(title, |row, title| {
                row.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(format!("· {title}")),
                )
            })
            .child(div().flex_1())
            .child(
                Popover::new("studio-history")
                    .anchor(gpui_kit::Anchor::TopRight)
                    .open(self.history_open)
                    .on_open_change({
                        let view = view.clone();
                        move |open, _, cx| {
                            let _ = view.update(cx, |this, cx| this.set_history_open(*open, cx));
                        }
                    })
                    .trigger(
                        Button::new("studio-history-trigger")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Clock)
                            .label("History")
                            .disabled(busy),
                    )
                    .content(move |_, _, cx| {
                        view.update(cx, |this, cx| this.render_history(cx))
                            .unwrap_or_else(|_| div().into_any_element())
                    }),
            )
            .child(
                Button::new("studio-new")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Plus)
                    .label("New")
                    .disabled(busy || !has_messages)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.show_session(None, cx);
                        this.focus_input(window, cx);
                    })),
            )
            .child(
                Button::new("studio-close")
                    .ghost()
                    .xsmall()
                    .icon(IconName::X)
                    .tooltip("Close — the session stays in History")
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(StudioEvent::Close))),
            )
            .into_any_element()
    }

    fn render_history(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let rows = self
            .history
            .as_ref()
            .and_then(|query| query.read(cx).data().cloned());
        let current = self.live_session_id(cx);
        let now = now_ms();
        let body = match rows {
            None => div()
                .py_6()
                .flex()
                .justify_center()
                .child(Spinner::new())
                .into_any_element(),
            Some(rows) if rows.is_empty() => div()
                .px_3()
                .py_6()
                .text_center()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child("No sessions yet.")
                .into_any_element(),
            Some(rows) => v_flex()
                .id("studio-history-rows")
                .max_h(rems(24.))
                .overflow_y_scroll()
                .children(
                    rows.iter()
                        .map(|row| {
                            let (open_id, delete_id) = (row.id.clone(), row.id.clone());
                            let rounds = row.rounds as u64;
                            h_flex()
                                .id(SharedString::from(format!("studio-session-{}", row.id)))
                                .gap_1()
                                .rounded(theme.radius)
                                .hover(|style| style.bg(theme.accent))
                                .when(current.as_deref() == Some(row.id.as_str()), |this| {
                                    this.bg(theme.accent.opacity(0.6))
                                })
                                .child(
                                    v_flex()
                                        .id(SharedString::from(format!("studio-open-{}", row.id)))
                                        .flex_1()
                                        .min_w_0()
                                        .px_2()
                                        .py_1p5()
                                        .cursor_pointer()
                                        .child(div().truncate().text_sm().child(row.title.clone()))
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(theme.muted_foreground)
                                                .child(format!(
                                                    "{} · {} {} · {}",
                                                    row.media,
                                                    rounds,
                                                    if rounds == 1 { "round" } else { "rounds" },
                                                    time_ago(row.updated_at, now)
                                                )),
                                        )
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.set_history_open(false, cx);
                                            this.show_session(Some(open_id.clone()), cx);
                                            this.focus_input(window, cx);
                                        })),
                                )
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "studio-delete-{}",
                                        row.id
                                    )))
                                    .ghost()
                                    .xsmall()
                                    .icon(IconName::Trash)
                                    .tooltip(format!("Delete “{}”", row.title))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.delete_session(delete_id.clone(), window, cx)
                                    })),
                                )
                        })
                        .collect::<Vec<_>>(),
                )
                .into_any_element(),
        };
        v_flex().w(px(320.)).p_1().child(body).into_any_element()
    }

    /// What the studio writes for, straight from the form.
    fn render_context(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let references = self.references(cx);
        let seeing = self.seeing(cx);
        let shown = if seeing {
            references.len().min(self.limits.max_images)
        } else {
            0
        };
        let max_images = self.limits.max_images;
        let target = self
            .form
            .context
            .as_ref()
            .map(target_line)
            .unwrap_or_default();
        let formats = self.formats(cx);
        let format = self.format(cx);
        let has_prompt = !self.form.prompt.trim().is_empty();

        let thumbnails = (!references.is_empty()).then(|| {
            h_flex()
                .gap_1p5()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(if seeing { "Sees" } else { "References" }),
                )
                .children(references.iter().enumerate().map(|(index, reference)| {
                    let number = index + 1;
                    let tooltip = if index < shown {
                        format!("@image{number} — shown to the model")
                    } else if seeing {
                        format!("@image{number} — only the first {max_images} are shown")
                    } else {
                        format!("@image{number} — the model only knows the tag")
                    };
                    div()
                        .id(SharedString::from(format!("studio-ref-{}", reference.id)))
                        .relative()
                        .size_9()
                        .overflow_hidden()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(theme.border)
                        .when(index >= shown, |this| this.opacity(0.4))
                        .tooltip(move |window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(tooltip.clone())
                                .build(window, cx)
                        })
                        .child(
                            img(ImageSource::Render(reference.preview.clone()))
                                .size_full()
                                .object_fit(ObjectFit::Cover),
                        )
                        .child(
                            div()
                                .absolute()
                                .bottom(px(2.))
                                .left(px(2.))
                                .px(px(3.))
                                .rounded(px(2.))
                                .bg(gpui_kit::black().opacity(0.7))
                                .text_color(gpui_kit::white())
                                .text_size(px(9.))
                                .line_height(px(12.))
                                .child(number.to_string()),
                        )
                }))
                .child(div().mx_0p5().h_6().w(px(1.)).bg(theme.border))
        });

        let format_label = format
            .as_ref()
            .map(|recipe| recipe.title.clone())
            .unwrap_or_else(|| "Auto".into());
        let format_id = format.map(|recipe| recipe.id);
        let view = cx.entity().downgrade();
        let format_menu = Button::new("studio-format")
            .outline()
            .xsmall()
            .label(format!("Format · {format_label}"))
            .icon(IconName::ChevronDown)
            .tooltip(if format_id.is_some() {
                "Prompts follow this Enhance recipe"
            } else {
                "Free-form prompts for the model"
            })
            .dropdown_menu(move |mut menu, _, _| {
                let auto = view.clone();
                menu = menu.item(
                    PopupMenuItem::new("Auto")
                        .checked(format_id.is_none())
                        .on_click(move |_, _, cx| {
                            let _ = auto.update(cx, |this, cx| this.pick_format("auto".into(), cx));
                        }),
                );
                for recipe in formats.iter() {
                    let (view, id) = (view.clone(), recipe.id.clone());
                    menu = menu.item(
                        PopupMenuItem::new(recipe.title.clone())
                            .checked(format_id.as_deref() == Some(recipe.id.as_str()))
                            .on_click(move |_, _, cx| {
                                let _ =
                                    view.update(cx, |this, cx| this.pick_format(id.clone(), cx));
                            }),
                    );
                }
                menu
            });

        h_flex()
            .flex_wrap()
            .gap_2()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.muted.opacity(0.2))
            .children(thumbnails)
            .when(!target.is_empty(), |row| {
                row.child(
                    h_flex()
                        .h_6()
                        .px_2()
                        .rounded_full()
                        .border_1()
                        .border_color(theme.border)
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("For ")
                        .child(div().text_color(theme.foreground).child(target)),
                )
            })
            .child(format_menu)
            .when(has_prompt, |row| {
                let on = self.include_prompt;
                row.child(
                    Switch::new("studio-include-prompt")
                        .small()
                        .checked(on)
                        .label("Include current prompt")
                        .tooltip(if on {
                            "On: the model reads the prompt in the form along with your message"
                        } else {
                            "Off: the prompt in the form is left out"
                        })
                        .on_click(cx.listener(|this, checked: &bool, _, cx| {
                            this.include_prompt = *checked;
                            cx.notify();
                        })),
                )
            })
            .into_any_element()
    }

    fn render_messages(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let session_loading = self.session_loading(cx);
        let messages: Vec<StudioMessage> = self.messages(cx).to_vec();
        let count = messages.len();
        let pending = self.pending.is_some();
        if self.scrolled_for != (count, pending) {
            self.scrolled_for = (count, pending);
            self.scroll.scroll_to_bottom();
        }
        let previews: Vec<Arc<RenderImage>> = self
            .references(cx)
            .into_iter()
            .map(|reference| reference.preview)
            .collect();
        let prompt = self.form.prompt.trim().to_string();

        let mut children: Vec<AnyElement> = Vec::new();
        if let Some(error) = self.session_error(cx) {
            children.push(
                v_flex()
                    .items_center()
                    .mx_auto()
                    .max_w(rems(28.))
                    .py_10()
                    .gap_2()
                    .text_center()
                    .child(div().text_sm().child("This conversation did not load."))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(error),
                    )
                    .child(
                        Button::new("studio-retry-session")
                            .small()
                            .outline()
                            .icon(IconName::RefreshCw)
                            .label("Try again")
                            .on_click(cx.listener(|this, _, _, cx| this.retry_session(cx))),
                    )
                    .into_any_element(),
            );
        } else if session_loading {
            children.push(
                div()
                    .py_10()
                    .flex()
                    .justify_center()
                    .child(Spinner::new())
                    .into_any_element(),
            );
        } else if messages.is_empty() && !pending {
            let count = self.variant_count();
            children.push(
                v_flex()
                    .items_center()
                    .mx_auto()
                    .max_w(rems(28.))
                    .py_10()
                    .gap_2()
                    .text_center()
                    .child(
                        gpui_kit::component::Icon::new(IconName::WandSparkles)
                            .large()
                            .text_color(theme.primary.opacity(0.8)),
                    )
                    .child(div().text_sm().child("Describe the idea in a few words — any language."))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "Type @ to point at a reference (“the woman from @image1 in the dress from @image2”). You get {} to choose from; then say what to change, or press Refine on one.",
                                if count == 1 {
                                    "a variant".to_string()
                                } else {
                                    format!("{count} variants")
                                }
                            )),
                    )
                    .into_any_element(),
            );
        }

        for (index, message) in messages.iter().enumerate() {
            match message {
                StudioMessage::User { text, reply_to, .. } => children.push(card::user_bubble(
                    SharedString::from(format!("studio-user-{index}")),
                    text,
                    reply_to.as_deref(),
                    &previews,
                    false,
                    cx,
                )),
                StudioMessage::Assistant {
                    variants,
                    model,
                    provider,
                    fell_back,
                    cost_usd,
                    duration_ms,
                    ..
                } => {
                    let mut meta = format!(
                        "{} {} · {}{} · {} s",
                        variants.len(),
                        if variants.len() == 1 {
                            "variant"
                        } else {
                            "variants"
                        },
                        model,
                        if provider == "atlas" {
                            " (Atlas)"
                        } else {
                            " · subscription"
                        },
                        ((duration_ms / 1000.).round() as u64).max(1)
                    );
                    if let Some(cost) = cost_usd {
                        meta.push_str(&format!(" · ${cost:.4}"));
                    }
                    if *fell_back {
                        meta.push_str(" · fell back from Grok");
                    }
                    let mut column = v_flex().gap_2().child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(meta),
                    );
                    for variant in variants {
                        let parent = variant
                            .parent_label
                            .as_deref()
                            .and_then(|label| find_variant(&messages, label))
                            .cloned();
                        let show_changes = parent.is_some() && !self.plain.contains(&variant.label);
                        let diff = match (&parent, show_changes) {
                            (Some(parent), true) => self.diff(variant, parent, cx),
                            _ => None,
                        };
                        column = column.child(card::variant_card(
                            card::CardState {
                                variant,
                                parent: parent.as_ref(),
                                diff,
                                show_changes,
                                expanded: self.expanded.contains(&variant.label),
                                in_prompt: !prompt.is_empty() && prompt == variant.prompt.trim(),
                                replying: self.reply_to.as_deref() == Some(variant.label.as_str()),
                                copied: self.copied.is(&variant.label),
                            },
                            cx,
                        ));
                    }
                    children.push(column.into_any_element());
                }
            }
        }

        if let Some(pending) = &self.pending {
            children.push(card::user_bubble(
                "studio-pending".into(),
                &pending.text,
                pending.reply_to.as_deref(),
                &previews,
                true,
                cx,
            ));
            children.push(
                h_flex()
                    .gap_2()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(Spinner::new().xsmall())
                    .child(format!(
                        "Writing {}… {} s",
                        if pending.count == 1 {
                            "a variant".to_string()
                        } else {
                            format!("{} variants", pending.count)
                        },
                        pending.started.elapsed().as_secs()
                    ))
                    .into_any_element(),
            );
        }

        div()
            .id("studio-messages")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(v_flex().gap_4().px_4().py_4().children(children))
            .into_any_element()
    }

    fn render_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let quoted = self
            .reply_to
            .as_deref()
            .and_then(|label| find_variant(self.messages(cx), label))
            .cloned();
        let has_messages = !self.messages(cx).is_empty();
        let placeholder: SharedString = match &quoted {
            Some(variant) => format!("What should change in variant {}?", variant.label).into(),
            None if has_messages => "Say what to change, or describe something new…".into(),
            None => EMPTY_PLACEHOLDER.into(),
        };
        if self.placeholder != placeholder {
            self.placeholder = placeholder.clone();
            self.input.update(cx, |input, cx| {
                input.set_placeholder(placeholder, window, cx)
            });
        }
        let has_references = !self.form.references.is_empty();
        let model = self.model(cx).cloned();
        let can_see = model.as_ref().is_some_and(|model| model.vision);
        let seeing = self.seeing(cx);
        let count = self.variant_count();
        let busy = self.pending.is_some();
        let can_send = !busy && !self.input.read(cx).value().trim().is_empty() && !self.loading(cx);

        let counts = self.limits.variant_counts.clone();
        let group = ButtonGroup::new("studio-variant-count")
            .outline()
            .xsmall()
            .children(counts.iter().map(|option| {
                Button::new(SharedString::from(format!("studio-count-{option}")))
                    .label(option.to_string())
                    .selected(*option == count)
            }))
            .on_click(cx.listener(move |this, clicked: &Vec<usize>, _, cx| {
                if let Some(&option) = clicked.first().and_then(|ix| counts.get(*ix)) {
                    this.update_prefs(cx, |prefs| prefs.variant_count = option)
                }
            }));

        let models = self.models.clone();
        let model_id = model.as_ref().map(|model| model.id.clone());
        let view = cx.entity().downgrade();
        let model_menu = Button::new("studio-model")
            .outline()
            .xsmall()
            .label(model.as_ref().map(model_label).unwrap_or_default())
            .icon(IconName::ChevronDown)
            .when_some(
                model.as_ref().map(|model| model.note.clone()),
                |button, note| button.tooltip(note),
            )
            .dropdown_menu(move |mut menu, _, _| {
                for option in &models {
                    let (view, id) = (view.clone(), option.id.clone());
                    menu = menu.item(
                        PopupMenuItem::new(model_label(option))
                            .checked(model_id.as_deref() == Some(option.id.as_str()))
                            .on_click(move |_, _, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.update_prefs(cx, |prefs| prefs.model_id = Some(id.clone()))
                                });
                            }),
                    );
                }
                menu
            });

        let vision = has_references.then(|| {
            let label = if can_see {
                "Show images to the model".to_string()
            } else {
                format!(
                    "{} can't see images",
                    model
                        .as_ref()
                        .map(|model| model.label.as_str())
                        .unwrap_or("This model")
                )
            };
            let tooltip = if !can_see {
                format!(
                    "{} cannot see images — pick a model marked “vision”",
                    model
                        .as_ref()
                        .map(|model| model.label.as_str())
                        .unwrap_or("This model")
                )
            } else if seeing {
                "On: the model sees the references".to_string()
            } else {
                "Off: the model only knows the tags, not what is in the images".to_string()
            };
            Switch::new("studio-vision")
                .small()
                .checked(seeing)
                .disabled(!can_see)
                .label(label)
                .tooltip(tooltip)
                .on_click(cx.listener(|this, checked: &bool, _, cx| {
                    let on = *checked;
                    this.update_prefs(cx, |prefs| prefs.vision = on)
                }))
        });

        v_flex()
            .gap_2()
            .px_4()
            .py_2()
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.muted.opacity(0.2))
            .when_some(quoted, |column, variant| {
                column.child(
                    h_flex()
                        .gap_2()
                        .pl_2()
                        .border_l_2()
                        .border_color(theme.primary.opacity(0.7))
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(gpui_kit::component::Icon::new(IconName::Reply).xsmall())
                        .child(div().flex_1().min_w_0().truncate().child(format!(
                            "Refining variant {} · {}",
                            variant.label, variant.title
                        )))
                        .child(
                            Button::new("studio-unquote")
                                .ghost()
                                .xsmall()
                                .icon(IconName::X)
                                .tooltip("Stop refining this variant")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.reply_to = None;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .child(self.mentions.clone())
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Variants"),
                    )
                    .child(group)
                    .children(vision)
                    .child(model_menu)
                    .child(div().flex_1())
                    .child(
                        Button::new("studio-send")
                            .primary()
                            .small()
                            .icon(IconName::ArrowUp)
                            .tooltip("Send (Enter)")
                            .loading(busy)
                            .disabled(!can_send)
                            .on_click(cx.listener(|this, _, window, cx| this.send(window, cx))),
                    ),
            )
            .into_any_element()
    }
}

impl Render for PromptStudio {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let header = self.render_header(cx);
        let context = self.render_context(cx);
        let messages = self.render_messages(cx);
        let composer = self.render_composer(window, cx);
        v_flex()
            .id("prompt-studio")
            .key_context(CONTEXT)
            .size_full()
            .on_action(cx.listener(|this, _: &SendStudioMessage, window, cx| this.send(window, cx)))
            .child(header)
            .child(context)
            .child(messages)
            .child(composer)
    }
}

// --- Card callbacks (card.rs draws, this owns the state) -----------------------

impl PromptStudio {
    fn toggle_expanded(&mut self, label: &str, cx: &mut Context<Self>) {
        if !self.expanded.remove(label) {
            self.expanded.insert(label.to_string());
        }
        cx.notify();
    }

    fn toggle_changes(&mut self, label: &str, cx: &mut Context<Self>) {
        if !self.plain.remove(label) {
            self.plain.insert(label.to_string());
        }
        cx.notify();
    }

    fn copy(&mut self, label: &str, cx: &mut Context<Self>) {
        let Some(prompt) =
            find_variant(self.messages(cx), label).map(|variant| variant.prompt.clone())
        else {
            return;
        };
        self.copied.copy(
            label.to_string().into(),
            prompt,
            |this: &mut Self| &mut this.copied,
            cx,
        );
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or_default()
}

/// "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago".
fn time_ago(at: f64, now: f64) -> String {
    let minutes = ((now - at) / 60_000.).round() as i64;
    if minutes < 1 {
        return "just now".into();
    }
    if minutes < 60 {
        return format!("{minutes} min ago");
    }
    let hours = (minutes as f64 / 60.).round() as i64;
    if hours < 24 {
        return format!("{hours} h ago");
    }
    let days = (hours as f64 / 24.).round() as i64;
    if days == 1 {
        "yesterday".into()
    } else {
        format!("{days} days ago")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_target_line_names_model_length_and_ratio() {
        let context = serde_json::json!({
            "media": "video", "targetModel": "Grok Imagine Video", "duration": 6,
            "aspectRatio": "16:9"
        });
        assert_eq!(target_line(&context), "Grok Imagine Video · 6 s · 16:9");
        let context = serde_json::json!({
            "media": "image", "targetModel": "Seedream 5", "duration": 6, "aspectRatio": "auto"
        });
        assert_eq!(target_line(&context), "Seedream 5");
    }

    #[test]
    fn times_read_like_the_web() {
        let now = 10_000_000_000.;
        assert_eq!(time_ago(now - 10_000., now), "just now");
        assert_eq!(time_ago(now - 5. * 60_000., now), "5 min ago");
        assert_eq!(time_ago(now - 3. * 3_600_000., now), "3 h ago");
        assert_eq!(time_ago(now - 30. * 3_600_000., now), "yesterday");
        assert_eq!(time_ago(now - 4. * 86_400_000., now), "4 days ago");
    }

    #[test]
    fn finds_the_newest_variant_with_a_label() {
        let variant = |label: &str, prompt: &str| StudioVariant {
            label: label.into(),
            title: String::new(),
            summary: String::new(),
            prompt: prompt.into(),
            changes: None,
            parent_label: None,
        };
        let answer = |variants| StudioMessage::Assistant {
            variants,
            model: "m".into(),
            provider: "grok".into(),
            fell_back: false,
            reason: None,
            cost_usd: None,
            duration_ms: 1.,
            at: 1.,
        };
        let messages = vec![
            answer(vec![variant("1", "a"), variant("2", "b")]),
            StudioMessage::User {
                text: "t".into(),
                reply_to: Some("2".into()),
                image_count: None,
                at: 2.,
            },
            answer(vec![variant("2.1", "c")]),
        ];
        assert_eq!(
            find_variant(&messages, "2").map(|v| v.prompt.as_str()),
            Some("b")
        );
        assert_eq!(
            find_variant(&messages, "2.1").map(|v| v.prompt.as_str()),
            Some("c")
        );
        assert!(find_variant(&messages, "3").is_none());
    }

    #[test]
    fn old_preferences_fill_in_defaults() {
        let prefs: StudioPrefs = serde_json::from_str(r#"{"variantCount":2}"#).unwrap();
        assert_eq!(prefs.variant_count, 2);
        assert!(prefs.vision);
        assert_eq!(prefs.formats.get("video"), None);
    }
}
