//! The account's saved prompts, Enhance recipes and recipe settings, read once
//! for every view that shows them: the Prompts screen and the Save/Saved and
//! Enhance buttons beside each composer's prompt field.
//!
//! - One subscription per query for the whole app, alive while any view holds
//!   the store. The shell drops every screen on sign-out, so the next account
//!   starts from a fresh store.
//! - A failed query keeps its last good rows beside the error, and
//!   [`PromptStore::retry`] subscribes again.
//! - Rows that are only a remembered snapshot, or the last good rows after a
//!   failure, are for display ([`Rows::fresh`] is false): editors are created
//!   from a live answer only, so a save never sends text the server has since
//!   replaced.
//! - The built-in recipes are copied in when the settings say they are
//!   missing. A failed copy is kept as an error with Retry, and tried again the
//!   next time a view asks ([`PromptStore::ensure_seeded`]).
//! - A deleted prompt or recipe leaves every list the moment it is deleted
//!   ([`PromptStore::remove_prompt`], [`PromptStore::remove_recipe`]), not a
//!   round trip later; a failed delete brings it back.

use std::{cell::RefCell, collections::HashSet, sync::Arc};

use artsnack_backend::{
    Backend, CallError, LiveQuery, NoArgs, Query, QueryState,
    api::{
        enhance_recipes::{self, Recipe, RecipeSettings},
        saved_prompts::{self, SavedPrompt},
    },
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, Context, Entity, EventEmitter, Global, SharedString,
    Subscription, Task, WeakEntity,
    component::{WindowExt as _, notification::Notification},
};
use serde::de::DeserializeOwned;

/// What changed in the store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreEvent {
    SavedPrompts,
    Recipes,
    Settings,
    Seeding,
}

/// A query's rows as views read them.
pub struct Rows<T> {
    /// The latest rows: live, remembered, or the last good before a failure.
    pub data: Option<Arc<T>>,
    /// `data` is the subscription's own answer.
    pub fresh: bool,
    pub error: Option<SharedString>,
}

impl<T> Clone for Rows<T> {
    fn clone(&self) -> Self {
        Self {
            data: self.data.clone(),
            fresh: self.fresh,
            error: self.error.clone(),
        }
    }
}

impl<T> Rows<T> {
    /// Whether `other` shows the same thing (the same rows, by identity).
    pub fn same_as(&self, other: &Self) -> bool {
        let same_data = match (&self.data, &other.data) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        same_data && self.fresh == other.fresh && self.error == other.error
    }
}

/// Rows deleted here that their query may still list, by id.
struct Hidden<T> {
    ids: HashSet<String>,
    /// The last rows filtered and what they were filtered from, so the same
    /// rows keep the same `Arc` and [`Rows::same_as`] holds across reads.
    filtered: RefCell<Option<(Arc<Vec<T>>, Arc<Vec<T>>)>>,
    id: fn(&T) -> &str,
}

impl<T: Clone> Hidden<T> {
    fn new(id: fn(&T) -> &str) -> Self {
        Self {
            ids: HashSet::new(),
            filtered: RefCell::new(None),
            id,
        }
    }

    fn apply(&self, mut rows: Rows<Vec<T>>) -> Rows<Vec<T>> {
        let Some(data) = rows.data.take() else {
            return rows;
        };
        if self.ids.is_empty() {
            rows.data = Some(data);
            return rows;
        }
        let mut filtered = self.filtered.borrow_mut();
        let shown = match &*filtered {
            Some((source, shown)) if Arc::ptr_eq(source, &data) => shown.clone(),
            _ => {
                let shown: Arc<Vec<T>> = Arc::new(
                    data.iter()
                        .filter(|row| !self.ids.contains((self.id)(row)))
                        .cloned()
                        .collect(),
                );
                *filtered = Some((data, shown.clone()));
                shown
            }
        };
        rows.data = Some(shown);
        rows
    }

    fn set(&mut self, id: &str, hidden: bool) {
        if hidden {
            self.ids.insert(id.to_string());
        } else {
            self.ids.remove(id);
        }
        self.filtered.replace(None);
    }

    /// A delete is settled once a fresh answer no longer lists the row.
    fn settle(&mut self, rows: &Rows<Vec<T>>) {
        if self.ids.is_empty() || !rows.fresh {
            return;
        }
        let Some(data) = &rows.data else {
            return;
        };
        let present: HashSet<&str> = data.iter().map(|row| (self.id)(row)).collect();
        let before = self.ids.len();
        self.ids.retain(|id| present.contains(id.as_str()));
        if self.ids.len() != before {
            self.filtered.replace(None);
        }
    }
}

/// One query and its last good rows.
struct Live<T> {
    query: Entity<LiveQuery<T>>,
    last: Option<Arc<T>>,
    _observe: Subscription,
}

impl<T> Live<T>
where
    T: DeserializeOwned + PartialEq + Send + Sync + 'static,
{
    fn subscribe(
        query: Query<NoArgs, T>,
        live: fn(&mut PromptStore) -> &mut Live<T>,
        event: StoreEvent,
        last: Option<Arc<T>>,
        cx: &mut Context<PromptStore>,
    ) -> Self {
        let entity = LiveQuery::new(query, &NoArgs {}, cx);
        let observe = cx.observe(&entity, move |store, query, cx| {
            if let Some(data) = query.read(cx).data() {
                live(store).last = Some(data.clone());
            }
            store.changed(event, cx);
        });
        let last = entity.read(cx).data().cloned().or(last);
        Self {
            query: entity,
            last,
            _observe: observe,
        }
    }

    fn rows(&self, cx: &App) -> Rows<T> {
        match self.query.read(cx).state() {
            QueryState::Loading => Rows {
                data: self.last.clone(),
                fresh: false,
                error: None,
            },
            QueryState::Ready { data, stale } => Rows {
                data: Some(data.clone()),
                fresh: !stale,
                error: None,
            },
            QueryState::Failed(message) => Rows {
                data: self.last.clone(),
                fresh: false,
                error: Some(message.clone()),
            },
        }
    }

    fn is_failed(&self, cx: &App) -> bool {
        self.query.read(cx).error().is_some()
    }
}

/// Copying the built-in recipes in.
#[derive(Clone, Debug, PartialEq)]
enum Seeding {
    Idle,
    Running,
    Failed(SharedString),
}

pub struct PromptStore {
    saved: Live<Vec<SavedPrompt>>,
    recipes: Live<Vec<Recipe>>,
    settings: Live<Option<RecipeSettings>>,
    seeding: Seeding,
    hidden_prompts: Hidden<SavedPrompt>,
    hidden_recipes: Hidden<Recipe>,
    /// The Enhance model picked here that the settings may not show yet, and
    /// which pick it was: only the latest one's failure takes it back.
    chosen_model: Option<(String, u64)>,
    model_picks: u64,
}

struct GlobalPromptStore(WeakEntity<PromptStore>);

impl Global for GlobalPromptStore {}

impl EventEmitter<StoreEvent> for PromptStore {}

impl PromptStore {
    /// The app's store, made on first use. Hold the returned entity for as
    /// long as the view shows its rows.
    pub fn global(cx: &mut App) -> Entity<Self> {
        if let Some(store) = cx
            .try_global::<GlobalPromptStore>()
            .and_then(|global| global.0.upgrade())
        {
            return store;
        }
        let store = cx.new(Self::new);
        cx.set_global(GlobalPromptStore(store.downgrade()));
        store
    }

    fn new(cx: &mut Context<Self>) -> Self {
        Self {
            saved: Live::subscribe(
                saved_prompts::LIST,
                |store| &mut store.saved,
                StoreEvent::SavedPrompts,
                None,
                cx,
            ),
            recipes: Live::subscribe(
                enhance_recipes::LIST,
                |store| &mut store.recipes,
                StoreEvent::Recipes,
                None,
                cx,
            ),
            settings: Live::subscribe(
                enhance_recipes::SETTINGS,
                |store| &mut store.settings,
                StoreEvent::Settings,
                None,
                cx,
            ),
            seeding: Seeding::Idle,
            hidden_prompts: Hidden::new(|prompt| &prompt.id),
            hidden_recipes: Hidden::new(|recipe| &recipe.id),
            chosen_model: None,
            model_picks: 0,
        }
    }

    pub fn saved_prompts(&self, cx: &App) -> Rows<Vec<SavedPrompt>> {
        self.hidden_prompts.apply(self.saved.rows(cx))
    }

    pub fn recipes(&self, cx: &App) -> Rows<Vec<Recipe>> {
        self.hidden_recipes.apply(self.recipes.rows(cx))
    }

    /// Deletes a saved prompt, off every list at once.
    pub fn remove_prompt(&mut self, id: String, window: AnyWindowHandle, cx: &mut Context<Self>) {
        self.hidden_prompts.set(&id, true);
        cx.emit(StoreEvent::SavedPrompts);
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(
                saved_prompts::REMOVE,
                &saved_prompts::RemoveArgs { id: id.clone() },
                cx,
            )
        });
        self.follow_write(request, window, cx, move |store, cx| {
            store.hidden_prompts.set(&id, false);
            cx.emit(StoreEvent::SavedPrompts);
        });
    }

    /// Deletes a recipe, off every list at once.
    pub fn remove_recipe(&mut self, id: String, window: AnyWindowHandle, cx: &mut Context<Self>) {
        self.hidden_recipes.set(&id, true);
        cx.emit(StoreEvent::Recipes);
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(
                enhance_recipes::REMOVE,
                &enhance_recipes::RemoveArgs { id: id.clone() },
                cx,
            )
        });
        self.follow_write(request, window, cx, move |store, cx| {
            store.hidden_recipes.set(&id, false);
            cx.emit(StoreEvent::Recipes);
        });
    }

    /// Waits for a write; a failure runs `restore` and says why.
    fn follow_write(
        &mut self,
        request: Task<Result<(), CallError>>,
        window: AnyWindowHandle,
        cx: &mut Context<Self>,
        restore: impl FnOnce(&mut Self, &mut Context<Self>) + 'static,
    ) {
        cx.spawn(async move |this, cx| {
            if let Err(error) = request.await {
                let _ = this.update(cx, restore);
                let _ = window.update(cx, |_, window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx)
                });
            }
        })
        .detach();
    }

    pub fn settings(&self, cx: &App) -> Option<RecipeSettings> {
        let mut settings = self
            .settings
            .rows(cx)
            .data
            .and_then(|settings| (*settings).clone())?;
        if let Some((model_id, _)) = &self.chosen_model {
            settings.model_id = model_id.clone();
        }
        Some(settings)
    }

    /// Makes `model_id` the Enhance model, shown everywhere at once; a
    /// failure puts the previous one back and says why.
    pub fn set_model(&mut self, model_id: String, window: AnyWindowHandle, cx: &mut Context<Self>) {
        self.model_picks += 1;
        let pick = self.model_picks;
        self.chosen_model = Some((model_id.clone(), pick));
        cx.emit(StoreEvent::Settings);
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(
                enhance_recipes::SET_MODEL,
                &enhance_recipes::SetModelArgs { model_id },
                cx,
            )
        });
        self.follow_write(request, window, cx, move |store, cx| {
            if store
                .chosen_model
                .as_ref()
                .is_some_and(|(_, latest)| *latest == pick)
            {
                store.chosen_model = None;
                cx.emit(StoreEvent::Settings);
            }
        });
    }

    /// Subscribes again to every query that failed, keeping its last rows on
    /// screen until the new answer.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        if self.saved.is_failed(cx) {
            let last = self.saved.last.take();
            self.saved = Live::subscribe(
                saved_prompts::LIST,
                |store| &mut store.saved,
                StoreEvent::SavedPrompts,
                last,
                cx,
            );
            cx.emit(StoreEvent::SavedPrompts);
        }
        if self.recipes.is_failed(cx) {
            let last = self.recipes.last.take();
            self.recipes = Live::subscribe(
                enhance_recipes::LIST,
                |store| &mut store.recipes,
                StoreEvent::Recipes,
                last,
                cx,
            );
            cx.emit(StoreEvent::Recipes);
        }
        if self.settings.is_failed(cx) {
            let last = self.settings.last.take();
            self.settings = Live::subscribe(
                enhance_recipes::SETTINGS,
                |store| &mut store.settings,
                StoreEvent::Settings,
                last,
                cx,
            );
            cx.emit(StoreEvent::Settings);
        }
    }

    /// Why the built-in recipes could not be copied in, until a retry.
    pub fn seeding_error(&self) -> Option<&SharedString> {
        match &self.seeding {
            Seeding::Failed(message) => Some(message),
            _ => None,
        }
    }

    /// Copies the built-ins in if the settings say they are missing, retrying
    /// a copy that failed. Views call it when they open; the store itself
    /// only starts a copy on a live answer, and never retries on its own.
    pub fn ensure_seeded(&mut self, cx: &mut Context<Self>) {
        let unseeded = self
            .settings
            .rows(cx)
            .data
            .is_some_and(|settings| settings.as_ref().as_ref().is_some_and(|s| !s.seeded));
        if unseeded {
            self.seed(true, cx);
        }
    }

    fn changed(&mut self, event: StoreEvent, cx: &mut Context<Self>) {
        match event {
            StoreEvent::SavedPrompts => {
                let rows = self.saved.rows(cx);
                self.hidden_prompts.settle(&rows);
            }
            StoreEvent::Recipes => {
                let rows = self.recipes.rows(cx);
                self.hidden_recipes.settle(&rows);
            }
            _ => {}
        }
        if event == StoreEvent::Settings {
            // The pick is settled once the live settings show it.
            let live = self.settings.rows(cx);
            if live.fresh
                && let Some((model_id, _)) = &self.chosen_model
                && live
                    .data
                    .as_ref()
                    .and_then(|settings| settings.as_ref().as_ref())
                    .is_some_and(|settings| &settings.model_id == model_id)
            {
                self.chosen_model = None;
            }
            let rows = self.settings.rows(cx);
            let unseeded = rows
                .data
                .is_some_and(|settings| settings.as_ref().as_ref().is_some_and(|s| !s.seeded));
            if rows.fresh && unseeded {
                self.seed(false, cx);
            }
        }
        cx.emit(event);
    }

    fn seed(&mut self, retry_failed: bool, cx: &mut Context<Self>) {
        match self.seeding {
            Seeding::Running => return,
            Seeding::Failed(_) if !retry_failed => return,
            _ => {}
        }
        self.seeding = Seeding::Running;
        cx.emit(StoreEvent::Seeding);
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(enhance_recipes::ENSURE_SEEDED, &NoArgs {}, cx)
        });
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = this.update(cx, |this, cx| {
                this.seeding = match result {
                    // The settings query brings `seeded` along with the rows.
                    Ok(()) => Seeding::Idle,
                    Err(error) => {
                        tracing::warn!(%error, "could not copy the built-in recipes in");
                        Seeding::Failed(error.user_message())
                    }
                };
                cx.emit(StoreEvent::Seeding);
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(ids: &[&str], fresh: bool) -> Rows<Vec<String>> {
        Rows {
            data: Some(Arc::new(ids.iter().map(|id| id.to_string()).collect())),
            fresh,
            error: None,
        }
    }

    fn ids(rows: &Rows<Vec<String>>) -> Vec<String> {
        rows.data.as_deref().cloned().unwrap_or_default()
    }

    #[test]
    fn hides_a_row_until_a_fresh_answer_drops_it() {
        let mut hidden = Hidden::<String>::new(|id| id);
        let live = rows(&["a", "b"], true);
        hidden.set("a", true);
        assert_eq!(ids(&hidden.apply(live.clone())), ["b"]);

        // A remembered snapshot does not settle it.
        hidden.settle(&rows(&["b"], false));
        assert_eq!(ids(&hidden.apply(live.clone())), ["b"]);

        hidden.settle(&rows(&["b"], true));
        assert!(hidden.ids.is_empty());
        assert_eq!(ids(&hidden.apply(rows(&["a", "b"], true))), ["a", "b"]);
    }

    #[test]
    fn the_same_rows_filter_to_the_same_arc() {
        let mut hidden = Hidden::<String>::new(|id| id);
        hidden.set("a", true);
        let live = rows(&["a", "b"], true);
        assert!(hidden.apply(live.clone()).same_as(&hidden.apply(live)));
    }

    #[test]
    fn a_failed_delete_brings_the_row_back() {
        let mut hidden = Hidden::<String>::new(|id| id);
        let live = rows(&["a", "b"], true);
        hidden.set("a", true);
        assert_eq!(ids(&hidden.apply(live.clone())), ["b"]);
        hidden.set("a", false);
        assert_eq!(ids(&hidden.apply(live)), ["a", "b"]);
    }
}
