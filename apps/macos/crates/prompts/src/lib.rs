//! Prompts: the saved-prompt library and the Enhance recipes.

mod assist;
mod card_list;
mod editor;
mod recipes;
mod saved;
mod store;

use artsnack_settings::{Preference, Preferences};
use gpui_kit::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Styled as _, Window,
    component::{
        ActiveTheme as _, Selectable as _, Sizable as _,
        button::{Button, ButtonGroup},
        h_flex, v_flex,
    },
    div,
};
use serde::{Deserialize, Serialize};

pub use assist::{
    ContextReader, OpenRecipes, OpenSavedPrompts, PromptEnhance, PromptLibrary, PromptReader,
    PromptWriter,
};
pub use recipes::{EnhanceModel, enhance_models};
pub use store::{PromptStore, Rows, StoreEvent};

/// Binds the prompts helpers' keys. Call after the composers' (`generate`)
/// init: see `assist::init`.
pub fn init(cx: &mut gpui_kit::App) {
    assist::init(cx);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptsTab {
    Saved,
    Recipes,
}

const TAB: Preference<PromptsTab> = Preference::new("prompts.tab", || PromptsTab::Saved);

pub struct PromptsView {
    tab: PromptsTab,
    saved: Entity<saved::SavedPromptsTab>,
    recipes: Option<Entity<recipes::RecipesTab>>,
}

impl PromptsView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let tab = Preferences::get(cx, &TAB);
        let saved = cx.new(|cx| saved::SavedPromptsTab::new(window, cx));
        let mut this = Self {
            tab,
            saved,
            recipes: None,
        };
        this.ensure_tab(window, cx);
        this
    }

    /// Opens a tab (the Enhance menu's "Edit recipes" lands on Recipes).
    pub fn show(&mut self, tab: PromptsTab, window: &mut Window, cx: &mut Context<Self>) {
        self.tab = tab;
        Preferences::set(cx, &TAB, tab);
        self.ensure_tab(window, cx);
        cx.notify();
    }

    fn ensure_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.tab == PromptsTab::Recipes && self.recipes.is_none() {
            self.recipes = Some(cx.new(|cx| recipes::RecipesTab::new(window, cx)));
        }
    }
}

impl Render for PromptsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let subtitle = match self.tab {
            PromptsTab::Saved => {
                "Prompts worth keeping. Edit in place; changes save when you click away."
            }
            PromptsTab::Recipes => "What the Enhance button asks the model to do, per media type.",
        };
        let content = match (self.tab, &self.recipes) {
            (PromptsTab::Recipes, Some(recipes)) => recipes.clone().into_any_element(),
            _ => self.saved.clone().into_any_element(),
        };
        // The header stays put; each tab's list scrolls under it and builds
        // only the rows on screen.
        div().size_full().flex().justify_center().child(
            v_flex()
                .id("prompts")
                .w_full()
                .max_w(gpui_kit::rems(56.))
                .h_full()
                .child(
                    h_flex()
                        .px_4()
                        .py_6()
                        .justify_between()
                        .items_start()
                        .gap_4()
                        .child(
                            v_flex()
                                .gap_1()
                                .child(
                                    div()
                                        .text_2xl()
                                        .font_weight(FontWeight::BOLD)
                                        .child("Prompts"),
                                )
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(subtitle),
                                ),
                        )
                        .child(
                            ButtonGroup::new("prompts-tab")
                                .small()
                                .outline()
                                .child(
                                    Button::new("saved")
                                        .label("Saved prompts")
                                        .selected(self.tab == PromptsTab::Saved),
                                )
                                .child(
                                    Button::new("recipes")
                                        .label("Enhance recipes")
                                        .selected(self.tab == PromptsTab::Recipes),
                                )
                                .on_click(cx.listener(
                                    |this, selected: &Vec<usize>, window, cx| {
                                        let tab = if selected.first() == Some(&1) {
                                            PromptsTab::Recipes
                                        } else {
                                            PromptsTab::Saved
                                        };
                                        this.show(tab, window, cx);
                                    },
                                )),
                        ),
                )
                .child(div().flex_1().min_h_0().child(content)),
        )
    }
}
