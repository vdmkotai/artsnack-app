//! Enhance recipes: the instructions the prompt Enhance button sends, and the
//! model that runs them. The model list is `ENHANCE_MODELS` from
//! `packages/shared/prompt-enhance.ts`, read through the rules bridge.
//!
//! The list is virtual like the saved prompts': editors are made the first
//! time a card is drawn, from a live answer only.

use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::Arc,
};

use artsnack_backend::{
    Backend, NoArgs,
    api::enhance_recipes::{self, CreateArgs, Recipe, RecipeMedia, UpdateArgs},
};
use artsnack_rules::Rules;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, FontWeight, IntoElement, ParentElement as _,
    Render, SharedString, Styled as _, Subscription, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Selectable as _, Sizable as _, WindowExt as _,
        alert::Alert,
        button::{Button, ButtonGroup, ButtonVariant, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        notification::Notification,
        searchable_list::SearchableVec,
        select::{Select, SelectEvent, SelectState},
        spinner::Spinner,
        switch::Switch,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};
use serde::Deserialize;

use crate::{
    card_list::{CardList, Item, card_row},
    editor::{Saves, Tracked},
    store::{PromptStore, Rows, StoreEvent},
};

/// One entry of `ENHANCE_MODELS`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct EnhanceModel {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub note: String,
    /// The model reads images (`EnhanceModel.vision`, from Atlas's model list).
    #[serde(default)]
    pub vision: bool,
}

impl EnhanceModel {
    fn display(&self) -> SharedString {
        if self.note.is_empty() {
            self.label.clone().into()
        } else {
            format!("{} · {}", self.label, self.note).into()
        }
    }
}

/// The models, from the shared registry; empty if the bridge failed to load.
pub fn enhance_models(cx: &gpui_kit::App) -> Vec<EnhanceModel> {
    Rules::global(cx)
        .and_then(|rules| match rules.get("promptEnhance.ENHANCE_MODELS") {
            Ok(models) => Some(models),
            Err(error) => {
                tracing::error!(?error, "could not read ENHANCE_MODELS");
                None
            }
        })
        .unwrap_or_default()
}

/// The text a recipe's placeholders are replaced with, shown as a legend.
const PLACEHOLDERS: [(&str, &str); 7] = [
    ("{{targetModel}}", "the model the prompt is for"),
    ("{{media}}", "image or video"),
    ("{{duration}}", "the clip length"),
    ("{{durationFallback}}", "the clip length, or a default"),
    ("{{aspectRatio}}", "the output shape"),
    ("{{references}}", "what the reference images are"),
    ("{{h3Inputs}}", "the H3 inputs in use"),
];

type ModelSelect = SelectState<SearchableVec<SharedString>>;

/// Selects `choice` unless it already is: setting it again would clear a
/// search typed into the open dropdown.
fn select_choice(
    select: &Entity<ModelSelect>,
    choice: SharedString,
    window: &mut Window,
    cx: &mut gpui_kit::App,
) {
    select.update(cx, |state, cx| {
        if state.selected_value() != Some(&choice) {
            state.set_selected_value(&choice, window, cx);
        }
    });
}

pub struct RecipeCard {
    recipe: Recipe,
    title: Entity<InputState>,
    instructions: Entity<TextareaState>,
    model: Entity<ModelSelect>,
    tracked_title: Tracked,
    tracked_instructions: Tracked,
    saves: Saves,
    models: Rc<Vec<EnhanceModel>>,
    _subscriptions: Vec<Subscription>,
}

const SAME_AS_EVERY_RECIPE: &str = "Same as every recipe";

impl RecipeCard {
    fn new(
        recipe: &Recipe,
        models: Rc<Vec<EnhanceModel>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let title = cx.new(|cx| InputState::new(window, cx).default_value(recipe.title.clone()));
        let instructions = cx.new(|cx| {
            TextareaState::new(window, cx)
                .rows(8)
                .default_value(recipe.instructions.clone())
        });
        let items: Vec<SharedString> = std::iter::once(SharedString::from(SAME_AS_EVERY_RECIPE))
            .chain(models.iter().map(EnhanceModel::display))
            .collect();
        let model = cx.new(|cx| SelectState::new(SearchableVec::new(items), None, window, cx));
        let subscriptions = vec![
            cx.subscribe_in(
                &title,
                window,
                |this, state, event, window, cx| match event {
                    InputEvent::Change => {
                        let value = state.read(cx).value().to_string();
                        this.tracked_title.edit(&value);
                        cx.notify();
                    }
                    InputEvent::Blur | InputEvent::PressEnter { .. } => this.save_text(window, cx),
                    _ => {}
                },
            ),
            cx.subscribe_in(
                &instructions,
                window,
                |this, state, event, window, cx| match event {
                    InputEvent::Change => {
                        let value = state.read(cx).value().to_string();
                        this.tracked_instructions.edit(&value);
                        cx.notify();
                    }
                    InputEvent::Blur => this.save_text(window, cx),
                    _ => {}
                },
            ),
            cx.subscribe_in(
                &model,
                window,
                |this, _, event: &SelectEvent<SearchableVec<SharedString>>, window, cx| {
                    let SelectEvent::Confirm(Some(choice)) = event else {
                        return;
                    };
                    let model_id = this
                        .models
                        .iter()
                        .find(|model| model.display() == *choice)
                        .map(|model| model.id.clone())
                        .unwrap_or_default();
                    this.update(
                        UpdateArgs {
                            model_id: Some(model_id),
                            ..UpdateArgs::default()
                        },
                        window,
                        cx,
                    );
                },
            ),
        ];
        let mut card = Self {
            recipe: recipe.clone(),
            title,
            instructions,
            model,
            tracked_title: Tracked::new(&recipe.title),
            tracked_instructions: Tracked::new(&recipe.instructions),
            saves: Saves::default(),
            models,
            _subscriptions: subscriptions,
        };
        card.select_model(window, cx);
        card
    }

    fn select_model(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let choice = self
            .recipe
            .model_id
            .as_ref()
            .and_then(|id| self.models.iter().find(|model| model.id == *id))
            .map(EnhanceModel::display)
            .unwrap_or_else(|| SAME_AS_EVERY_RECIPE.into());
        select_choice(&self.model, choice, window, cx);
    }

    fn server_update(&mut self, recipe: &Recipe, window: &mut Window, cx: &mut Context<Self>) {
        if *recipe == self.recipe {
            return;
        }
        if let Some(title) = self.tracked_title.server(&recipe.title) {
            self.title
                .update(cx, |input, cx| input.set_value(title, window, cx));
        }
        if let Some(text) = self.tracked_instructions.server(&recipe.instructions) {
            self.instructions
                .update(cx, |input, cx| input.set_value(text, window, cx));
        }
        let model_changed = recipe.model_id != self.recipe.model_id;
        self.recipe = recipe.clone();
        if model_changed {
            self.select_model(window, cx);
        }
        cx.notify();
    }

    fn is_dirty(&self) -> bool {
        self.tracked_title.is_dirty() || self.tracked_instructions.is_dirty()
    }

    /// Sends the text fields that changed, one save at a time; each is marked
    /// saved only once its save succeeded. A failure keeps the text and
    /// offers Retry.
    fn save_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_dirty() || !self.saves.begin() {
            return;
        }
        let sent_title = self
            .tracked_title
            .is_dirty()
            .then(|| self.tracked_title.local().to_string());
        let sent_instructions = self
            .tracked_instructions
            .is_dirty()
            .then(|| self.tracked_instructions.local().to_string());
        cx.notify();
        let args = UpdateArgs {
            id: self.recipe.id.clone(),
            title: sent_title.clone(),
            instructions: sent_instructions.clone(),
            ..UpdateArgs::default()
        };
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(enhance_recipes::UPDATE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = request.await;
            let _ = window_handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    let again = match result {
                        Ok(()) => {
                            // The server trims a title and keeps instructions as sent.
                            if let Some(sent) = &sent_title
                                && let Some(shown) = this.tracked_title.saved(sent, sent.trim())
                            {
                                this.title
                                    .update(cx, |input, cx| input.set_value(shown, window, cx));
                            }
                            if let Some(sent) = &sent_instructions {
                                this.tracked_instructions.saved(sent, sent);
                            }
                            this.saves.finish(Ok(()))
                        }
                        Err(error) => {
                            let message = error.user_message();
                            window.push_notification(Notification::error(message.clone()), cx);
                            this.saves.finish(Err(message))
                        }
                    };
                    cx.notify();
                    if again {
                        this.save_text(window, cx);
                    }
                });
            });
        })
        .detach();
    }

    /// Sends an update for this recipe; a refusal is shown and the server's
    /// copy comes back through the live list.
    fn update(&mut self, mut args: UpdateArgs, window: &mut Window, cx: &mut Context<Self>) {
        args.id = self.recipe.id.clone();
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(enhance_recipes::UPDATE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |_, cx| {
            if let Err(error) = request.await {
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx)
                });
            }
        })
        .detach();
    }

    fn confirm_delete(&self, window: &mut Window, cx: &mut Context<Self>) {
        let id = self.recipe.id.clone();
        let title = self.recipe.title.clone();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let id = id.clone();
            alert
                .title(format!("Delete \u{201c}{title}\u{201d}?"))
                .description("Restore built-ins brings a built-in recipe back.")
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let window = window.window_handle();
                    PromptStore::global(cx)
                        .update(cx, |store, cx| store.remove_recipe(id.clone(), window, cx));
                    true
                })
        });
    }

    /// Under the instructions: saving, the last failure with Retry, or unsaved.
    fn render_save_state(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let muted = cx.theme().muted_foreground;
        if self.saves.is_saving() {
            return Some(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("Saving…")
                    .into_any_element(),
            );
        }
        if let Some(message) = self.saves.failed() {
            return Some(
                h_flex()
                    .gap_2()
                    .justify_between()
                    .child(
                        div()
                            .min_w_0()
                            .text_xs()
                            .text_color(cx.theme().danger)
                            .child(format!("Not saved: {message}")),
                    )
                    .child(
                        Button::new("retry-save")
                            .xsmall()
                            .outline()
                            .label("Retry")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.save_text(window, cx)),
                            ),
                    )
                    .into_any_element(),
            );
        }
        self.is_dirty().then(|| {
            div()
                .text_xs()
                .text_color(muted)
                .child("Unsaved — click away to save.")
                .into_any_element()
        })
    }
}

impl Render for RecipeCard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let media = self.recipe.media;
        let is_default = self.recipe.is_default;
        let media_label = media.label().to_lowercase();
        let save_state = self.render_save_state(cx);
        card_frame(cx)
            .child(
                h_flex()
                    .gap_1()
                    .child(
                        div()
                            .flex_1()
                            .child(Input::new(&self.title).appearance(false)),
                    )
                    .child(
                        Button::new("delete")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Trash)
                            .tooltip("Delete recipe")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.confirm_delete(window, cx)),
                            ),
                    ),
            )
            .child(Textarea::new(&self.instructions))
            .children(save_state)
            .child(
                h_flex()
                    .gap_3()
                    .flex_wrap()
                    .child(
                        ButtonGroup::new("media")
                            .xsmall()
                            .outline()
                            .children(RecipeMedia::ALL.iter().map(|option| {
                                Button::new(option.label())
                                    .label(option.label())
                                    .selected(*option == media)
                            }))
                            .on_click(cx.listener(|this, selected: &Vec<usize>, window, cx| {
                                if let Some(media) =
                                    selected.first().and_then(|ix| RecipeMedia::ALL.get(*ix))
                                {
                                    this.update(
                                        UpdateArgs {
                                            media: Some(*media),
                                            ..UpdateArgs::default()
                                        },
                                        window,
                                        cx,
                                    );
                                }
                            })),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(Switch::new("default").checked(is_default).on_change(
                                cx.listener(|this, checked: &bool, window, cx| {
                                    this.update(
                                        UpdateArgs {
                                            is_default: Some(*checked),
                                            ..UpdateArgs::default()
                                        },
                                        window,
                                        cx,
                                    );
                                }),
                            ))
                            .child(div().text_sm().child(format!("Default for {media_label}"))),
                    ),
            )
            .child(Select::new(&self.model).small())
    }
}

fn card_frame(cx: &gpui_kit::App) -> gpui_kit::Div {
    v_flex()
        .gap_2()
        .p_3()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().popover)
}

/// A recipe shown before the server has answered: the text, not editable.
fn preview(recipe: &Recipe, cx: &gpui_kit::App) -> AnyElement {
    card_frame(cx)
        .child(
            div()
                .truncate()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .child(recipe.title.clone()),
        )
        .child(
            div()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .line_clamp(8)
                .child(recipe.instructions.clone()),
        )
        .child(
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(recipe.media.label()),
        )
        .into_any_element()
}

pub struct RecipesTab {
    store: Entity<PromptStore>,
    /// The rows the list was last laid out for.
    rows: Rows<Vec<Recipe>>,
    models: Rc<Vec<EnhanceModel>>,
    global_model: Entity<ModelSelect>,
    /// Editors, made the first time a card is drawn from a live answer.
    cards: HashMap<String, Entity<RecipeCard>>,
    list: CardList,
    _subscriptions: Vec<Subscription>,
}

impl RecipesTab {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = PromptStore::global(cx);
        let models = Rc::new(enhance_models(cx));
        let items: Vec<SharedString> = models.iter().map(EnhanceModel::display).collect();
        let global_model = cx.new(|cx| {
            SelectState::new(SearchableVec::new(items), None, window, cx).searchable(true)
        });
        let subscriptions = vec![
            cx.subscribe_in(
                &store,
                window,
                |this, _, event: &StoreEvent, window, cx| match event {
                    StoreEvent::Recipes => this.sync(window, cx),
                    StoreEvent::Settings => this.settings_changed(window, cx),
                    StoreEvent::Seeding => cx.notify(),
                    StoreEvent::SavedPrompts => {}
                },
            ),
            cx.subscribe_in(
                &global_model,
                window,
                |this, _, event: &SelectEvent<SearchableVec<SharedString>>, window, cx| {
                    let SelectEvent::Confirm(Some(choice)) = event else {
                        return;
                    };
                    let Some(model) = this.models.iter().find(|model| model.display() == *choice)
                    else {
                        return;
                    };
                    let model_id = model.id.clone();
                    let window = window.window_handle();
                    this.store
                        .update(cx, |store, cx| store.set_model(model_id, window, cx));
                },
            ),
        ];
        let mut this = Self {
            store,
            rows: Rows {
                data: None,
                fresh: false,
                error: None,
            },
            models,
            global_model,
            cards: HashMap::new(),
            list: CardList::new(),
            _subscriptions: subscriptions,
        };
        // Opening the tab copies the built-ins in if they are missing, and
        // tries again after a failed copy.
        this.store.update(cx, |store, cx| store.ensure_seeded(cx));
        this.sync(window, cx);
        this.settings_changed(window, cx);
        this
    }

    fn settings_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(settings) = self.store.read(cx).settings(cx) else {
            return;
        };
        if let Some(model) = self
            .models
            .iter()
            .find(|model| model.id == settings.model_id)
        {
            select_choice(&self.global_model, model.display(), window, cx);
        }
        cx.notify();
    }

    /// Brings the cards and the list in line with the store. Only cards whose
    /// row changed hear about it.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let next = self.store.read(cx).recipes(cx);
        if next.same_as(&self.rows) && self.list.is_synced() {
            return;
        }
        let rows: Arc<Vec<Recipe>> = next.data.clone().unwrap_or_default();
        let previous: HashMap<&str, &Recipe> = self
            .rows
            .data
            .iter()
            .flat_map(|rows| rows.iter())
            .map(|recipe| (recipe.id.as_str(), recipe))
            .collect();
        if next.data.is_some() {
            let present: HashSet<&str> = rows.iter().map(|recipe| recipe.id.as_str()).collect();
            self.cards.retain(|id, _| present.contains(id.as_str()));
        }
        let mut changed = Vec::new();
        for (ix, recipe) in rows.iter().enumerate() {
            if previous.get(recipe.id.as_str()) == Some(&recipe) {
                continue;
            }
            changed.push(ix);
            if let Some(card) = self.cards.get(&recipe.id) {
                card.update(cx, |card, cx| card.server_update(recipe, window, cx));
            }
        }
        let ids = rows.iter().map(|recipe| recipe.id.clone()).collect();
        // The legend always follows; an empty or loading list says so first.
        let trailing = 1 + usize::from(rows.is_empty());
        self.list.sync(ids, &changed, trailing, next.fresh);
        self.rows = next;
        cx.notify();
    }

    fn restore_builtins(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(enhance_recipes::RESTORE_BUILTINS, &NoArgs {}, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |_, cx| {
            let result = request.await;
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(restored) if restored.added >= 1.0 => window.push_notification(
                    Notification::success(format!("Restored {}", restored.added as u64)),
                    cx,
                ),
                Ok(_) => window.push_notification(Notification::info("Nothing to restore"), cx),
                Err(error) => {
                    window.push_notification(Notification::error(error.user_message()), cx)
                }
            });
        })
        .detach();
    }

    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let args = CreateArgs {
            title: "New recipe".into(),
            instructions: "Rewrite the prompt for {{targetModel}}. Keep the subject; add the details a {{media}} model needs.".into(),
            media: RecipeMedia::Any,
        };
        let request = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(enhance_recipes::CREATE, &args, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |_, cx| {
            if let Err(error) = request.await {
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx)
                });
            }
        })
        .detach();
    }

    fn render_item(
        &mut self,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match self.list.item(ix) {
            Item::Header => self.render_header(cx),
            Item::Row(left, right) => {
                let Some(rows) = self.rows.data.clone() else {
                    return div().into_any_element();
                };
                let left = rows
                    .get(left)
                    .map(|recipe| self.render_card(recipe, window, cx));
                let right = rows
                    .get(right)
                    .map(|recipe| self.render_card(recipe, window, cx));
                card_row(left, right)
            }
            Item::Trailing(ix) => {
                let empty = self.rows.data.as_ref().is_none_or(|rows| rows.is_empty());
                if empty && ix == 0 {
                    self.render_empty(cx)
                } else {
                    render_legend(cx)
                }
            }
        }
    }

    fn render_card(
        &mut self,
        recipe: &Recipe,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let Some(card) = self.cards.get(&recipe.id) {
            return card.clone().into_any_element();
        }
        if !self.rows.fresh {
            return preview(recipe, cx);
        }
        let models = self.models.clone();
        let card = cx.new(|cx| RecipeCard::new(recipe, models, window, cx));
        self.cards.insert(recipe.id.clone(), card.clone());
        card.into_any_element()
    }

    /// The model for every recipe, problems with the list, and the buttons.
    fn render_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let store = self.store.read(cx);
        let global = store.settings(cx).and_then(|settings| {
            self.models
                .iter()
                .find(|model| model.id == settings.model_id)
                .cloned()
        });
        let seeding_error = store.seeding_error().cloned();
        let billing = match global.as_ref().map(|model| model.provider.as_str()) {
            Some("grok") => {
                "Runs on the Grok subscription; falls back to Atlas when it is unavailable."
            }
            Some(_) => "Billed to the Atlas balance.",
            None => "",
        };
        let updating = self.rows.error.is_none() && !self.rows.fresh && self.rows.data.is_some();

        v_flex()
            .px_4()
            .pb_4()
            .gap_4()
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Model for every recipe"),
                    )
                    .child(Select::new(&self.global_model))
                    .when(!billing.is_empty(), |this| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(billing),
                        )
                    }),
            )
            .when_some(seeding_error, |this, error| {
                this.child(
                    h_flex()
                        .gap_2()
                        .child(div().flex_1().min_w_0().child(Alert::error(
                            "recipes-seeding-error",
                            format!("The built-in recipes could not be added: {error}"),
                        )))
                        .child(
                            Button::new("retry-seeding")
                                .small()
                                .outline()
                                .label("Retry")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.store.update(cx, |store, cx| store.ensure_seeded(cx));
                                })),
                        ),
                )
            })
            .when_some(self.rows.error.clone(), |this, error| {
                this.child(
                    h_flex()
                        .gap_2()
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_sm()
                                .text_color(cx.theme().danger)
                                .child(format!("Could not load your recipes: {error}")),
                        )
                        .child(
                            Button::new("retry-recipes")
                                .small()
                                .outline()
                                .label("Retry")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.store.update(cx, |store, cx| store.retry(cx));
                                })),
                        ),
                )
            })
            .child(
                h_flex()
                    .gap_2()
                    .justify_between()
                    .child(div().min_w_0().when(updating, |this| {
                        this.child(
                            h_flex()
                                .gap_2()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(Spinner::new().xsmall())
                                .child("Updating…"),
                        )
                    }))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("restore-builtins")
                                    .outline()
                                    .small()
                                    .label("Restore built-ins")
                                    .tooltip("Add back any built-in recipe that was deleted")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.restore_builtins(window, cx)
                                    })),
                            )
                            .child(
                                Button::new("new-recipe")
                                    .primary()
                                    .small()
                                    .icon(IconName::Plus)
                                    .label("New recipe")
                                    .on_click(
                                        cx.listener(|this, _, window, cx| this.create(window, cx)),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }

    /// Loading, or no recipes — an error, if any, is in the header.
    fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.rows.data.is_none() {
            if self.rows.error.is_some() {
                return div().into_any_element();
            }
            return div()
                .py_8()
                .flex()
                .justify_center()
                .child(Spinner::new())
                .into_any_element();
        }
        div()
            .px_4()
            .py_8()
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .child("No recipes yet.")
            .into_any_element()
    }
}

fn render_legend(cx: &gpui_kit::App) -> AnyElement {
    div()
        .px_4()
        .pb_6()
        .child(
            v_flex()
                .gap_1()
                .p_3()
                .rounded(cx.theme().radius_lg)
                .bg(cx.theme().muted)
                .text_xs()
                .child(div().font_weight(FontWeight::MEDIUM).child("Placeholders"))
                .children(PLACEHOLDERS.iter().map(|(placeholder, meaning)| {
                    h_flex()
                        .gap_2()
                        .child(div().font_weight(FontWeight::MEDIUM).child(*placeholder))
                        .child(
                            div()
                                .text_color(cx.theme().muted_foreground)
                                .child(*meaning),
                        )
                })),
        )
        .into_any_element()
}

impl Render for RecipesTab {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.list
            .render(cx.processor(|this, ix: usize, window, cx| this.render_item(ix, window, cx)))
    }
}
