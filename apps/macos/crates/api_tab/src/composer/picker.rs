//! Picks one of Atlas's models: one row per model (not per endpoint — the
//! form routes between a family's input shapes itself), a vendor rail, a
//! search box, and stars that float to the top (the web's
//! atlas-model-picker.tsx). The catalogue comes from the composer's rules once
//! per media type and is filtered here, on every keystroke, without a call.
//!
//! Image models get a second level: tabs for what a model starts from (text,
//! images, or a tool), because Atlas's text-to-image and edit endpoints are
//! separate models the form does not route between. Which tab a row is on
//! comes from `atlasImageModes` in packages/shared; the last tab is kept.
//!
//! The filter runs when what it reads changes (the query, the tab, the vendor,
//! the stars), against search text made once per
//! catalogue; the list draws only the rows in view, so scrolling builds a
//! screenful, not the catalogue.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
};

use artsnack_settings::{Preference, Preferences};
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, UniformListScrollHandle, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState},
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    px, uniform_list,
};

use super::{
    engine::{self, Catalog, CatalogRow},
    switcher,
};

pub(crate) fn init(_cx: &mut App) {}

/// The image picker's tab, kept across openings (the web's
/// `artsnack_atlas_image_mode`): an `AtlasImageMode` id, or empty for All.
const IMAGE_MODE: Preference<String> = Preference::new("atlas.picker.imageMode", String::new);

/// A catalogue with each row's search text: what `matchesAtlasQuery` looks
/// in, lower-cased once rather than per keystroke.
struct Indexed {
    catalog: Catalog,
    haystacks: Vec<String>,
}

impl Indexed {
    fn new(catalog: Catalog) -> Self {
        let haystacks = catalog
            .rows
            .iter()
            .map(|row| {
                format!("{} {} {} {}", row.label, row.id, row.vendor, row.family).to_lowercase()
            })
            .collect();
        Self { catalog, haystacks }
    }
}

/// The catalogue per media type, kept for the session: it only changes with
/// an app update.
#[derive(Default)]
struct CatalogCache(RefCell<HashMap<String, Rc<Indexed>>>);

impl gpui_kit::Global for CatalogCache {}

type OnSelect = Rc<dyn Fn(String, &mut Window, &mut App)>;

/// Opens the picker for `media` ("image" | "video"); `on_select` gets the
/// chosen model id after the dialog has closed.
pub(crate) fn open(
    media: String,
    current: String,
    window: &mut Window,
    cx: &mut App,
    on_select: impl Fn(String, &mut Window, &mut App) + 'static,
) {
    let on_select: OnSelect = Rc::new(on_select);
    let picker = cx.new(|cx| AtlasPicker::new(media.clone(), current, on_select, window, cx));
    let title = if media == "video" {
        "Video models on Atlas Cloud"
    } else {
        "Image models on Atlas Cloud"
    };
    picker.read(cx).focus_handle.clone().focus(window, cx);
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title(title).w(px(1100.)).child(picker.clone())
    });
}

pub struct AtlasPicker {
    focus_handle: FocusHandle,
    media: String,
    current: String,
    catalog: Option<Rc<Indexed>>,
    query: Entity<InputState>,
    /// The query as filtered by: trimmed and lower-cased.
    needle: String,
    vendor: Option<String>,
    /// Image models only: the tab, as an `AtlasImageMode` id, or None for All.
    mode: Option<String>,
    /// How many rows each tab would show under the other filters, by mode id;
    /// the empty key is All.
    mode_counts: HashMap<String, usize>,
    /// Rows on the current tab per vendor, for the rail.
    vendor_counts: HashMap<String, usize>,
    /// Rows on the current tab.
    mode_total: usize,
    favorites: Entity<super::stars::AtlasStars>,
    /// The starred ids and keys.
    starred: HashSet<String>,
    /// The rows on screen, as indices into the catalogue, starred first.
    visible: Rc<Vec<usize>>,
    starred_total: usize,
    scroll: UniformListScrollHandle,
    on_select: OnSelect,
    _subscriptions: Vec<Subscription>,
}

impl AtlasPicker {
    fn new(
        media: String,
        current: String,
        on_select: OnSelect,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let query =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search by name, vendor or slug…"));
        let favorites = super::stars::AtlasStars::global(cx);
        let subscriptions = vec![
            cx.subscribe(&query, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.needle = state.read(cx).value().trim().to_lowercase();
                    this.refilter(cx);
                }
            }),
            cx.observe(&favorites, |this, _, cx| {
                this.read_stars(cx);
                this.refilter(cx);
            }),
        ];
        let cached = cx
            .try_global::<CatalogCache>()
            .and_then(|cache| cache.0.borrow().get(&media).cloned());
        let mut this = Self {
            focus_handle: cx.focus_handle(),
            media,
            current,
            catalog: cached,
            query,
            needle: String::new(),
            vendor: None,
            mode: None,
            mode_counts: HashMap::new(),
            vendor_counts: HashMap::new(),
            mode_total: 0,
            favorites,
            starred: HashSet::new(),
            visible: Rc::new(Vec::new()),
            starred_total: 0,
            scroll: UniformListScrollHandle::new(),
            on_select,
            _subscriptions: subscriptions,
        };
        this.read_stars(cx);
        if this.catalog.is_none() {
            this.load(cx);
        } else {
            this.restore_mode(cx);
            this.refilter(cx);
        }
        this
    }

    /// Opens on the tab used last, unless the model in use is not on it: a
    /// picker whose own selection is hidden reads as a lost setting.
    fn restore_mode(&mut self, cx: &App) {
        let Some(indexed) = &self.catalog else {
            return;
        };
        let catalog = &indexed.catalog;
        let remembered = Preferences::get(cx, &IMAGE_MODE);
        let current = catalog
            .rows
            .iter()
            .find(|row| row.id == self.current || row.key == self.current);
        self.mode = (catalog.modes.iter().any(|mode| mode.id == remembered)
            && current.is_none_or(|row| row.modes.contains(&remembered)))
        .then_some(remembered);
    }

    fn choose_mode(&mut self, mode: Option<String>, cx: &mut Context<Self>) {
        Preferences::set(cx, &IMAGE_MODE, mode.clone().unwrap_or_default());
        // A vendor with nothing on the new tab would leave an empty list.
        if let (Some(vendor), Some(indexed)) = (&self.vendor, &self.catalog)
            && !indexed
                .catalog
                .rows
                .iter()
                .any(|row| &row.vendor == vendor && in_mode(row, mode.as_deref()))
        {
            self.vendor = None;
        }
        self.mode = mode;
        self.refilter(cx);
    }

    fn read_stars(&mut self, cx: &App) {
        self.starred = self
            .favorites
            .read(cx)
            .ids()
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default();
    }

    /// Works out the rows on screen; called when what the filter reads
    /// changes, never per frame.
    fn refilter(&mut self, cx: &mut Context<Self>) {
        let Some(indexed) = self.catalog.clone() else {
            return;
        };
        let rows = &indexed.catalog.rows;
        let mode = self.mode.as_deref();
        // Everything but the tab, so each tab can say how many it would show.
        let before_mode: Vec<usize> = (0..rows.len())
            .filter(|ix| {
                let row = &rows[*ix];
                self.vendor
                    .as_ref()
                    .is_none_or(|vendor| &row.vendor == vendor)
                    && (self.needle.is_empty() || indexed.haystacks[*ix].contains(&self.needle))
            })
            .collect();
        let mut mode_counts = HashMap::from([(String::new(), before_mode.len())]);
        for ix in &before_mode {
            for id in &rows[*ix].modes {
                *mode_counts.entry(id.clone()).or_default() += 1;
            }
        }
        // The rail counts what the tab holds.
        let mut vendor_counts = HashMap::new();
        let mut mode_total = 0;
        for row in rows.iter().filter(|row| in_mode(row, mode)) {
            *vendor_counts.entry(row.vendor.clone()).or_default() += 1;
            mode_total += 1;
        }
        // Starred float to the top of whatever is on screen.
        let (starred, rest): (Vec<usize>, Vec<usize>) = before_mode
            .into_iter()
            .filter(|ix| in_mode(&rows[*ix], mode))
            .partition(|ix| self.is_starred(&rows[*ix]));
        self.starred_total = rows.iter().filter(|row| self.is_starred(row)).count();
        self.visible = Rc::new(starred.into_iter().chain(rest).collect());
        self.mode_counts = mode_counts;
        self.vendor_counts = vendor_counts;
        self.mode_total = mode_total;
        cx.notify();
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let media = self.media.clone();
        let task = engine::call::<_, Catalog>(cx, "catalog", (media.clone(),));
        cx.spawn(async move |this, cx| {
            let Ok(catalog) = task.await else {
                return;
            };
            let catalog = Rc::new(Indexed::new(catalog));
            let _ = this.update(cx, |this, cx| {
                cx.default_global::<CatalogCache>()
                    .0
                    .borrow_mut()
                    .insert(media, catalog.clone());
                this.catalog = Some(catalog);
                this.restore_mode(cx);
                this.refilter(cx);
            });
        })
        .detach();
    }

    /// The image tabs: All, then `ATLAS_IMAGE_MODES`, each with how many rows
    /// it would show.
    fn render_modes(&self, catalog: &Catalog, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let muted = cx.theme().muted_foreground;
        let entries: Vec<(Option<String>, String, String)> =
            std::iter::once((None, "All".to_string(), "Every image model".to_string()))
                .chain(
                    catalog
                        .modes
                        .iter()
                        .map(|mode| (Some(mode.id.clone()), mode.label.clone(), mode.hint.clone())),
                )
                .collect();
        // Each button carries its own handler: a group-level `on_click`
        // replaces the buttons' and hears only the mouse, so a tab focused
        // from the keyboard would not switch on Enter (gpui-component 0.8.0's
        // `legacy_keyboard_click_does_not_reach_the_group_callback`).
        let buttons: Vec<Button> = entries
            .into_iter()
            .map(|(id, label, hint)| {
                let count = self
                    .mode_counts
                    .get(id.as_deref().unwrap_or_default())
                    .copied()
                    .unwrap_or(0);
                Button::new(SharedString::from(format!(
                    "atlas-mode-{}",
                    id.as_deref().unwrap_or("all")
                )))
                .flex_1()
                .label(label)
                .selected(self.mode == id)
                .tooltip(hint)
                .child(div().text_color(muted).child(count.to_string()))
                .on_click(cx.listener(move |this, _, _, cx| this.choose_mode(id.clone(), cx)))
            })
            .collect();
        ButtonGroup::new("atlas-modes")
            .small()
            .outline()
            .w_full()
            .children(buttons)
            .into_any_element()
    }

    fn is_starred(&self, row: &CatalogRow) -> bool {
        self.starred.contains(&row.id) || self.starred.contains(&row.key)
    }

    fn select(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        window.close_dialog(cx);
        (self.on_select)(id, window, cx);
    }

    /// One row, of the same height as every other: the list measures one and
    /// places the rest by it.
    fn render_row(&self, row: &CatalogRow, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let selected = row.id == self.current || row.key == self.current;
        let starred = self.is_starred(row);
        let (select_id, star_id, star_label) = (row.id.clone(), row.id.clone(), row.label.clone());
        h_flex()
            .gap_1()
            .rounded(theme.radius)
            .when(selected, |this| this.bg(theme.accent))
            .hover(|style| style.bg(theme.accent))
            .child(
                h_flex()
                    .id(SharedString::from(format!("atlas-row-{}", row.key)))
                    .flex_1()
                    .min_w_0()
                    .gap_3()
                    .px_2()
                    .py_2()
                    .cursor_pointer()
                    .child(div().w_4().flex_shrink_0().when(selected, |this| {
                        this.child(Icon::new(IconName::Check).small())
                    }))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .gap_x_2()
                                    .child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .text_sm()
                                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                                            .child(row.label.clone()),
                                    )
                                    .when(row.variants.len() > 1, |this| {
                                        this.child(
                                            div()
                                                .flex_shrink_0()
                                                .text_xs()
                                                .text_color(theme.muted_foreground)
                                                .child(row.variants.join(" · ")),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .mt_0p5()
                                    .truncate()
                                    .font_family(theme.mono_font_family.clone())
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(row.key.clone()),
                            ),
                    )
                    .child(
                        v_flex()
                            .flex_shrink_0()
                            .items_end()
                            .text_xs()
                            .child(
                                h_flex().child(row.price_text.clone()).child(
                                    div()
                                        .text_color(theme.muted_foreground)
                                        .child(row.price_unit.clone()),
                                ),
                            )
                            .child(
                                div()
                                    .text_color(theme.muted_foreground)
                                    .child(row.input_label.clone()),
                            ),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select(select_id.clone(), window, cx)
                    })),
            )
            .child(
                Button::new(SharedString::from(format!("atlas-star-{}", row.key)))
                    .ghost()
                    .small()
                    .icon(
                        Icon::new(IconName::Star)
                            .when(starred, |icon| icon.text_color(theme.warning)),
                    )
                    .tooltip(if starred {
                        "Unstar"
                    } else {
                        "Star for one-click access"
                    })
                    .on_click(move |_, _, cx| {
                        switcher::toggle_star(star_id.clone(), star_label.clone(), None, cx)
                    }),
            )
    }
}

/// Whether `row` is on the tab `mode` (None is All).
fn in_mode(row: &CatalogRow, mode: Option<&str>) -> bool {
    mode.is_none_or(|mode| row.modes.iter().any(|id| id == mode))
}

impl Focusable for AtlasPicker {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for AtlasPicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let Some(indexed) = self.catalog.clone() else {
            return v_flex()
                .h(px(480.))
                .items_center()
                .justify_center()
                .child(Spinner::new())
                .into_any_element();
        };
        let catalog = &indexed.catalog;
        let starred_total = self.starred_total;
        let count = self.visible.len();
        let plural = if count == 1 { "" } else { "s" };
        let footer = if catalog.modes.is_empty() {
            format!(
                "{count} model{plural}. Prices are per second. Which input shape runs — text, first frame, or a reference list — follows what you attach."
            )
        } else {
            // What the tab holds, since a model can be on two of them.
            let entry = self
                .mode
                .as_ref()
                .and_then(|id| catalog.modes.iter().find(|mode| &mode.id == id));
            let noun = entry.map_or("model", |mode| mode.noun.as_str());
            let hint = entry
                .map(|mode| format!(" {}.", mode.hint))
                .unwrap_or_default();
            format!("{count} {noun}{plural}.{hint} Prices are per image.")
        };
        let query = self.needle.clone();
        let rows = {
            let (visible, indexed) = (self.visible.clone(), indexed.clone());
            uniform_list(
                "atlas-rows",
                count,
                cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                    range
                        .filter_map(|ix| visible.get(ix))
                        .map(|&row| {
                            this.render_row(&indexed.catalog.rows[row], cx)
                                .into_any_element()
                        })
                        .collect::<Vec<_>>()
                }),
            )
            .track_scroll(&self.scroll)
            .flex_1()
            .min_w_0()
            .h_full()
            .p_2()
        };

        let rail_button = |id: SharedString, label: String, count: usize, active: bool| {
            h_flex()
                .id(id)
                .justify_between()
                .gap_2()
                .px_3()
                .py_1p5()
                .text_sm()
                .cursor_pointer()
                .hover(|style| style.bg(theme.accent))
                .when(active, |this| {
                    this.bg(theme.accent)
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                })
                .child(div().min_w_0().truncate().child(label))
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(count.to_string()),
                )
        };
        let modes = (!catalog.modes.is_empty()).then(|| self.render_modes(catalog, cx));
        // The catalogue's own vendor order, so switching tabs does not
        // reshuffle the rail; a vendor with nothing on the tab is left out.
        let vendors = catalog
            .vendors
            .iter()
            .filter(|vendor| {
                self.vendor_counts.contains_key(&vendor.name)
                    || self.vendor.as_deref() == Some(vendor.name.as_str())
            })
            .map(|vendor| {
                let name = vendor.name.clone();
                rail_button(
                    SharedString::from(format!("vendor-{}", vendor.name)),
                    vendor.name.clone(),
                    self.vendor_counts.get(&vendor.name).copied().unwrap_or(0),
                    self.vendor.as_deref() == Some(vendor.name.as_str()),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.vendor = Some(name.clone());
                    this.refilter(cx);
                }))
            });

        v_flex()
            .id("atlas-picker")
            .track_focus(&self.focus_handle)
            .gap_3()
            .child(
                h_flex().gap_2().child(
                    div()
                        .flex_1()
                        .child(Input::new(&self.query).prefix(Icon::new(IconName::Search).small())),
                ),
            )
            .children(modes)
            .child(
                h_flex()
                    .h(px(520.))
                    .min_w_0()
                    .border_t_1()
                    .border_color(theme.border)
                    .child(
                        v_flex()
                            .id("atlas-vendors")
                            .w(px(200.))
                            .flex_shrink_0()
                            .h_full()
                            .overflow_y_scroll()
                            .py_2()
                            .border_r_1()
                            .border_color(theme.border)
                            .child(
                                rail_button(
                                    "vendor-all".into(),
                                    "All models".into(),
                                    self.mode_total,
                                    self.vendor.is_none(),
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.vendor = None;
                                        this.refilter(cx);
                                    },
                                )),
                            )
                            .when(starred_total > 0, |this| {
                                this.child(
                                    div()
                                        .px_3()
                                        .pt_3()
                                        .pb_1()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(format!("{starred_total} starred, shown first")),
                                )
                            })
                            .child(
                                div()
                                    .mt_1()
                                    .pt_1()
                                    .border_t_1()
                                    .border_color(theme.border)
                                    .children(vendors),
                            ),
                    )
                    .map(|this| {
                        if count == 0 {
                            this.child(
                                div()
                                    .flex_1()
                                    .py_12()
                                    .text_center()
                                    .text_sm()
                                    .text_color(theme.muted_foreground)
                                    .child(if query.is_empty() {
                                        "Nothing matches these filters.".to_string()
                                    } else {
                                        format!("Nothing matches \u{201c}{query}\u{201d}.")
                                    }),
                            )
                        } else {
                            this.child(rows)
                        }
                    }),
            )
            .child(
                div()
                    .pt_2()
                    .border_t_1()
                    .border_color(theme.border)
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(footer),
            )
            .into_any_element()
    }
}
