//! The Filters drawer (the web's `SearchFiltersButton` drawer).
//!
//! Edits go to a draft and apply only on "Show N results", where N is a live
//! count of what the draft would show — counted on the background executor,
//! a newer draft cancelling an older count, and only while the drawer is open.
//! Facet values and their counts come from the documents whose text matched,
//! so a filter never hides its own alternatives.
//!
//! Every long group can be searched, and what is selected always shows: a
//! selected value past a group's first 24, a selected provider parameter past
//! the 20 groups or 40 values a closed set may have, and a selected group the
//! current matches no longer count at all.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use artsnack_backend::api::{
    favorites::MediaType,
    search_catalog::{SearchSource, js_number},
};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    FontWeight, IntoElement, ParentElement as _, Render, SharedString, Styled as _, Subscription,
    Task, WeakEntity, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Selectable as _, Sizable as _,
        button::{Button, ButtonGroup, ButtonVariants as _},
        checkbox::Checkbox,
        h_flex,
        input::{Input, InputEvent, InputState},
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

use crate::{
    catalog::SearchCatalog,
    engine::{
        FacetValue, LoraMode, NON_FACET_SEARCH_PARAMETERS, Orientation, SearchFacets,
        SearchFilters, SearchIntent, count_search_matches_until, parse_search_query,
    },
    format::thousands,
    time::{day_bound, day_text},
    view::SearchView,
};

/// Values a group shows before its find field narrows them.
const SHOWN_VALUES: usize = 24;
/// Values a group shows while its find field holds text.
const SHOWN_FOUND_VALUES: usize = 80;
/// A group grows a find field past this many values.
const FIND_AFTER: usize = 10;
/// Parameters with more values than this are free-form, not filters.
const MAX_PARAMETER_VALUES: usize = 40;
const MAX_PARAMETER_GROUPS: usize = 20;

pub enum FilterDrawerEvent {
    Apply {
        filters: SearchFilters,
        negative_prompt_query: String,
    },
}

/// A facet group of the draft.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Group {
    MediaTypes,
    Sources,
    Providers,
    ModelFamilies,
    Models,
    Checkpoints,
    Loras,
    Orientations,
    Resolutions,
    Qualities,
    Samplers,
    Schedulers,
    Parameter(String),
}

impl Group {
    pub(crate) fn id(&self) -> String {
        match self {
            Group::Parameter(name) => format!("parameter-{name}"),
            other => format!("{other:?}").to_lowercase(),
        }
    }

    pub(crate) fn title(&self) -> String {
        match self {
            Group::MediaTypes => "Media".into(),
            Group::Sources => "Source".into(),
            Group::Providers => "Provider".into(),
            Group::ModelFamilies => "Model family".into(),
            Group::Models => "Exact API model".into(),
            Group::Checkpoints => "Checkpoint".into(),
            Group::Loras => "LoRA".into(),
            Group::Orientations => "Orientation".into(),
            Group::Resolutions => "Resolution".into(),
            Group::Qualities => "Quality".into(),
            Group::Samplers => "Sampler".into(),
            Group::Schedulers => "Scheduler".into(),
            Group::Parameter(name) => humanize(name),
        }
    }

    /// The selected values, as the strings facets show.
    pub(crate) fn selected(&self, filters: &SearchFilters) -> Vec<String> {
        match self {
            Group::MediaTypes => filters
                .media_types
                .iter()
                .map(|media| media_name(*media).to_string())
                .collect(),
            Group::Sources => filters
                .sources
                .iter()
                .map(|source| source.as_str().to_string())
                .collect(),
            Group::Orientations => filters
                .orientations
                .iter()
                .map(|orientation| orientation.as_str().to_string())
                .collect(),
            Group::Parameter(name) => filters.parameters.get(name).cloned().unwrap_or_default(),
            other => other.list(filters).cloned().unwrap_or_default(),
        }
    }

    fn list<'a>(&self, filters: &'a SearchFilters) -> Option<&'a Vec<String>> {
        Some(match self {
            Group::Providers => &filters.providers,
            Group::ModelFamilies => &filters.model_families,
            Group::Models => &filters.models,
            Group::Checkpoints => &filters.checkpoints,
            Group::Loras => &filters.loras,
            Group::Resolutions => &filters.resolutions,
            Group::Qualities => &filters.qualities,
            Group::Samplers => &filters.samplers,
            Group::Schedulers => &filters.schedulers,
            _ => return None,
        })
    }

    fn list_mut<'a>(&self, filters: &'a mut SearchFilters) -> Option<&'a mut Vec<String>> {
        Some(match self {
            Group::Providers => &mut filters.providers,
            Group::ModelFamilies => &mut filters.model_families,
            Group::Models => &mut filters.models,
            Group::Checkpoints => &mut filters.checkpoints,
            Group::Loras => &mut filters.loras,
            Group::Resolutions => &mut filters.resolutions,
            Group::Qualities => &mut filters.qualities,
            Group::Samplers => &mut filters.samplers,
            Group::Schedulers => &mut filters.schedulers,
            Group::Parameter(name) => filters.parameters.entry(name.clone()).or_default(),
            _ => return None,
        })
    }

    pub(crate) fn toggle(&self, filters: &mut SearchFilters, value: &str) {
        match self {
            Group::MediaTypes => {
                if let Some(media) = media_from(value) {
                    toggle_in(&mut filters.media_types, media);
                }
            }
            Group::Sources => {
                if let Some(source) = SearchSource::ALL
                    .into_iter()
                    .find(|source| source.as_str() == value)
                {
                    toggle_in(&mut filters.sources, source);
                }
            }
            Group::Orientations => {
                if let Some(orientation) = Orientation::ALL
                    .into_iter()
                    .find(|orientation| orientation.as_str() == value)
                {
                    toggle_in(&mut filters.orientations, orientation);
                }
            }
            other => {
                if let Some(list) = other.list_mut(filters) {
                    toggle_in(list, value.to_string());
                }
                if let Group::Parameter(name) = other
                    && filters.parameters.get(name).is_some_and(Vec::is_empty)
                {
                    filters.parameters.remove(name);
                }
            }
        }
    }

    fn clear(&self, filters: &mut SearchFilters) {
        match self {
            Group::MediaTypes => filters.media_types.clear(),
            Group::Sources => filters.sources.clear(),
            Group::Orientations => filters.orientations.clear(),
            Group::Parameter(name) => {
                filters.parameters.remove(name);
            }
            other => {
                if let Some(list) = other.list_mut(filters) {
                    list.clear();
                }
            }
        }
    }
}

fn toggle_in<T: PartialEq>(list: &mut Vec<T>, value: T) {
    match list.iter().position(|entry| *entry == value) {
        Some(ix) => {
            list.remove(ix);
        }
        None => list.push(value),
    }
}

fn media_name(media: MediaType) -> &'static str {
    match media {
        MediaType::Image => "image",
        MediaType::Video => "video",
    }
}

fn media_from(value: &str) -> Option<MediaType> {
    match value {
        "image" => Some(MediaType::Image),
        "video" => Some(MediaType::Video),
        _ => None,
    }
}

/// A numeric bound of the draft, typed into a field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Bound {
    StepsMin,
    StepsMax,
    CfgMin,
    CfgMax,
    DurationMin,
    DurationMax,
    Seed,
    WidthMin,
    WidthMax,
    HeightMin,
    HeightMax,
}

impl Bound {
    const ALL: [Bound; 11] = [
        Bound::StepsMin,
        Bound::StepsMax,
        Bound::CfgMin,
        Bound::CfgMax,
        Bound::DurationMin,
        Bound::DurationMax,
        Bound::Seed,
        Bound::WidthMin,
        Bound::WidthMax,
        Bound::HeightMin,
        Bound::HeightMax,
    ];

    fn slot(self, filters: &mut SearchFilters) -> &mut Option<f64> {
        match self {
            Bound::StepsMin => &mut filters.steps_min,
            Bound::StepsMax => &mut filters.steps_max,
            Bound::CfgMin => &mut filters.cfg_min,
            Bound::CfgMax => &mut filters.cfg_max,
            Bound::DurationMin => &mut filters.duration_min,
            Bound::DurationMax => &mut filters.duration_max,
            Bound::Seed => &mut filters.seed,
            Bound::WidthMin => &mut filters.width_min,
            Bound::WidthMax => &mut filters.width_max,
            Bound::HeightMin => &mut filters.height_min,
            Bound::HeightMax => &mut filters.height_max,
        }
    }

    fn placeholder(self) -> &'static str {
        match self {
            Bound::Seed => "Any",
            Bound::StepsMin
            | Bound::CfgMin
            | Bound::DurationMin
            | Bound::WidthMin
            | Bound::HeightMin => "Min",
            _ => "Max",
        }
    }
}

/// A number being typed: digits, one point, a leading minus.
fn is_number_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    digits.chars().all(|c| c.is_ascii_digit() || c == '.') && digits.matches('.').count() <= 1
}

/// The web's `optionalNumber`: empty or unreadable is no bound.
fn parse_bound(text: &str) -> Option<f64> {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

/// `steps_cfg` → "Steps Cfg".
fn humanize(name: &str) -> String {
    name.split(['_', '-'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub struct FilterDrawer {
    focus_handle: FocusHandle,
    /// Read for live facets while drawing; never during the view's own update.
    view: WeakEntity<SearchView>,
    catalog: Entity<SearchCatalog>,
    /// The search the drawer was opened over: its query, typos and sort
    /// count with the draft.
    base: SearchIntent,
    draft: SearchFilters,
    negative: Entity<InputState>,
    finds: HashMap<Group, Entity<InputState>>,
    bounds: Vec<(Bound, Entity<InputState>)>,
    from: Entity<InputState>,
    to: Entity<InputState>,
    /// What the draft would show; the last count while a newer one runs.
    count: Option<usize>,
    /// The newest count asked for; an older count still running gives up.
    count_generation: Arc<AtomicU64>,
    _count: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<FilterDrawerEvent> for FilterDrawer {}

impl FilterDrawer {
    pub fn new(
        view: WeakEntity<SearchView>,
        catalog: Entity<SearchCatalog>,
        intent: &SearchIntent,
        facets: &SearchFacets,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let draft = intent.filters.clone();
        let mut subscriptions = vec![cx.observe(&catalog, |this, _, cx| this.recount(cx))];

        let negative = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("e.g. blurry, -\"bad hands\"")
                .default_value(intent.negative_prompt_query.clone())
        });
        subscriptions.push(cx.subscribe(&negative, |this, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                this.recount(cx);
                cx.notify();
            }
        }));

        // Find fields for the groups that can be long; a parameter that grows
        // past the threshold while the drawer is open goes without one.
        let mut finds = HashMap::new();
        let searchable = [
            Group::ModelFamilies,
            Group::Models,
            Group::Checkpoints,
            Group::Loras,
            Group::Resolutions,
            Group::Qualities,
            Group::Samplers,
            Group::Schedulers,
        ]
        .into_iter()
        .chain(
            facets
                .parameters
                .iter()
                .filter(|(_, values)| values.len() > FIND_AFTER)
                .map(|(name, _)| Group::Parameter(name.clone())),
        );
        for group in searchable {
            let placeholder = format!("Find {}\u{2026}", group.title().to_lowercase());
            let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
            subscriptions.push(cx.subscribe(&input, |_, _, event, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }));
            finds.insert(group, input);
        }

        let mut bounds = Vec::new();
        for bound in Bound::ALL {
            let mut filters = draft.clone();
            let value = bound.slot(&mut filters).map(js_number).unwrap_or_default();
            let input = cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(bound.placeholder())
                    .validate(|text, _| is_number_text(text))
                    .default_value(value)
            });
            subscriptions.push(cx.subscribe(&input, move |this, input, event, cx| {
                if matches!(event, InputEvent::Change) {
                    let value = parse_bound(&input.read(cx).value());
                    *bound.slot(&mut this.draft) = value;
                    this.recount(cx);
                    cx.notify();
                }
            }));
            bounds.push((bound, input));
        }

        let date = |value: Option<f64>, end: bool, window: &mut Window, cx: &mut Context<Self>| {
            let input = cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("YYYY-MM-DD")
                    .validate(|text, _| {
                        text.len() <= 10 && text.chars().all(|c| c.is_ascii_digit() || c == '-')
                    })
                    .default_value(value.and_then(day_text).unwrap_or_default())
            });
            let subscription = cx.subscribe(&input, move |this: &mut Self, input, event, cx| {
                if matches!(event, InputEvent::Change) {
                    let bound = day_bound(&input.read(cx).value(), end);
                    if end {
                        this.draft.created_before = bound;
                    } else {
                        this.draft.created_after = bound;
                    }
                    this.recount(cx);
                    cx.notify();
                }
            });
            (input, subscription)
        };
        let (from, from_subscription) = date(draft.created_after, false, window, cx);
        let (to, to_subscription) = date(draft.created_before, true, window, cx);
        subscriptions.extend([from_subscription, to_subscription]);

        let mut this = Self {
            focus_handle: cx.focus_handle(),
            view,
            catalog,
            base: intent.clone(),
            draft,
            negative,
            finds,
            bounds,
            from,
            to,
            count: None,
            count_generation: Arc::new(AtomicU64::new(0)),
            _count: None,
            _subscriptions: subscriptions,
        };
        this.recount(cx);
        this
    }

    fn negative_text(&self, cx: &App) -> String {
        self.negative.read(cx).value().to_string()
    }

    /// Counts the draft on the background executor. A newer draft makes the
    /// running count give up at its next checkpoint.
    fn recount(&mut self, cx: &mut Context<Self>) {
        let intent = SearchIntent {
            filters: self.draft.clone(),
            negative_prompt_query: self.negative_text(cx),
            ..self.base.clone()
        };
        let documents = self.catalog.read(cx).documents().clone();
        let generation = self.count_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let latest = self.count_generation.clone();
        let count = cx.background_spawn(async move {
            count_search_matches_until(&documents, &intent, || {
                latest.load(Ordering::Relaxed) != generation
            })
        });
        self._count = Some(cx.spawn(async move |this, cx| {
            if let Some(count) = count.await {
                let _ = this.update(cx, |this, cx| {
                    this.count = Some(count);
                    cx.notify();
                });
            }
        }));
    }

    fn update_draft(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut SearchFilters)) {
        change(&mut self.draft);
        self.recount(cx);
        cx.notify();
    }

    /// Clear all: an empty draft and no negative query, applied only with Show.
    pub fn clear_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.draft = SearchFilters::default();
        for (_, input) in &self.bounds {
            input.update(cx, |input, cx| input.set_value("", window, cx));
        }
        for input in [&self.from, &self.to, &self.negative] {
            input.update(cx, |input, cx| input.set_value("", window, cx));
        }
        self.recount(cx);
        cx.notify();
    }

    pub fn apply(&mut self, cx: &mut Context<Self>) {
        cx.emit(FilterDrawerEvent::Apply {
            filters: self.draft.clone(),
            negative_prompt_query: self.negative_text(cx),
        });
    }

    /// "Show 1,234 results", or "Show results" until the first count lands.
    pub fn show_label(&self) -> String {
        match self.count {
            Some(1) => "Show 1 result".into(),
            Some(count) => format!("Show {} results", thousands(count)),
            None => "Show results".into(),
        }
    }

    // --- Rendering ------------------------------------------------------

    fn section_title(title: impl Into<SharedString>) -> impl IntoElement {
        div()
            .text_sm()
            .font_weight(FontWeight::MEDIUM)
            .child(title.into())
    }

    /// One facet group: its title and Clear, a find field when it is long,
    /// and a chip per value. A selected value stays listed after its count
    /// falls out of the top values, or out of the facets altogether, so it
    /// can be cleared.
    fn render_group(
        &self,
        group: Group,
        values: &[FacetValue],
        show_counts: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let selected = group.selected(&self.draft);
        if values.is_empty() && selected.is_empty() {
            return None;
        }
        let find = self
            .finds
            .get(&group)
            .filter(|_| values.len() > FIND_AFTER)
            .cloned();
        let needle = find
            .as_ref()
            .map(|input| input.read(cx).value().to_lowercase())
            .unwrap_or_default();
        let limit = if needle.is_empty() {
            SHOWN_VALUES
        } else {
            SHOWN_FOUND_VALUES
        };
        let mut shown: Vec<(String, Option<usize>)> = values
            .iter()
            .filter(|facet| needle.is_empty() || facet.value.to_lowercase().contains(&needle))
            .take(limit)
            .map(|facet| (facet.value.clone(), Some(facet.count)))
            .collect();
        for value in &selected {
            if !shown.iter().any(|(shown, _)| shown == value) {
                let count = values
                    .iter()
                    .find(|facet| &facet.value == value)
                    .map(|facet| facet.count);
                shown.push((value.clone(), count));
            }
        }

        let group_id = group.id();
        let clear_group = group.clone();
        Some(
            v_flex()
                .gap_2()
                .child(
                    h_flex()
                        .justify_between()
                        .child(Self::section_title(group.title()))
                        .when(!selected.is_empty(), |this| {
                            this.child(
                                Button::new(SharedString::from(format!("clear-{group_id}")))
                                    .ghost()
                                    .xsmall()
                                    .label("Clear")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        let group = clear_group.clone();
                                        this.update_draft(cx, |draft| group.clear(draft));
                                    })),
                            )
                        }),
                )
                .when_some(find, |this, find| {
                    this.child(
                        Input::new(&find)
                            .small()
                            .prefix(Icon::new(IconName::Search).small()),
                    )
                })
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_1p5()
                        .children(shown.into_iter().map(|(value, count)| {
                            let active = selected.contains(&value);
                            let label = match count.filter(|_| show_counts) {
                                Some(count) => format!("{value}  {}", thousands(count)),
                                None => value.clone(),
                            };
                            let group = group.clone();
                            Button::new(SharedString::from(format!("{group_id}-{value}")))
                                .xsmall()
                                .max_w_full()
                                .when(active, |button| button.primary())
                                .when(!active, |button| button.outline())
                                .selected(active)
                                .label(label)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let group = group.clone();
                                    let value = value.clone();
                                    this.update_draft(cx, |draft| group.toggle(draft, &value));
                                }))
                        })),
                )
                .into_any_element(),
        )
    }

    fn bound_input(&self, bound: Bound) -> Option<&Entity<InputState>> {
        self.bounds
            .iter()
            .find(|(candidate, _)| *candidate == bound)
            .map(|(_, input)| input)
    }

    /// A labelled min/max pair.
    fn render_range(&self, label: &'static str, min: Bound, max: Bound) -> impl IntoElement {
        let field = |bound: Bound| {
            div().flex_1().min_w_0().children(
                self.bound_input(bound)
                    .map(|input| Input::new(input).small()),
            )
        };
        v_flex()
            .flex_1()
            .min_w_0()
            .gap_1()
            .child(div().text_xs().child(label))
            .child(h_flex().gap_1().child(field(min)).child(field(max)))
    }

    fn render_references(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = match self.draft.has_references {
            None => 0,
            Some(true) => 1,
            Some(false) => 2,
        };
        v_flex()
            .gap_2()
            .child(Self::section_title("Generated with references"))
            .child(
                ButtonGroup::new("has-references")
                    .small()
                    .outline()
                    .child(
                        Button::new("references-any")
                            .label("Any")
                            .selected(selected == 0),
                    )
                    .child(
                        Button::new("references-yes")
                            .label("Yes")
                            .selected(selected == 1),
                    )
                    .child(
                        Button::new("references-no")
                            .label("No")
                            .selected(selected == 2),
                    )
                    .on_click(cx.listener(|this, chosen: &Vec<usize>, _, cx| {
                        let value = match chosen.first() {
                            Some(1) => Some(true),
                            Some(2) => Some(false),
                            _ => None,
                        };
                        this.update_draft(cx, |draft| draft.has_references = value);
                    })),
            )
    }

    fn render_advanced(&self, facets: &SearchFacets, cx: &mut Context<Self>) -> impl IntoElement {
        let negative_error = parse_search_query(&self.negative_text(cx))
            .err()
            .map(|error| error.message);
        let orientations: Vec<FacetValue> = Orientation::ALL
            .into_iter()
            .map(|orientation| FacetValue {
                value: orientation.as_str().into(),
                count: 0,
            })
            .collect();

        // Up to 20 provider parameters with a short, closed set of values,
        // the most used first; then any other parameter with a selection.
        let mut parameters: Vec<(&String, &[FacetValue])> = facets
            .parameters
            .iter()
            .filter(|(name, values)| {
                !NON_FACET_SEARCH_PARAMETERS.contains(&name.as_str())
                    && !values.is_empty()
                    && values.len() <= MAX_PARAMETER_VALUES
            })
            .map(|(name, values)| (name, values.as_slice()))
            .collect();
        parameters.sort_by_key(|(_, values)| {
            std::cmp::Reverse(values.iter().map(|facet| facet.count).sum::<usize>())
        });
        parameters.truncate(MAX_PARAMETER_GROUPS);
        for name in self.draft.parameters.keys() {
            if !parameters.iter().any(|(shown, _)| *shown == name) {
                let values = facets.parameters.get(name).map_or(&[][..], Vec::as_slice);
                parameters.push((name, values));
            }
        }

        let muted = cx.theme().muted_foreground;
        v_flex()
            .gap_5()
            .pt_4()
            .border_t_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Advanced"),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(Self::section_title("Search stored negative prompt"))
                    .child(Input::new(&self.negative).small())
                    .child(match negative_error {
                        Some(error) => div().text_xs().text_color(cx.theme().danger).child(error),
                        None => div().text_xs().text_color(muted).child(
                            "Separate from the positive prompt. The same query syntax applies.",
                        ),
                    }),
            )
            .children(self.render_group(Group::Orientations, &orientations, false, cx))
            .children(self.render_group(Group::Resolutions, &facets.resolutions, true, cx))
            .children(self.render_group(Group::Qualities, &facets.qualities, true, cx))
            .children(self.render_group(Group::Samplers, &facets.samplers, true, cx))
            .children(self.render_group(Group::Schedulers, &facets.schedulers, true, cx))
            .child(
                h_flex()
                    .items_start()
                    .gap_3()
                    .child(self.render_range("Steps", Bound::StepsMin, Bound::StepsMax))
                    .child(self.render_range("CFG", Bound::CfgMin, Bound::CfgMax)),
            )
            .child(
                h_flex()
                    .items_start()
                    .gap_3()
                    .child(self.render_range(
                        "Video seconds",
                        Bound::DurationMin,
                        Bound::DurationMax,
                    ))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_1()
                            .child(div().text_xs().child("Exact seed"))
                            .children(
                                self.bound_input(Bound::Seed)
                                    .map(|input| Input::new(input).small()),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .items_start()
                    .gap_3()
                    .child(self.render_range("Width", Bound::WidthMin, Bound::WidthMax))
                    .child(self.render_range("Height", Bound::HeightMin, Bound::HeightMax)),
            )
            .children(parameters.into_iter().filter_map(|(name, values)| {
                self.render_group(Group::Parameter(name.clone()), values, true, cx)
            }))
            .child(self.render_references(cx))
            .child(
                v_flex()
                    .gap_1()
                    .child(Self::section_title("Created"))
                    .child(
                        h_flex()
                            .gap_3()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .gap_1()
                                    .child(div().text_xs().child("From"))
                                    .child(Input::new(&self.from).small()),
                            )
                            .child(
                                v_flex()
                                    .flex_1()
                                    .gap_1()
                                    .child(div().text_xs().child("To"))
                                    .child(Input::new(&self.to).small()),
                            ),
                    ),
            )
    }
}

impl Focusable for FilterDrawer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for FilterDrawer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let facets = self
            .view
            .upgrade()
            .map(|view| view.read(cx).facets())
            .unwrap_or_default();
        let require_all = self.draft.lora_mode == LoraMode::All;
        v_flex()
            .gap_6()
            .py_4()
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(
                        "Counts come from your own history, including retired models, checkpoints and LoRAs.",
                    ),
            )
            .children(self.render_group(Group::MediaTypes, &facets.media_types, true, cx))
            .children(self.render_group(Group::Sources, &facets.sources, true, cx))
            .children(self.render_group(
                Group::Providers,
                &facets.providers,
                true,
                cx,
            ))
            .children(self.render_group(
                Group::ModelFamilies,
                &facets.model_families,
                true,
                cx,
            ))
            .children(self.render_group(
                Group::Models,
                &facets.models,
                true,
                cx,
            ))
            .children(self.render_group(
                Group::Checkpoints,
                &facets.checkpoints,
                true,
                cx,
            ))
            .children(self.render_group(Group::Loras, &facets.loras, true, cx))
            .when(self.draft.loras.len() > 1, |this| {
                this.child(
                    Checkbox::new("require-all-loras")
                        .label("Require all selected LoRAs")
                        .checked(require_all)
                        .on_click(cx.listener(|this, checked: &bool, _, cx| {
                            let mode = if *checked { LoraMode::All } else { LoraMode::Any };
                            this.update_draft(cx, |draft| draft.lora_mode = mode);
                        })),
                )
            })
            .child(self.render_advanced(&facets, cx))
    }
}
