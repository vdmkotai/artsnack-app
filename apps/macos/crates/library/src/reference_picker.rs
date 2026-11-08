//! Choose an image already in the app — a favourite, a self-hosted image or
//! an API result — as a reference, or as a picture to describe (the web's
//! `ReferencePicker`).
//!
//! - Favorites open first and are the point of the picker: the useful image
//!   is almost always one already hearted, and the same folder chips that
//!   scope Favorites scope this grid.
//! - Each source is its own paginated subscription, made the first time it is
//!   shown and kept while the picker is open, so switching back is instant;
//!   rows remembered from an earlier opening show at once.
//! - Only the rows on screen exist as elements, and the next page is asked
//!   for once the last rows are laid out — so a first page shorter than the
//!   dialog still loads more, as the web's sentinel does.
//! - Each source's image keys are worked out when its rows (or the folder)
//!   change, not when the picker draws: the dialog draws on every frame of
//!   the screen under it. A source not shown changes nothing on screen.

use std::{cell::Cell, collections::HashSet, rc::Rc};

use artsnack_backend::{
    LivePaginatedQuery, LiveQuery, NoArgs, PaginationStatus,
    api::{
        favorites::{self, Favorite, FavoriteFilter, Folders, MediaType},
        generations::{self, Generation, GenerationStatus},
        grok_generations::{self, ApiGeneration},
    },
};
use artsnack_media::{ImageRequest, Media, MediaUrls, media_image};
use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, InteractiveElement as _,
    IntoElement, ObjectFit, ParentElement as _, Pixels, Render, ScrollStrategy, SharedString,
    Styled as _, StyledImage as _, Subscription, UniformListScrollHandle, WeakEntity, Window,
    assets::IconName,
    canvas,
    component::{
        ActiveTheme as _, Icon, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariants as _},
        h_flex,
        scroll::ScrollableElement as _,
        spinner::Spinner,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
    px, rems, uniform_list,
};

/// The image the user picked.
#[derive(Clone, Debug, PartialEq)]
pub struct PickedImage {
    /// The original on the media CDN.
    pub url: SharedString,
    /// Its object key, which links a reference back to the job that made it.
    pub b2_key: String,
}

/// Rows per page, as the web asks.
const PAGE_SIZE: usize = 40;
/// The web's grid: three columns on a phone, seven on a wide screen.
const MIN_COLUMNS: usize = 3;
const MAX_COLUMNS: usize = 7;
/// The width a tile aims for; the column count follows the grid's width.
const TILE_REMS: f32 = 9.;
/// Between tiles and between rows. Rows render it with `gap_2` and `pb_2`.
const GAP_REMS: f32 = 0.5;
/// The rows' horizontal inset, inside the scroll owner so the scrollbar sits
/// at the dialog's edge. Rows render it with `px_4`, as the dialog insets its
/// title (see [`open_reference_picker`]).
const INSET_REMS: f32 = 1.;
/// The next page is asked for when a row this close to the end is laid out.
const NEAR_END_ROWS: usize = 2;
/// The web's `max-w-6xl`, and 85 % of the window's height.
const DIALOG_WIDTH_REMS: f32 = 72.;
const DIALOG_HEIGHT: f32 = 0.85;
/// Thumbnails are 256 px transformations; never decode them larger.
const THUMB_DECODE_PIXELS: u32 = 256;

/// Opens the picker over the window; `on_pick` runs once with the chosen
/// image, after the picker has closed. Escape, the close button and a click
/// outside close it without a pick.
pub fn open_reference_picker(
    window: &mut Window,
    cx: &mut App,
    on_pick: impl Fn(PickedImage, &mut Window, &mut App) + 'static,
) {
    let picker = cx.new(|cx| ReferencePicker::new(Rc::new(on_pick), cx));
    window.open_dialog(cx, move |dialog, window, _| {
        let picker = picker.clone();
        dialog
            .title("Choose an image")
            // The dialog's inset in rems rather than its fixed 16 px, so the
            // picker's rows can share it while the grid's scrollbar runs
            // along the dialog's edge (the content itself is not inset).
            .px_4()
            .w(window.rem_size() * DIALOG_WIDTH_REMS)
            .h(window.viewport_size().height * DIALOG_HEIGHT)
            .content(move |content, _, _| content.px_0().child(picker.clone()))
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    Favorites,
    SelfHosted,
    Api,
}

impl Source {
    const ALL: [Self; 3] = [Self::Favorites, Self::SelfHosted, Self::Api];

    fn ix(self) -> usize {
        match self {
            Self::Favorites => 0,
            Self::SelfHosted => 1,
            Self::Api => 2,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Favorites => "Favorites",
            Self::SelfHosted => "Self-hosted",
            // Not "Grok": the tab covers every hosted provider.
            Self::Api => "API",
        }
    }
}

type PickHandler = Rc<dyn Fn(PickedImage, &mut Window, &mut App)>;

/// The tile geometry for one grid width, in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct GridLayout {
    columns: usize,
    tile: f32,
}

impl GridLayout {
    /// `None` until the grid has been measured.
    fn new(width: f32, rem: f32) -> Option<Self> {
        let inner = width - INSET_REMS * rem * 2.0;
        if inner <= 0.0 || rem <= 0.0 {
            return None;
        }
        let gap = GAP_REMS * rem;
        let fit = ((inner + gap) / (TILE_REMS * rem + gap)).floor() as usize;
        let columns = fit.clamp(MIN_COLUMNS, MAX_COLUMNS);
        let tile = (inner - gap * (columns - 1) as f32) / columns as f32;
        (tile > 0.0).then_some(Self { columns, tile })
    }
}

/// The favourites query for a folder: images only — clips are favourited
/// alongside stills, and a reference has to be a picture.
fn favorite_filter(folder: Option<String>) -> FavoriteFilter {
    FavoriteFilter {
        folder_id: folder,
        media_type: Some(MediaType::Image),
        ..FavoriteFilter::default()
    }
}

/// Keys in order, each once.
fn unique<'a>(keys: impl Iterator<Item = &'a str>) -> Vec<SharedString> {
    let mut seen = HashSet::new();
    keys.filter(|key| seen.insert(*key))
        .map(|key| SharedString::from(key.to_string()))
        .collect()
}

struct ReferencePicker {
    source: Source,
    /// `None` all, `Some("none")` unfiled, else a folder id: `listFavorites`'
    /// own dialect.
    folder: Option<String>,
    folders: Entity<LiveQuery<Folders>>,
    favorites: Entity<LivePaginatedQuery<Favorite>>,
    self_hosted: Option<Entity<LivePaginatedQuery<Generation>>>,
    api: Option<Entity<LivePaginatedQuery<ApiGeneration>>>,
    /// Each source's image keys, newest first, by [`Source::ix`].
    keys: [Rc<Vec<SharedString>>; 3],
    scroll: UniformListScrollHandle,
    /// The grid's width from the last paint. Read on the next render.
    width: Rc<Cell<f32>>,
    on_pick: PickHandler,
    _subscriptions: Vec<Subscription>,
}

impl ReferencePicker {
    fn new(on_pick: PickHandler, cx: &mut Context<Self>) -> Self {
        let favorites = LivePaginatedQuery::new(
            favorites::LIST_FAVORITES,
            &favorite_filter(None),
            PAGE_SIZE,
            cx,
        );
        let folders = LiveQuery::new(favorites::LIST_FOLDERS, &NoArgs {}, cx);
        let subscriptions = vec![
            cx.observe(&favorites, |this, _, cx| {
                this.rows_changed(Source::Favorites, cx)
            }),
            cx.observe(&folders, |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            source: Source::Favorites,
            folder: None,
            folders,
            favorites,
            self_hosted: None,
            api: None,
            keys: Default::default(),
            scroll: UniformListScrollHandle::new(),
            width: Rc::new(Cell::new(0.0)),
            on_pick,
            _subscriptions: subscriptions,
        };
        this.rebuild_keys(Source::Favorites, cx);
        this
    }

    // --- Data -----------------------------------------------------------

    /// The image keys of the current source, newest first.
    fn keys(&self) -> &Rc<Vec<SharedString>> {
        &self.keys[self.source.ix()]
    }

    fn rebuild_keys(&mut self, source: Source, cx: &App) {
        self.keys[source.ix()] = Rc::new(self.read_keys(source, cx));
    }

    /// `source`'s image keys, read from its rows.
    fn read_keys(&self, source: Source, cx: &App) -> Vec<SharedString> {
        match source {
            Source::Favorites => {
                let query = self.favorites.read(cx);
                // Rows still from the previous folder (or remembered) are
                // narrowed with the server's own predicate until the new
                // first page lands.
                let narrow = query.is_stale();
                let filter = favorite_filter(self.folder.clone());
                unique(
                    query
                        .rows()
                        .iter()
                        .filter(|row| !narrow || filter.matches(row))
                        .map(|row| row.b2_key.as_str()),
                )
            }
            Source::SelfHosted => {
                let Some(query) = &self.self_hosted else {
                    return Vec::new();
                };
                // Rows from the old save path carry no status and are finished.
                unique(
                    query
                        .read(cx)
                        .rows()
                        .iter()
                        .filter(|row| {
                            matches!(row.status, None | Some(GenerationStatus::Completed))
                        })
                        .flat_map(|row| row.b2_keys.iter().map(String::as_str)),
                )
            }
            Source::Api => {
                let Some(query) = &self.api else {
                    return Vec::new();
                };
                unique(
                    query
                        .read(cx)
                        .rows()
                        .iter()
                        .filter(|row| {
                            row.status == GenerationStatus::Completed
                                && row.media_type == grok_generations::MediaType::Image
                        })
                        .flat_map(|row| row.outputs()),
                )
            }
        }
    }

    fn status(&self, cx: &App) -> PaginationStatus {
        match self.source {
            Source::Favorites => self.favorites.read(cx).status(),
            Source::SelfHosted => self
                .self_hosted
                .as_ref()
                .map_or(PaginationStatus::LoadingFirstPage, |query| {
                    query.read(cx).status()
                }),
            Source::Api => self
                .api
                .as_ref()
                .map_or(PaginationStatus::LoadingFirstPage, |query| {
                    query.read(cx).status()
                }),
        }
    }

    fn error(&self, cx: &App) -> Option<SharedString> {
        match self.source {
            Source::Favorites => self.favorites.read(cx).error().cloned(),
            Source::SelfHosted => self
                .self_hosted
                .as_ref()
                .and_then(|query| query.read(cx).error().cloned()),
            Source::Api => self
                .api
                .as_ref()
                .and_then(|query| query.read(cx).error().cloned()),
        }
    }

    fn load_more(&mut self, cx: &mut Context<Self>) {
        match self.source {
            Source::Favorites => self
                .favorites
                .update(cx, |query, cx| query.load_more(PAGE_SIZE, cx)),
            Source::SelfHosted => {
                if let Some(query) = &self.self_hosted {
                    query.update(cx, |query, cx| query.load_more(PAGE_SIZE, cx));
                }
            }
            Source::Api => {
                if let Some(query) = &self.api {
                    query.update(cx, |query, cx| query.load_more(PAGE_SIZE, cx));
                }
            }
        }
    }

    fn rows_changed(&mut self, source: Source, cx: &mut Context<Self>) {
        self.rebuild_keys(source, cx);
        if source == self.source {
            self.fill_if_empty(cx);
            cx.notify();
        }
    }

    /// A page with no images on it — API pages of clips, failed self-hosted
    /// runs — puts nothing on screen to scroll towards, so the next page is
    /// asked for here, until there are images or no more pages.
    fn fill_if_empty(&mut self, cx: &mut Context<Self>) {
        if self.status(cx) == PaginationStatus::CanLoadMore && self.keys().is_empty() {
            self.load_more(cx);
        }
    }

    fn set_source(&mut self, source: Source, cx: &mut Context<Self>) {
        if source == self.source {
            return;
        }
        self.source = source;
        match source {
            Source::SelfHosted if self.self_hosted.is_none() => {
                let query =
                    LivePaginatedQuery::new(generations::LIST_PAGINATED, &NoArgs {}, PAGE_SIZE, cx);
                self._subscriptions.push(cx.observe(&query, |this, _, cx| {
                    this.rows_changed(Source::SelfHosted, cx)
                }));
                self.self_hosted = Some(query);
            }
            Source::Api if self.api.is_none() => {
                let query =
                    LivePaginatedQuery::new(grok_generations::LIST, &NoArgs {}, PAGE_SIZE, cx);
                self._subscriptions
                    .push(cx.observe(&query, |this, _, cx| this.rows_changed(Source::Api, cx)));
                self.api = Some(query);
            }
            _ => {}
        }
        self.rebuild_keys(source, cx);
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
        self.fill_if_empty(cx);
        cx.notify();
    }

    fn set_folder(&mut self, folder: Option<String>, cx: &mut Context<Self>) {
        if folder == self.folder {
            return;
        }
        self.folder = folder;
        let filter = favorite_filter(self.folder.clone());
        self.favorites
            .update(cx, |query, cx| query.set_args(&filter, cx));
        // The rows held are narrowed to the new folder at once.
        self.rebuild_keys(Source::Favorites, cx);
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
        cx.notify();
    }

    /// Closes the picker, then hands the image over.
    fn pick(view: &WeakEntity<Self>, key: &str, window: &mut Window, cx: &mut App) {
        let Some(on_pick) = view.upgrade().map(|view| view.read(cx).on_pick.clone()) else {
            return;
        };
        let picked = PickedImage {
            url: Media::urls(cx).original(key).into(),
            b2_key: key.to_string(),
        };
        window.close_dialog(cx);
        on_pick(picked, window, cx);
    }

    // --- Rendering ------------------------------------------------------

    fn render_sources(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self.source;
        h_flex().px_4().child(
            ButtonGroup::new("reference-source")
                .small()
                .outline()
                .children(Source::ALL.iter().map(|source| {
                    Button::new(source.label())
                        .label(source.label())
                        .selected(*source == current)
                }))
                .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                    if let Some(source) = selected.first().and_then(|ix| Source::ALL.get(*ix)) {
                        this.set_source(*source, cx);
                    }
                })),
        )
    }

    /// All / Unfiled / one chip per folder, when Favorites has folders.
    fn render_folders(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.source != Source::Favorites {
            return None;
        }
        let data = self.folders.read(cx).data().cloned()?;
        if data.folders.is_empty() {
            return None;
        }
        let current = self.folder.clone();
        let mut row = h_flex()
            .px_4()
            .gap_1p5()
            .flex_wrap()
            .child(folder_chip(
                "folder-all".into(),
                "All".into(),
                None,
                current.is_none(),
                None,
                cx,
            ))
            .child(folder_chip(
                "folder-unfiled".into(),
                format!("Unfiled {}", data.unfiled as u64).into(),
                None,
                current.as_deref() == Some(FavoriteFilter::UNFILED),
                Some(FavoriteFilter::UNFILED.to_string()),
                cx,
            ));
        for folder in &data.folders {
            let selected = current.as_deref() == Some(folder.id.as_str());
            row = row.child(folder_chip(
                format!("folder-{}", folder.id).into(),
                format!("{} {}", folder.name, folder.count as u64).into(),
                Some(if selected {
                    IconName::FolderOpen
                } else {
                    IconName::Folder
                }),
                selected,
                Some(folder.id.clone()),
                cx,
            ));
        }
        Some(row.into_any_element())
    }

    fn render_grid(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let keys = self.keys().clone();
        let status = self.status(cx);
        let muted = cx.theme().muted_foreground;

        if keys.is_empty() {
            let message: AnyElement = match (status, self.error(cx)) {
                (PaginationStatus::LoadingFirstPage, _) => Spinner::new().into_any_element(),
                (PaginationStatus::Failed, Some(error)) => div()
                    .text_sm()
                    .text_color(muted)
                    .child(error)
                    .into_any_element(),
                (PaginationStatus::CanLoadMore | PaginationStatus::LoadingMore, _) => div()
                    .text_sm()
                    .text_color(muted)
                    .child("Looking for images…")
                    .into_any_element(),
                _ => div()
                    .text_sm()
                    .text_color(muted)
                    .child("No images here yet")
                    .into_any_element(),
            };
            return div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .child(message)
                .into_any_element();
        }

        let layout = GridLayout::new(self.width.get(), window.rem_size().as_f32());
        // Unmeasured, the grid lays out nothing for one frame; the canvas
        // below measures it and asks for the next.
        let (columns, tile) =
            layout.map_or((MIN_COLUMNS, 0.0), |layout| (layout.columns, layout.tile));
        let row_count = if layout.is_some() {
            keys.len().div_ceil(columns)
        } else {
            0
        };
        let can_load_more = status == PaginationStatus::CanLoadMore;
        let urls = Media::urls(cx).clone();
        let view = cx.entity().downgrade();
        let view_id = cx.entity_id();
        let width = self.width.clone();

        let list = uniform_list("reference-grid", row_count, move |range, _, cx| {
            if can_load_more && range.end + NEAR_END_ROWS >= row_count {
                let view = view.clone();
                cx.defer(move |cx| {
                    let _ = view.update(cx, |this, cx| this.load_more(cx));
                });
            }
            range
                .map(|row| {
                    let start = row * columns;
                    let end = (start + columns).min(keys.len());
                    h_flex().px_4().pb_2().gap_2().items_start().children(
                        keys[start..end].iter().enumerate().map(|(offset, key)| {
                            render_tile(key, start + offset, px(tile), &urls, &view, cx)
                        }),
                    )
                })
                .collect::<Vec<_>>()
        })
        .track_scroll(&self.scroll)
        .size_full();

        div()
            .relative()
            .flex_1()
            .min_h_0()
            .child(list)
            .when(status == PaginationStatus::LoadingMore, |this| {
                this.child(
                    h_flex()
                        .absolute()
                        .bottom_2()
                        .left_0()
                        .right_0()
                        .justify_center()
                        .child(Spinner::new()),
                )
            })
            // Measures the width for the next layout; asks for one more frame
            // only when it changed.
            .child(
                canvas(
                    move |bounds: Bounds<Pixels>, _, cx| {
                        if (bounds.size.width.as_f32() - width.get()).abs() > 0.5 {
                            width.set(bounds.size.width.as_f32());
                            cx.notify(view_id);
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .vertical_scrollbar(&self.scroll)
            .into_any_element()
    }
}

fn folder_chip(
    id: SharedString,
    label: SharedString,
    icon: Option<IconName>,
    selected: bool,
    folder: Option<String>,
    cx: &mut Context<ReferencePicker>,
) -> Button {
    Button::new(id)
        .small()
        .when(selected, |button| button.primary())
        .when(!selected, |button| button.outline())
        .when_some(icon, |button, icon| button.icon(icon))
        .label(label)
        .max_w(rems(14.))
        .on_click(cx.listener(move |this, _, _, cx| this.set_folder(folder.clone(), cx)))
}

/// One square thumbnail. A button, so Tab reaches it and Space or Enter
/// picks it; the hover ring is drawn over the image, which covers the
/// button's own hover fill.
fn render_tile(
    key: &SharedString,
    ix: usize,
    size: Pixels,
    urls: &MediaUrls,
    view: &WeakEntity<ReferencePicker>,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    let group = SharedString::from(format!("reference-{key}"));
    let request = ImageRequest::new(urls.thumb_small(key)).max_dimension(THUMB_DECODE_PIXELS);
    let (muted, muted_foreground, radius) = (theme.muted, theme.muted_foreground, theme.radius);
    let (border, ring) = (theme.border, theme.ring);
    let view = view.clone();
    let picked = key.clone();

    div().group(group.clone()).size(size).flex_shrink_0().child(
        Button::new(key.clone())
            .ghost()
            .size_full()
            .p_0()
            .accessibility_label(format!("Use image {}", ix + 1))
            .child(
                div()
                    .relative()
                    .size_full()
                    .child(
                        img(media_image(request))
                            .size_full()
                            .rounded(radius)
                            .object_fit(ObjectFit::Cover)
                            .with_loading(move || {
                                div()
                                    .size_full()
                                    .rounded(radius)
                                    .bg(muted)
                                    .into_any_element()
                            })
                            .with_fallback(move || {
                                v_flex()
                                    .size_full()
                                    .items_center()
                                    .justify_center()
                                    .rounded(radius)
                                    .bg(muted)
                                    .text_color(muted_foreground)
                                    .child(Icon::new(IconName::ImageOff).small())
                                    .into_any_element()
                            }),
                    )
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded(radius)
                            .border_1()
                            .border_color(border)
                            .group_hover(group, |style| style.border_2().border_color(ring)),
                    ),
            )
            .on_click(move |_, window, cx| ReferencePicker::pick(&view, &picked, window, cx)),
    )
}

impl Render for ReferencePicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .flex_1()
            .min_h_0()
            .gap_3()
            .child(self.render_sources(cx))
            .children(self.render_folders(cx))
            .child(self.render_grid(window, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_follow_the_width_within_three_and_seven() {
        let rem = 16.0;
        // 72 rem of dialog: seven 9-rem tiles fit.
        let wide = GridLayout::new(72.0 * rem, rem).unwrap();
        assert_eq!(wide.columns, MAX_COLUMNS);
        // A narrow window still shows three, smaller.
        let narrow = GridLayout::new(20.0 * rem, rem).unwrap();
        assert_eq!(narrow.columns, MIN_COLUMNS);
        assert!(narrow.tile < TILE_REMS * rem);
        // Tiles and gaps fill the row exactly.
        let mid = GridLayout::new(40.0 * rem, rem).unwrap();
        let used = mid.tile * mid.columns as f32 + GAP_REMS * rem * (mid.columns - 1) as f32;
        assert!((used - (40.0 - INSET_REMS * 2.0) * rem).abs() < 0.01);
        assert!(GridLayout::new(0.0, rem).is_none());
    }

    #[test]
    fn keys_keep_their_order_and_appear_once() {
        let keys = unique(["a", "b", "a", "c"].into_iter());
        assert_eq!(keys, ["a", "b", "c"]);
    }
}
