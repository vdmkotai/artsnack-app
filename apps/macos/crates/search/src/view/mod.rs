//! The Search screen (`/search` on the web): the whole history, searched on
//! the device.
//!
//! - Typing is never held up. The query applies 300 ms after the last
//!   keystroke, and the search itself runs on the background executor: a
//!   newer search makes an older one give up at its next checkpoint, and the
//!   previous results stay on screen until the new ones land.
//! - A malformed query keeps the last valid results, dimmed, with the error.
//! - The catalogue is subscribed while the screen is shown and for three
//!   minutes after it was hidden ([`SearchView::set_active`]). A shell that
//!   never says is covered too: the screen notes when it last drew, and
//!   nothing drawn for the grace period, with a frame asked for that never
//!   comes, means hidden. Hidden, the viewer closes at once: a clip in it
//!   must not play on behind another screen.
//! - The grid mounts results a page at a time (180), growing as it nears the
//!   end, and starts from the top when the search changes. Its keys and
//!   shapes are extended only when the window grows, and handed to the grid
//!   only when they or its geometry changed — never per frame.
//! - A change of filters or sort reuses the last text phase (every prompt
//!   read, the facets counted) and only filters and sorts again.
//! - The intent survives a restart (the web keeps it in the URL).

mod actions;
mod tray;

use std::{
    collections::HashMap,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use artsnack_backend::api::{favorites::ToggleArgs, search_catalog::SearchSource};
use artsnack_library::{FavoriteHearts, GridSync, MediaCommand};
use artsnack_media::Media;
use artsnack_settings::{Preference, Preferences};
use artsnack_ui::{Lightbox, LightboxEvent, LightboxItem, MediaGridState, MediaTile};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    FontWeight, InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, Render,
    SharedString, Styled as _, Subscription, Task, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Selectable as _, Sizable as _, WindowExt as _,
        alert::Alert,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState},
        menu::{DropdownMenu as _, PopupMenuItem},
        spinner::Spinner,
        switch::Switch,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    px, rems,
};

use crate::{
    catalog::SearchCatalog,
    engine::{
        ParsedSearchQuery, SearchFacets, SearchIntent, SearchOutput, SearchResult, SearchSort,
        TextMatches, count_active_search_filters, deserialize_search_intent, finish_search_until,
        match_search_text_until, parse_search_query, search_intent_error, serialize_search_intent,
        stabilize_search_results,
    },
    filters::{FilterDrawer, FilterDrawerEvent, Group},
    format::{plural, thousands},
    help,
    results::{self, caption},
    saved::{SavedSearches, SavedSearchesEvent, recent_queries, remember_query},
};

actions!(search, [ExitSelection, FocusQuery]);

const CONTEXT: &str = "Search";
const PLACEHOLDER: &str = "dog, beach, -scarf or \"red dress\"";
/// How long a query must stick before it is searched.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// How long the catalogue stays subscribed after the screen was last drawn.
const GRACE: Duration = Duration::from_secs(3 * 60);
/// How long a frame asked of a screen in view may take to arrive.
const PROBE: Duration = Duration::from_secs(1);
/// Results mounted at first, and added each time the grid nears its end.
const WINDOW_PAGE: usize = 180;
/// Recent queries offered by the empty state.
const EMPTY_STATE_QUERIES: usize = 8;

/// The current intent in its URL form; the native counterpart of the web's
/// `/search?…`, so a restart comes back to the same search.
const INTENT: Preference<String> = Preference::new("search.intent", String::new);

pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("escape", ExitSelection, Some(CONTEXT)),
        KeyBinding::new("cmd-f", FocusQuery, Some(CONTEXT)),
    ]);
}

/// The output on screen and the intent it was computed for.
struct Shown {
    output: Arc<SearchOutput>,
    intent_key: String,
}

/// What the last search was asked for, so an unchanged one is not repeated.
#[derive(PartialEq, Eq)]
struct Searched {
    revision: u64,
    intent_key: String,
}

/// What a text phase depends on: the catalogue and the queries, not the
/// filters or the sort.
#[derive(Clone, PartialEq, Eq)]
struct TextKey {
    revision: u64,
    query: String,
    negative_prompt_query: String,
    allow_typos: bool,
}

impl TextKey {
    fn of(revision: u64, intent: &SearchIntent) -> Self {
        Self {
            revision,
            query: intent.query.clone(),
            negative_prompt_query: intent.negative_prompt_query.clone(),
            allow_typos: intent.allow_typos,
        }
    }
}

/// The grid's keys and shapes for the mounted results, extended as the
/// window grows and rebuilt only for a new result list, with an index by key.
#[derive(Default)]
struct GridItems {
    results: Option<Arc<Vec<SearchResult>>>,
    /// Shared with the grid's tile builder; copied only if it changes while
    /// the last frame still holds it.
    keys: Rc<Vec<SharedString>>,
    aspects: Vec<f32>,
    index: HashMap<SharedString, usize>,
    /// Bumped whenever the keys change.
    revision: u64,
}

impl GridItems {
    /// Mounts the first `len` of `results`. Nothing is touched when they are
    /// the ones already mounted.
    fn sync(&mut self, results: &Arc<Vec<SearchResult>>, len: usize) {
        let len = len.min(results.len());
        let same_list = self
            .results
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, results));
        if same_list && self.keys.len() == len {
            return;
        }
        if !same_list || self.keys.len() > len {
            self.results = Some(results.clone());
            self.keys = Rc::default();
            self.aspects.clear();
            self.index.clear();
        }
        let keys = Rc::make_mut(&mut self.keys);
        for (ix, result) in results.iter().enumerate().take(len).skip(keys.len()) {
            let key = results::key(result);
            self.index.insert(key.clone(), ix);
            keys.push(key);
            self.aspects.push(results::aspect(result));
        }
        self.revision += 1;
    }

    fn position(&self, key: &str) -> Option<usize> {
        self.index.get(key).copied()
    }
}

/// Emits [`MediaCommand`]s for the shell to route: Reproduce, and one
/// `UseAsReference` per image sent to the API tab.
pub struct SearchView {
    focus_handle: FocusHandle,
    catalog: Entity<SearchCatalog>,
    hearts: Entity<FavoriteHearts>,
    input: Entity<InputState>,
    /// What the user asked for, possibly with a syntax error.
    intent: SearchIntent,
    /// The last intent that parsed: the one searched.
    valid_intent: SearchIntent,
    syntax_error: Option<&'static str>,
    /// The valid intent's query, parsed, for the echo under the input.
    parsed: ParsedSearchQuery,
    debounce: Option<Task<()>>,
    shown: Option<Shown>,
    searched: Option<Searched>,
    /// The newest search asked for; an older one still running gives up.
    search_generation: Arc<AtomicU64>,
    search: Option<Task<()>>,
    /// The last text phase, for a search that changes only filters or sort.
    text: Option<(TextKey, Arc<TextMatches>)>,
    grid: MediaGridState,
    grid_sync: GridSync,
    /// How many results the grid mounts.
    window_len: usize,
    grid_items: GridItems,
    scroll_to_top: bool,
    /// "Select references" mode: a click on an image selects it.
    selecting: bool,
    /// The reference tray, in order.
    references: Vec<SearchResult>,
    deleting: bool,
    lightbox: Option<(Entity<Lightbox>, Subscription)>,
    filters: Option<(Entity<FilterDrawer>, Subscription)>,
    saved: Option<(Entity<SavedSearches>, Subscription)>,
    /// What the shell last said: shown or hidden. `None` until it says.
    active: Option<bool>,
    last_drawn: Instant,
    _grace: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<MediaCommand> for SearchView {}

impl SearchView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let intent = deserialize_search_intent(&Preferences::get(cx, &INTENT));
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(PLACEHOLDER)
                .default_value(intent.query.clone())
        });
        let catalog = cx.new(|_| SearchCatalog::new());
        let hearts = cx.new(FavoriteHearts::new);
        let subscriptions = vec![
            cx.observe(&catalog, |this, _, cx| this.catalog_changed(cx)),
            cx.observe(&hearts, |_, _, cx| cx.notify()),
            cx.subscribe(&input, |this, _, event, cx| match event {
                InputEvent::Change => this.query_changed(cx),
                InputEvent::PressEnter { .. } => this.commit_query(cx),
                _ => {}
            }),
        ];

        let grid = MediaGridState::new();
        let view = cx.entity().downgrade();
        grid.on_near_end(move |cx| {
            let _ = view.update(cx, |this, cx| this.grow_window(cx));
        });

        let syntax_error = search_intent_error(&intent);
        let valid_intent = if syntax_error.is_none() {
            intent.clone()
        } else {
            SearchIntent::default()
        };
        let parsed = parse_search_query(&valid_intent.query).unwrap_or_default();
        let mut this = Self {
            focus_handle: cx.focus_handle(),
            catalog,
            hearts,
            input,
            intent,
            valid_intent,
            syntax_error,
            parsed,
            debounce: None,
            shown: None,
            searched: None,
            search_generation: Arc::new(AtomicU64::new(0)),
            search: None,
            text: None,
            grid,
            grid_sync: GridSync::default(),
            window_len: WINDOW_PAGE,
            grid_items: GridItems::default(),
            scroll_to_top: false,
            selecting: false,
            references: Vec::new(),
            deleting: false,
            lightbox: None,
            filters: None,
            saved: None,
            active: None,
            last_drawn: Instant::now(),
            _grace: None,
            _subscriptions: subscriptions,
        };
        this.warm(cx);
        this
    }

    // --- Read by the drawer ---------------------------------------------------

    /// The facets of the results on screen.
    pub(crate) fn facets(&self) -> Arc<SearchFacets> {
        self.shown
            .as_ref()
            .map(|shown| shown.output.facets.clone())
            .unwrap_or_default()
    }

    fn results(&self) -> Option<&Arc<Vec<SearchResult>>> {
        self.shown.as_ref().map(|shown| &shown.output.results)
    }

    // --- The catalogue's lifetime ----------------------------------------------

    fn warm(&mut self, cx: &mut Context<Self>) {
        self.last_drawn = Instant::now();
        self.catalog.update(cx, |catalog, cx| catalog.warm(cx));
        self.watch_grace(cx);
    }

    /// Whether the screen is shown (the shell says so). Hidden, the viewer
    /// closes at once and the catalogue is released after the grace period;
    /// the results, the intent and the scroll position stay.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active == Some(active) {
            return;
        }
        self.active = Some(active);
        self.hearts
            .update(cx, |hearts, cx| hearts.set_active(active, cx));
        if active {
            self.warm(cx);
        } else {
            self.lightbox = None;
            // The grace period runs from now.
            self.last_drawn = Instant::now();
            self.watch_grace(cx);
        }
        cx.notify();
    }

    /// Releases the catalogue once the screen has been hidden, or nothing has
    /// drawn it, for the grace period. Without word from the shell, a screen
    /// in view that nothing changes draws nothing either, so before releasing,
    /// ask for a frame and see whether one comes.
    fn watch_grace(&mut self, cx: &mut Context<Self>) {
        self._grace = Some(cx.spawn(async move |this, cx| {
            loop {
                let Ok((idle, hidden)) = this.read_with(cx, |this, _| {
                    (this.last_drawn.elapsed(), this.active == Some(false))
                }) else {
                    return;
                };
                if idle < GRACE {
                    cx.background_executor().timer(GRACE - idle).await;
                    continue;
                }
                if hidden {
                    let _ = this.update(cx, |this, cx| {
                        this.catalog.update(cx, |catalog, cx| catalog.cool(cx));
                    });
                    return;
                }
                let asked = Instant::now();
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    return;
                }
                cx.background_executor().timer(PROBE).await;
                let Ok(drawn) = this.read_with(cx, |this, _| this.last_drawn >= asked) else {
                    return;
                };
                if !drawn {
                    let _ = this.update(cx, |this, cx| {
                        this.catalog.update(cx, |catalog, cx| catalog.cool(cx));
                    });
                    return;
                }
            }
        }));
    }

    fn catalog_changed(&mut self, cx: &mut Context<Self>) {
        self.schedule_search(cx);
        cx.notify();
    }

    // --- Searching ----------------------------------------------------------------

    /// Searches the catalogue for the valid intent on the background executor,
    /// unless that exact search already ran. When only the filters or the sort
    /// changed, the last text phase is reused.
    fn schedule_search(&mut self, cx: &mut Context<Self>) {
        let catalog = self.catalog.read(cx);
        let documents = catalog.documents().clone();
        let searched = Searched {
            revision: catalog.revision(),
            intent_key: serialize_search_intent(&self.valid_intent),
        };
        if self.searched.as_ref() == Some(&searched) {
            return;
        }
        let text_key = TextKey::of(searched.revision, &self.valid_intent);
        let intent_key = searched.intent_key.clone();
        self.searched = Some(searched);

        let intent = self.valid_intent.clone();
        let generation = self.search_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let latest = self.search_generation.clone();
        let previous = self.results().cloned();
        let reuse = self
            .text
            .as_ref()
            .filter(|(key, _)| *key == text_key)
            .map(|(_, text)| text.clone());
        let job = cx.background_spawn(async move {
            let cancelled = || latest.load(Ordering::Relaxed) != generation;
            let text = match reuse {
                Some(text) => text,
                None => Arc::new(match_search_text_until(&documents, &intent, cancelled)?.ok()?),
            };
            let mut output = finish_search_until(&text, &intent, cancelled)?;
            if let Some(previous) = previous {
                output.results = stabilize_search_results(&previous, output.results);
            }
            Some((text, output))
        });
        self.search = Some(cx.spawn(async move |this, cx| {
            if let Some((text, output)) = job.await {
                let _ = this.update(cx, |this, cx| {
                    this.text = Some((text_key, text));
                    this.show_output(output, intent_key, cx)
                });
            }
        }));
    }

    fn show_output(&mut self, output: SearchOutput, intent_key: String, cx: &mut Context<Self>) {
        let new_search = self
            .shown
            .as_ref()
            .is_none_or(|shown| shown.intent_key != intent_key);
        if new_search {
            // A new search starts again from the top, with the first page.
            self.window_len = WINDOW_PAGE;
            self.scroll_to_top = true;
        }
        self.shown = Some(Shown {
            output: Arc::new(output),
            intent_key,
        });
        self.sync_lightbox(cx);
        cx.notify();
    }

    fn grow_window(&mut self, cx: &mut Context<Self>) {
        let total = self.results().map(|results| results.len()).unwrap_or(0);
        if self.window_len < total {
            self.window_len += WINDOW_PAGE;
            self.sync_lightbox(cx);
            cx.notify();
        }
    }

    // --- The intent -------------------------------------------------------------

    fn query_changed(&mut self, cx: &mut Context<Self>) {
        self.debounce = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DEBOUNCE).await;
            let _ = this.update(cx, |this, cx| this.commit_query(cx));
        }));
    }

    /// The typed query becomes the intent's (after the debounce, or on Enter),
    /// and a query that sticks joins the device's history.
    fn commit_query(&mut self, cx: &mut Context<Self>) {
        self.debounce = None;
        let query = self.input.read(cx).value().to_string();
        if query == self.intent.query {
            return;
        }
        remember_query(&query, cx);
        self.set_intent(
            SearchIntent {
                query,
                ..self.intent.clone()
            },
            cx,
        );
    }

    fn set_intent(&mut self, intent: SearchIntent, cx: &mut Context<Self>) {
        if intent == self.intent {
            return;
        }
        self.intent = intent;
        self.syntax_error = search_intent_error(&self.intent);
        if self.syntax_error.is_none() {
            self.valid_intent = self.intent.clone();
            self.parsed = parse_search_query(&self.valid_intent.query).unwrap_or_default();
            self.schedule_search(cx);
        }
        Preferences::set(cx, &INTENT, serialize_search_intent(&self.intent));
        cx.notify();
    }

    /// A whole new intent at once — a saved search, a recent query — with
    /// the input following it.
    fn replace_intent(
        &mut self,
        intent: SearchIntent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.debounce = None;
        if self.input.read(cx).value().as_ref() != intent.query {
            let query = intent.query.clone();
            self.input
                .update(cx, |input, cx| input.set_value(query, window, cx));
        }
        remember_query(&intent.query, cx);
        self.set_intent(intent, cx);
    }

    fn run_query(&mut self, query: String, window: &mut Window, cx: &mut Context<Self>) {
        let intent = SearchIntent {
            query,
            ..self.intent.clone()
        };
        self.replace_intent(intent, window, cx);
    }

    fn update_intent(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut SearchIntent)) {
        let mut intent = self.intent.clone();
        change(&mut intent);
        self.set_intent(intent, cx);
    }

    // --- Overlays ---------------------------------------------------------------

    fn open_filters(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().downgrade();
        let catalog = self.catalog.clone();
        let intent = self.intent.clone();
        let facets = self.facets();
        let drawer = cx.new(|cx| FilterDrawer::new(view, catalog, &intent, &facets, window, cx));
        let subscription = cx.subscribe_in(&drawer, window, |this, _, event, window, cx| {
            let FilterDrawerEvent::Apply {
                filters,
                negative_prompt_query,
            } = event;
            this.update_intent(cx, |intent| {
                intent.filters = filters.clone();
                intent.negative_prompt_query = negative_prompt_query.clone();
            });
            this.filters = None;
            window.close_sheet(cx);
        });
        self.filters = Some((drawer.clone(), subscription));

        let view = cx.entity().downgrade();
        window.open_sheet(cx, move |sheet, window, cx| {
            // `min(34rem, window − 1rem)`, as the web's drawer.
            let rem = window.rem_size();
            let width = (rem * 34.).min(window.viewport_size().width - rem);
            let clear = drawer.clone();
            let apply = drawer.clone();
            let close_view = view.clone();
            sheet
                .title("Search filters")
                .size(width)
                .child(drawer.clone())
                .on_close(move |_, _, cx| {
                    let _ = close_view.update(cx, |this, cx| {
                        this.filters = None;
                        cx.notify();
                    });
                })
                .footer(
                    h_flex()
                        .w_full()
                        .justify_between()
                        .child(
                            Button::new("clear-filters")
                                .ghost()
                                .label("Clear all")
                                .on_click(move |_, window, cx| {
                                    clear.update(cx, |drawer, cx| drawer.clear_all(window, cx))
                                }),
                        )
                        .child(
                            Button::new("show-results")
                                .primary()
                                .label(drawer.read(cx).show_label())
                                .on_click(move |_, _, cx| {
                                    apply.update(cx, |drawer, cx| drawer.apply(cx))
                                }),
                        ),
                )
        });
    }

    fn open_help(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.open_dialog(cx, |dialog, window, cx| {
            dialog
                .title("Search syntax")
                .w(window.rem_size() * 36.)
                .child(help::content(cx))
        });
    }

    fn open_saved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let intent = self.intent.clone();
        let saved = cx.new(|cx| SavedSearches::new(intent, window, cx));
        let subscription = cx.subscribe_in(&saved, window, |this, _, event, window, cx| {
            let SavedSearchesEvent::Load(intent) = event;
            this.replace_intent(intent.clone(), window, cx);
            this.saved = None;
            window.close_dialog(cx);
        });
        self.saved = Some((saved.clone(), subscription));

        let view = cx.entity().downgrade();
        let focused = std::cell::Cell::new(false);
        window.open_dialog(cx, move |dialog, window, cx| {
            if !focused.replace(true) {
                saved
                    .read(cx)
                    .name_input()
                    .read(cx)
                    .focus_handle(cx)
                    .focus(window, cx);
            }
            let view = view.clone();
            dialog
                .title("Saved searches")
                .w(window.rem_size() * 32.)
                .child(saved.clone())
                .on_close(move |_, _, cx| {
                    let _ = view.update(cx, |this, _| this.saved = None);
                })
        });
    }

    fn open_lightbox(&mut self, key: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let (items, can_load_more) = self.lightbox_items(cx);
        let actions_view = cx.entity().downgrade();
        let details_view = actions_view.clone();
        let lightbox = Lightbox::new(
            items,
            key,
            can_load_more,
            move |item, _, cx| {
                actions_view
                    .upgrade()
                    .map(|view| view.update(cx, |this, cx| this.lightbox_actions(&item.key, cx)))
                    .unwrap_or_default()
            },
            move |item, _, cx| {
                let view = details_view.upgrade()?;
                let result = view.read(cx).result(&item.key)?;
                Some(results::details(&result, cx))
            },
            cx,
        );
        let subscription =
            cx.subscribe_in(
                &lightbox,
                window,
                |this, _, event, window, cx| match event {
                    LightboxEvent::Closed => {
                        this.lightbox = None;
                        this.focus_handle.focus(window, cx);
                        cx.notify();
                    }
                    LightboxEvent::LoadMore => this.grow_window(cx),
                },
            );
        lightbox.read(cx).focus_handle(cx).focus(window, cx);
        self.lightbox = Some((lightbox, subscription));
        cx.notify();
    }

    /// The viewer pages through the mounted results, and asks for the next
    /// page as it nears their end.
    fn lightbox_items(&mut self, cx: &App) -> (Vec<LightboxItem>, bool) {
        let Some(results) = self.results().cloned() else {
            return (Vec::new(), false);
        };
        self.grid_items.sync(&results, self.window_len);
        let urls = Media::urls(cx);
        let len = self.grid_items.keys.len();
        let items = results[..len]
            .iter()
            .map(|result| results::lightbox_item(result, urls))
            .collect();
        (items, len < results.len())
    }

    fn sync_lightbox(&mut self, cx: &mut Context<Self>) {
        if let Some(lightbox) = self.lightbox.as_ref().map(|(lightbox, _)| lightbox.clone()) {
            let (items, can_load_more) = self.lightbox_items(cx);
            lightbox.update(cx, |lightbox, cx| {
                lightbox.set_items(items, can_load_more, cx)
            });
        }
    }

    /// A mounted result by its key.
    fn result(&self, key: &str) -> Option<SearchResult> {
        let ix = self.grid_items.position(key)?;
        self.results()?.get(ix).cloned()
    }

    // --- Selection ----------------------------------------------------------------

    fn is_reference(&self, result: &SearchResult) -> bool {
        self.references.iter().any(|entry| entry.has_id(result))
    }

    fn toggle_selecting(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.selecting = !self.selecting;
        if self.selecting {
            // Escape leaves the mode from here.
            self.focus_handle.focus(window, cx);
        }
        cx.notify();
    }

    fn click_result(&mut self, key: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let Some(result) = self.result(&key) else {
            return;
        };
        if self.selecting && results::is_image(&result) {
            self.toggle_reference(&result, cx);
        } else {
            self.open_lightbox(key, window, cx);
        }
    }

    fn on_exit_selection(&mut self, _: &ExitSelection, _: &mut Window, cx: &mut Context<Self>) {
        if self.lightbox.is_none() && self.selecting {
            self.selecting = false;
            cx.notify();
        } else {
            cx.propagate();
        }
    }

    fn on_focus_query(&mut self, _: &FocusQuery, window: &mut Window, cx: &mut Context<Self>) {
        self.input.read(cx).focus_handle(cx).focus(window, cx);
    }

    // --- Rendering ------------------------------------------------------------------

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let active = count_active_search_filters(&self.intent.filters)
            + usize::from(!self.intent.negative_prompt_query.is_empty());
        let filters_label = if active > 0 {
            format!("Filters ({active})\u{2026}")
        } else {
            "Filters\u{2026}".to_string()
        };
        let input = Input::new(&self.input)
            .prefix(
                Icon::new(IconName::Search)
                    .small()
                    .text_color(theme.muted_foreground),
            )
            .cleanable(true)
            .aria_label("Search generation prompts")
            .when(self.syntax_error.is_some(), |input| {
                input.border_color(theme.danger)
            });

        v_flex()
            .px_4()
            .pt_4()
            .pb_3()
            .gap_2()
            .border_b_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(input))
                    .child(
                        Button::new("filters")
                            .outline()
                            .icon(IconName::SlidersHorizontal)
                            .label(filters_label)
                            .selected(self.filters.is_some())
                            .on_click(
                                cx.listener(|this, _, window, cx| this.open_filters(window, cx)),
                            ),
                    )
                    .child(
                        Button::new("syntax-help")
                            .outline()
                            .icon(IconName::CircleQuestionMark)
                            .tooltip("Search syntax\u{2026}")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.open_help(window, cx)),
                            ),
                    ),
            )
            .child(self.render_status(cx))
            .children(self.render_chips(cx))
    }

    /// The parsed-query echo or the syntax error, then typos, sort and Saved.
    fn render_status(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let echo: AnyElement = match self.syntax_error {
            Some(error) => div()
                .text_color(theme.danger)
                .child(error)
                .into_any_element(),
            None => {
                let part = |title: &'static str, terms: &[String]| {
                    h_flex()
                        .gap_1()
                        .min_w_0()
                        .child(
                            div()
                                .flex_shrink_0()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.foreground)
                                .child(title),
                        )
                        .child(div().truncate().child(terms.join(" \u{b7} ")))
                };
                h_flex()
                    .gap_3()
                    .min_w_0()
                    .when(self.parsed.required.is_empty(), |this| {
                        this.child("Showing newest media. Add prompt words to narrow it.")
                    })
                    .when(!self.parsed.required.is_empty(), |this| {
                        this.child(part("Required:", &self.parsed.required))
                    })
                    .when(!self.parsed.excluded.is_empty(), |this| {
                        this.child(part("Excluded:", &self.parsed.excluded))
                    })
                    .into_any_element()
            }
        };

        let view = cx.entity().downgrade();
        let sort = self.intent.sort;
        h_flex()
            .gap_3()
            .text_xs()
            .text_color(theme.muted_foreground)
            .child(div().flex_1().min_w_0().child(echo))
            .child(
                Switch::new("allow-typos")
                    .small()
                    .label("Allow typos")
                    .checked(self.intent.allow_typos)
                    .on_change(cx.listener(|this, checked: &bool, _, cx| {
                        let checked = *checked;
                        this.update_intent(cx, |intent| intent.allow_typos = checked);
                    })),
            )
            .child(
                Button::new("sort")
                    .ghost()
                    .xsmall()
                    .label(format!("Sort: {}", sort.label()))
                    .dropdown_caret(true)
                    .dropdown_menu(move |mut menu, _, _| {
                        for option in SearchSort::ALL {
                            let view = view.clone();
                            menu = menu.item(
                                PopupMenuItem::new(option.label())
                                    .checked(option == sort)
                                    .on_click(move |_, _, cx| {
                                        let _ = view.update(cx, |this, cx| {
                                            this.update_intent(cx, |intent| intent.sort = option)
                                        });
                                    }),
                            );
                        }
                        menu
                    }),
            )
            .child(
                Button::new("saved-searches")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Bookmark)
                    .label("Saved\u{2026}")
                    .on_click(cx.listener(|this, _, window, cx| this.open_saved(window, cx))),
            )
    }

    /// One chip per selected filter value, and the negative query; a click
    /// removes it.
    fn render_chips(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        const LABELS: [(Group, &str); 12] = [
            (Group::MediaTypes, "Media"),
            (Group::Sources, "Source"),
            (Group::Providers, "Provider"),
            (Group::Models, "Model"),
            (Group::ModelFamilies, "Family"),
            (Group::Checkpoints, "Checkpoint"),
            (Group::Loras, "LoRA"),
            (Group::Orientations, "Orientation"),
            (Group::Resolutions, "Resolution"),
            (Group::Qualities, "Quality"),
            (Group::Samplers, "Sampler"),
            (Group::Schedulers, "Scheduler"),
        ];
        let mut chips: Vec<Button> = Vec::new();
        let parameters = self
            .intent
            .filters
            .parameters
            .keys()
            .map(|name| {
                let group = Group::Parameter(name.clone());
                let title = group.title();
                (group, title)
            })
            .collect::<Vec<_>>();
        let groups = LABELS
            .iter()
            .map(|(group, label)| (group.clone(), label.to_string()))
            .chain(parameters);
        for (group, label) in groups {
            for value in group.selected(&self.intent.filters) {
                let id = format!("chip-{}-{value}", group.id());
                let remove = group.clone();
                chips.push(
                    Button::new(SharedString::from(id))
                        .outline()
                        .xsmall()
                        .icon(IconName::X)
                        .label(format!("{label}: {value}"))
                        .tooltip("Remove filter")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let remove = remove.clone();
                            let value = value.clone();
                            this.update_intent(cx, |intent| {
                                remove.toggle(&mut intent.filters, &value)
                            });
                        })),
                );
            }
        }
        if !self.intent.negative_prompt_query.is_empty() {
            chips.push(
                Button::new("chip-negative")
                    .outline()
                    .xsmall()
                    .icon(IconName::X)
                    .label(format!(
                        "Negative prompt: {}",
                        self.intent.negative_prompt_query
                    ))
                    .tooltip("Remove filter")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.update_intent(cx, |intent| intent.negative_prompt_query.clear())
                    })),
            );
        }
        (!chips.is_empty()).then(|| h_flex().flex_wrap().gap_1p5().children(chips))
    }

    fn render_results_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let catalog = self.catalog.read(cx);
        let (media, generations) = self
            .shown
            .as_ref()
            .map(|shown| (shown.output.results.len(), shown.output.documents.len()))
            .unwrap_or_default();
        let status = if catalog.is_refreshing() {
            " \u{b7} refreshing\u{2026}".to_string()
        } else if catalog.is_loading() {
            format!(
                " \u{b7} indexing {}\u{2026}",
                thousands(catalog.documents().len())
            )
        } else {
            String::new()
        };
        let title = if self.intent.query.trim().is_empty() {
            "Recent generations"
        } else {
            "Search results"
        };
        h_flex()
            .px_4()
            .pt_3()
            .gap_3()
            .justify_between()
            .child(
                v_flex()
                    .min_w_0()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "{} media from {}{status}",
                                thousands(media),
                                plural(generations, "generation", "generations")
                            )),
                    ),
            )
            .child(
                Button::new("select-references")
                    .small()
                    .outline()
                    .icon(IconName::ImagePlus)
                    .label(if self.selecting {
                        "Done selecting"
                    } else {
                        "Select references"
                    })
                    .selected(self.selecting)
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_selecting(window, cx))),
            )
    }

    fn render_error(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let catalog = self.catalog.read(cx);
        let error = catalog.error()?.clone();
        let message = if catalog.documents().is_empty() {
            "Your history could not be loaded."
        } else {
            "Your history could not be fully loaded; results may be incomplete."
        };
        Some(
            h_flex()
                .px_4()
                .gap_2()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(Alert::error("catalog-error", format!("{message} {error}")).small()),
                )
                .child(
                    Button::new("retry-catalog")
                        .small()
                        .outline()
                        .label("Retry")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.catalog.update(cx, |catalog, cx| catalog.retry(cx));
                        })),
                ),
        )
    }

    fn render_body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let results = self.results().cloned().unwrap_or_default();
        if !results.is_empty() {
            return self.render_grid(results, window, cx);
        }
        let catalog = self.catalog.read(cx);
        let searching = self.shown.is_none() && !catalog.documents().is_empty();
        if catalog.is_loading() || searching {
            return h_flex()
                .flex_1()
                .justify_center()
                .gap_2()
                .text_color(cx.theme().muted_foreground)
                .child(Spinner::new())
                .child("Building your search catalogue\u{2026}")
                .into_any_element();
        }
        if catalog.error().is_some() && catalog.documents().is_empty() {
            return div().flex_1().into_any_element();
        }
        self.render_empty(cx).into_any_element()
    }

    fn render_empty(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let typed = !self.input.read(cx).value().is_empty();
        let (title, body) = if typed {
            (
                "Nothing matched",
                "Remove a filter, try a broader word, or allow one-letter typos.",
            )
        } else {
            (
                "No generations yet",
                "Your generated images and videos will appear here.",
            )
        };
        let recent: Vec<String> = recent_queries(cx)
            .into_iter()
            .take(EMPTY_STATE_QUERIES)
            .collect();
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_1()
            .px_4()
            .child(
                div().mb_3().p_4().rounded_full().bg(theme.muted).child(
                    Icon::new(IconName::SlidersHorizontal)
                        .large()
                        .text_color(theme.muted_foreground),
                ),
            )
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(body),
            )
            .when(!recent.is_empty(), |this| {
                this.child(
                    h_flex()
                        .mt_4()
                        .max_w(rems(36.))
                        .flex_wrap()
                        .justify_center()
                        .gap_2()
                        .children(recent.into_iter().map(|query| {
                            Button::new(SharedString::from(format!("empty-recent-{query}")))
                                .outline()
                                .small()
                                .label(query.clone())
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.run_query(query.clone(), window, cx)
                                }))
                        })),
                )
            })
    }

    fn render_grid(
        &mut self,
        results: Arc<Vec<SearchResult>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.grid_items.sync(&results, self.window_len);
        let items = &self.grid_items;
        self.grid_sync
            .sync(&mut self.grid, items.revision, 1.0, window, || {
                (items.keys.to_vec(), items.aspects.clone())
            });
        let keys = self.grid_items.keys.clone();
        if std::mem::take(&mut self.scroll_to_top) {
            self.grid.reveal_item(0);
        }

        let urls = Media::urls(cx).clone();
        let view = cx.entity();
        let hearts = self.hearts.clone();
        let dimmed = self.syntax_error.is_some();
        let tray_open = !self.references.is_empty();

        div()
            .flex_1()
            .min_h_0()
            .px_4()
            .pt_3()
            .pb_4()
            // The previous results, kept while the query is malformed.
            .when(dimmed, |this| this.opacity(0.55))
            // Room for the reference tray over the last row.
            .when(tray_open, |this| this.pb(rems(6.)))
            .child(self.grid.render(view.entity_id(), move |ix, size, _, cx| {
                let (Some(result), Some(key)) = (results.get(ix), keys.get(ix)) else {
                    return div().into_any_element();
                };
                let this = view.read(cx);
                let selecting = this.selecting;
                let selected = this.is_reference(result);
                // A selecting tile shows its check mark instead of actions.
                let actions = if selecting {
                    Vec::new()
                } else {
                    this.tile_actions(result, &view.downgrade())
                };
                let click_view = view.downgrade();
                let click_key = key.clone();

                let mut tile = MediaTile::new(key.clone(), results::preview(result, &urls), size)
                    .original(results::original(result, &urls))
                    .media(results::media(result))
                    .on_click(move |_, window, cx| {
                        let key = click_key.clone();
                        let _ =
                            click_view.update(cx, |this, cx| this.click_result(key, window, cx));
                    });
                // Offered once favourites are known: the server toggles.
                let favorited = results::has_heart(result)
                    .then(|| hearts.read(cx).favorited(&result.asset().key))
                    .flatten();
                if let Some(favorited) = favorited {
                    let args = toggle_args(result);
                    let hearts = hearts.clone();
                    tile = tile.favorite(favorited, move |window, cx| {
                        hearts.update(cx, |hearts, cx| hearts.toggle(args.clone(), window, cx));
                    });
                }
                if selecting && results::is_image(result) {
                    tile = tile.selection(selected);
                }
                for action in actions {
                    tile = tile.action(action);
                }

                let group: SharedString = format!("search-tile-{key}").into();
                div()
                    .relative()
                    .size_full()
                    .group(group.clone())
                    .when(selecting && !selected, |this| this.opacity(0.55))
                    .child(tile)
                    .child(
                        // Inside the tile's hairline border, and only on hover.
                        div()
                            .absolute()
                            .left(px(1.))
                            .right(px(1.))
                            .bottom(px(1.))
                            .overflow_hidden()
                            .rounded_b(cx.theme().radius)
                            .invisible()
                            .group_hover(group, |style| style.visible())
                            .child(caption(result, cx)),
                    )
                    .into_any_element()
            }))
            .into_any_element()
    }
}

/// The heart's arguments: a self-hosted image by its generation, anything
/// else by its API generation.
fn toggle_args(result: &SearchResult) -> ToggleArgs {
    let id = Some(result.document.id.clone());
    let b2_key = result.asset().key.clone();
    match result.document.source {
        SearchSource::SelfHosted => ToggleArgs {
            generation_id: id,
            b2_key,
            ..ToggleArgs::default()
        },
        SearchSource::Api => ToggleArgs {
            api_generation_id: id,
            b2_key,
            ..ToggleArgs::default()
        },
    }
}

impl Focusable for SearchView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SearchView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Drawn: the screen is in use. Coming back after the grace period
        // subscribes again; the snapshot shows meanwhile.
        self.last_drawn = Instant::now();
        if !self.catalog.read(cx).is_warm() {
            cx.defer_in(window, |this, _, cx| this.warm(cx));
        }

        let body = self.render_body(window, cx);
        let tray = self.render_tray(cx);
        let lightbox = self.lightbox.as_ref().map(|(lightbox, _)| lightbox.clone());
        v_flex()
            .id("search")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::on_exit_selection))
            .on_action(cx.listener(Self::on_focus_query))
            .relative()
            .size_full()
            .child(self.render_header(cx))
            .child(self.render_results_header(cx))
            .children(self.render_error(cx).map(|error| div().pt_3().child(error)))
            .child(body)
            .children(tray)
            .children(lightbox)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use artsnack_backend::api::{
        favorites::MediaType,
        search_catalog::{SearchAsset, SearchDocument, SearchSource},
    };

    use super::GridItems;
    use crate::engine::SearchResult;

    fn results(count: usize) -> Arc<Vec<SearchResult>> {
        let document = Arc::new(SearchDocument {
            id: "g".into(),
            source: SearchSource::SelfHosted,
            provider: "self-hosted".into(),
            media_type: MediaType::Image,
            created_at: 1.0,
            prompt: String::new(),
            negative_prompt: None,
            assets: (0..count)
                .map(|ix| SearchAsset {
                    id: ix.to_string(),
                    key: format!("{ix}.png"),
                    thumbnail_key: None,
                })
                .collect(),
            model: None,
            model_label: None,
            model_family: None,
            checkpoints: Vec::new(),
            loras: Vec::new(),
            width: None,
            height: None,
            aspect_ratio: None,
            resolution: None,
            quality: None,
            duration: None,
            has_references: false,
            sampler: None,
            scheduler: None,
            steps: None,
            cfg: None,
            seed: None,
            parameters: None,
            local_settings: None,
        });
        Arc::new(
            (0..count)
                .map(|asset_ix| SearchResult {
                    document: document.clone(),
                    asset_ix,
                    score: 0,
                    reasons: Arc::from(Vec::new()),
                })
                .collect(),
        )
    }

    #[test]
    fn grid_items_grow_in_place_and_change_only_when_asked() {
        let list = results(5);
        let mut items = GridItems::default();
        items.sync(&list, 2);
        let first = items.revision;
        assert_eq!(items.keys.len(), 2);
        // The same list and window: nothing to do, the revision stays.
        items.sync(&list, 2);
        assert_eq!(items.revision, first);
        // A larger window extends what is mounted.
        items.sync(&list, 4);
        assert_eq!(items.keys.len(), 4);
        assert_eq!(items.position("g:3"), Some(3));
        assert!(items.revision > first);
        // A new list starts over.
        items.sync(&results(1), 4);
        assert_eq!(items.keys.len(), 1);
        assert_eq!(items.position("g:3"), None);
    }
}
