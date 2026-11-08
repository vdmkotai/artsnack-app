//! The model picker: which text model looks at the pictures (the web's
//! "Model" select in `ImageToPromptPanel`).
//!
//! The list is `imageToPrompt.models` — the subscription's own models, then
//! Atlas's text models, read live — and until it answers, the built-in Grok
//! models from `FALLBACK_DESCRIBE_CATALOG`. Grouping, the stand-in for a model
//! the list lacks, a failed list filled in from the last full one, and the
//! lines under the picker all come from `packages/shared/image-to-prompt.ts`
//! through the rules bridge.

use artsnack_backend::api::image_to_prompt::{DescribeModelCatalog, DescribeModelOption};
use artsnack_rules::Rules;
use gpui_kit::{
    App, Entity, IntoElement, ParentElement as _, SharedString, Styled as _, Window,
    component::{
        ActiveTheme as _,
        searchable_list::{SearchableGroup, SearchableListItem, SearchableVec},
        select::SelectState,
        v_flex,
    },
    div,
};
use serde::Deserialize;

/// A model in the picker: its name, and on a second line who bills it and,
/// for Atlas, its slug — Atlas has three models called "GPT 5.6 Sol".
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ModelChoice {
    value: SharedString,
    title: SharedString,
    note: SharedString,
}

impl ModelChoice {
    fn new(model: &DescribeModelOption) -> Self {
        let note = if model.provider == "atlas" {
            format!("{} · {}", model.note, model.model)
        } else {
            model.note.clone()
        };
        Self {
            value: model.id.clone().into(),
            title: model.label.clone().into(),
            note: note.into(),
        }
    }
}

impl SearchableListItem for ModelChoice {
    type Value = SharedString;

    fn title(&self) -> SharedString {
        self.title.clone()
    }

    fn render(&self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        v_flex()
            .min_w_0()
            .py_0p5()
            .child(div().truncate().child(self.title.clone()))
            .child(
                div()
                    .truncate()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(self.note.clone()),
            )
    }

    fn value(&self) -> &SharedString {
        &self.value
    }

    fn matches(&self, query: &str) -> bool {
        let query = query.to_lowercase();
        self.title.to_lowercase().contains(&query) || self.note.to_lowercase().contains(&query)
    }
}

pub(super) type ModelSelect = SelectState<SearchableVec<SearchableGroup<ModelChoice>>>;

/// `DescribeModelGroup`.
#[derive(Deserialize)]
struct ModelGroup {
    title: String,
    models: Vec<DescribeModelOption>,
}

/// What the picker shows for one catalogue and one pick.
pub(super) struct ModelView {
    pub groups: Vec<SearchableGroup<ModelChoice>>,
    /// The picked model, from the list or made from its id.
    pub model: DescribeModelOption,
    /// Who pays, and what happens when it cannot answer.
    pub hint: SharedString,
}

impl ModelView {
    pub fn new(
        rules: &Rules,
        catalog: &DescribeModelCatalog,
        selected_id: &str,
    ) -> anyhow::Result<Self> {
        let groups: Vec<ModelGroup> = rules.call(
            "imageToPrompt.groupDescribeModels",
            &(&catalog.models, selected_id),
        )?;
        let model = match groups
            .iter()
            .flat_map(|group| &group.models)
            .find(|model| model.id == selected_id)
        {
            Some(model) => model.clone(),
            None => resolve_model(rules, selected_id)?,
        };
        let hint: String = rules.call(
            "imageToPrompt.describeModelHint",
            &(&model, &catalog.models),
        )?;
        Ok(Self {
            groups: groups
                .iter()
                .map(|group| {
                    SearchableGroup::new(group.title.clone())
                        .items(group.models.iter().map(ModelChoice::new))
                })
                .collect(),
            model,
            hint: hint.into(),
        })
    }
}

/// `withPreviousModels`: a live answer with each list that failed filled in
/// from `previous`, the last answer both vendors gave in full.
pub(super) fn with_previous_models(
    rules: &Rules,
    fresh: DescribeModelCatalog,
    previous: &[DescribeModelOption],
) -> DescribeModelCatalog {
    match rules.call("imageToPrompt.withPreviousModels", &(&fresh, previous)) {
        Ok(catalog) => catalog,
        Err(error) => {
            tracing::error!(?error, "could not fill in the model list from last time");
            fresh
        }
    }
}

/// `describeModelFor`: the model `id` names — a malformed or empty id
/// resolves to the default.
pub(super) fn resolve_model(rules: &Rules, id: &str) -> anyhow::Result<DescribeModelOption> {
    rules.call("imageToPrompt.describeModelFor", &(id,))
}

/// Gives the picker its groups and shows `value` as picked — unless it
/// already is: setting it again would clear a search typed into the open
/// dropdown.
pub(super) fn show_models(
    select: &Entity<ModelSelect>,
    groups: Vec<SearchableGroup<ModelChoice>>,
    value: &str,
    window: &mut Window,
    cx: &mut App,
) {
    let value = SharedString::from(value.to_string());
    select.update(cx, |select, cx| {
        select.set_items(SearchableVec::new(groups), window, cx);
        if select.selected_value() != Some(&value) {
            select.set_selected_value(&value, window, cx);
        }
    });
}

/// `describeCatalogNotice`: what went wrong reading the lists, if anything,
/// as one line.
pub(super) fn catalog_notice(
    rules: &Rules,
    catalog: &DescribeModelCatalog,
    load_error: Option<&str>,
) -> anyhow::Result<Option<String>> {
    rules.call(
        "imageToPrompt.describeCatalogNotice",
        &(catalog, load_error),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(id: &str, provider: &str, note: &str) -> DescribeModelOption {
        DescribeModelOption {
            id: id.into(),
            provider: provider.into(),
            model: id.split_once(':').unwrap().1.into(),
            label: "GPT 5.6 Sol".into(),
            note: note.into(),
            vision: true,
        }
    }

    #[test]
    fn an_atlas_choice_carries_its_slug() {
        let choice = ModelChoice::new(&option(
            "atlas:openai/gpt-5.6-sol-az",
            "atlas",
            "Atlas · $5 / $30 per 1M",
        ));
        assert_eq!(
            choice.note.as_ref(),
            "Atlas · $5 / $30 per 1M · openai/gpt-5.6-sol-az"
        );
        assert!(choice.matches("az"));
        assert!(choice.matches("gpt 5.6"));
        let grok = ModelChoice::new(&option("grok:grok-4.6", "grok", "subscription"));
        assert_eq!(grok.note.as_ref(), "subscription");
    }

    #[test]
    fn the_client_flags_round_trip_only_when_set() {
        let catalog = DescribeModelCatalog {
            atlas_from_before: true,
            ..DescribeModelCatalog::default()
        };
        assert_eq!(
            serde_json::to_value(&catalog).unwrap(),
            serde_json::json!({ "models": [], "atlasFromBefore": true })
        );
    }
}
