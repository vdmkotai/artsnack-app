//! The API tab's results: every hosted job and self-hosted clip, newest first,
//! in a column masonry — running jobs, then failures, then each output of every
//! finished row as its own tile.
//!
//! - **Live and hot.** `grokGenerations:list` rewrites a running row about once
//!   a second. Rows keep their `Arc` while their value is unchanged
//!   ([`artsnack_backend::RowCache`]); a change that moves no tile (progress, a
//!   queue position) swaps the row into its tiles and re-adds the totals
//!   without deriving the grid again, and asks for labels only if the labels
//!   read it ([`meta`]). Only tiles near the viewport exist as elements.
//! - **Paging.** 30 rows first, then pages sized to about two screens of the
//!   grid as it is laid out now, whenever the end of the grid comes within a
//!   screen and a half of the viewport — also when a filter shows nothing yet.
//! - **Selection** is per row (a batch's images go together), with Shift-click
//!   ranges; while selecting, Escape leaves and Delete or Backspace deletes.
//! - **Hand-offs** are only reported ([`ApiResultsEvent`]); the composer and
//!   the Generate screen act on them.
//!
//! The same grid is the self-hosted video tab's results column
//! ([`ApiResults::self_hosted_video`]): `comfyVideo:list`, no Send to video,
//! and "Remove all failed" limited to its own rows.

mod content;
pub(crate) mod copied;
mod delete;
mod details;
mod drafts;
mod header;
pub(crate) mod meta;
mod playback;
mod reference_viewer;
mod tiles;

use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::Arc,
};

use artsnack_backend::{
    LivePaginatedQuery, NoArgs, PaginationStatus,
    api::{
        comfy_video,
        favorites::ToggleArgs,
        grok_generations::{self, ApiGeneration},
    },
};
use artsnack_library::{FavoriteHearts, Selection};
use artsnack_media::{Media, MediaImages};
use artsnack_settings::{Preference, Preferences};
use artsnack_ui::{
    Lightbox, LightboxEvent, LightboxItem, MasonryCell, MediaMasonryState, TileAction, TileMedia,
    ZoomScale,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, Render, SharedString,
    Styled as _, Subscription, Window, actions, assets::IconName, component::v_flex, div, rems,
};

use self::{
    content::{
        Content, FIRST_PAGE_ROWS, Filters, ItemKind, MAX_PAGE_ROWS, page_rows_for, same_shape,
    },
    copied::CopiedMark,
    details::GenerationDetails,
    meta::{MetaCache, ModelChip},
    playback::{ClipScheduler, Viewport},
    tiles::{delete_action, grok_source_items, send_to_video_items},
};

actions!(api_results, [ExitSelection, DeleteSelection]);

const CONTEXT: &str = "ApiResults";
/// The preview size, `generate-preview-scale-api` on the web; the self-hosted
/// video tab shares it.
const PREVIEW_SCALE: Preference<f32> = Preference::new("generate.previewScale.api", || 1.0);

pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("escape", ExitSelection, Some(CONTEXT)),
        KeyBinding::new("backspace", DeleteSelection, Some(CONTEXT)),
        KeyBinding::new("delete", DeleteSelection, Some(CONTEXT)),
    ]);
}

/// Where an image goes on the self-hosted video tab.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoRole {
    First,
    Last,
    Reference,
}

/// What a result asks the composer (or the Generate screen) to do.
#[derive(Clone, Debug)]
pub enum ApiResultsEvent {
    /// Restore this row's settings and references into the composer. A
    /// self-hosted clip (`provider: comfy`) goes to the video tab instead; the
    /// API tab routes that.
    Reproduce(Arc<ApiGeneration>),
    /// Attach the image as a reference, making room if the model is full.
    /// `as_video` is "Make video": also switch the composer to video.
    UseAsReference {
        image_url: SharedString,
        as_video: bool,
    },
    /// Hand the image to the self-hosted video tab in this role.
    SendToVideo {
        image_url: SharedString,
        role: VideoRole,
    },
    /// Make the clip the source of a Grok Edit or Extend ("edit" | "extend").
    UseAsSourceVideo { key: String, mode: &'static str },
    /// A hand-off to another screen (a reference's own generation:
    /// Reproduce on Generate or Enhance, Send to Enhance).
    Media(artsnack_library::MediaCommand),
}

/// Which tab the grid serves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResultsKind {
    /// Every hosted job and self-hosted clip (`grokGenerations:list`).
    Api,
    /// Only the self-hosted clips (`comfyVideo:list`).
    SelfHostedVideo,
}

pub struct ApiResults {
    kind: ResultsKind,
    focus_handle: FocusHandle,
    generations: Entity<LivePaginatedQuery<ApiGeneration>>,
    hearts: Entity<FavoriteHearts>,
    /// The rows as the live query last delivered them.
    source: Arc<Vec<Arc<ApiGeneration>>>,
    /// The rows on screen: `source` without [`Self::removed`].
    rows: Arc<Vec<Arc<ApiGeneration>>>,
    /// Rows deleted here that the live query may still list, so a tile goes
    /// the moment it is deleted instead of a round trip later. `true` once the
    /// server agreed; the entry then lasts until the query drops the row. A
    /// failed delete takes its entry out and the tile comes back.
    removed: HashMap<String, bool>,
    status: PaginationStatus,
    meta: MetaCache,
    /// A batch of labels is on the worker; the next waits for it, so changes
    /// that land meanwhile are asked about once, at their latest.
    meta_in_flight: bool,
    /// The worker could not label rows; said once in the log, not per row.
    meta_warned: bool,
    /// The registry's models, for the chips and for telling a registry row's
    /// model apart from an Atlas slug. Empty until the worker answers.
    model_chips: Rc<Vec<ModelChip>>,
    filters: Filters,
    content: Rc<Content>,
    /// Each output's measured aspect, by item key, once its preview decoded.
    aspects: HashMap<SharedString, f32>,
    masonry: MediaMasonryState,
    clips: ClipScheduler,
    /// Players for the clips `clips` picked.
    players: artsnack_ui::ClipPlayers,
    /// Whether the grid is on screen. Hidden (Image → Prompt in its place, or
    /// another tab), it is not drawn, so it stops its players itself.
    visible: bool,
    /// The tile under the pointer, the only one that builds its actions. It
    /// stays set until another tile is hovered (see `tiles`).
    hovered: Option<SharedString>,
    /// The window's height from the last render, for sizing pages.
    screen_height: f32,
    /// Select mode, entered by the Select button. Selecting is also on while
    /// anything is selected (a Shift-click outside the mode).
    selecting: bool,
    selection: Selection,
    deleting: bool,
    removing_failed: bool,
    copied: CopiedMark,
    lightbox: Option<(Entity<Lightbox>, Subscription)>,
    details: Option<Entity<GenerationDetails>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ApiResultsEvent> for ApiResults {}

impl ApiResults {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(ResultsKind::Api, cx)
    }

    /// The self-hosted video tab's results column: its clips only, with the
    /// same tiles, filters, selection and viewer. Its tiles have no Send to
    /// video, and "Remove all failed" removes only its own failures.
    pub fn self_hosted_video(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(ResultsKind::SelfHostedVideo, cx)
    }

    fn build(kind: ResultsKind, cx: &mut Context<Self>) -> Self {
        let query = match kind {
            ResultsKind::Api => grok_generations::LIST,
            ResultsKind::SelfHostedVideo => comfy_video::LIST,
        };
        let generations = LivePaginatedQuery::new(query, &NoArgs {}, FIRST_PAGE_ROWS, cx);
        let hearts = cx.new(FavoriteHearts::new);
        let subscriptions = vec![
            cx.observe(&generations, |this, _, cx| this.rows_changed(cx)),
            cx.observe(&hearts, |this, _, cx| this.hearts_changed(cx)),
            // Drawn cached inside its tab, so it follows its own tile size.
            Preferences::observe(cx, &PREVIEW_SCALE, |_, cx| cx.notify()),
        ];
        let masonry = MediaMasonryState::new().with_padding(rems(1.), rems(0.75));
        let view = cx.entity().downgrade();
        masonry.on_near_end(move |cx| {
            let _ = view.update(cx, |this, cx| this.load_more(cx));
        });
        let mut this = Self {
            kind,
            focus_handle: cx.focus_handle(),
            generations,
            hearts,
            source: Arc::new(Vec::new()),
            rows: Arc::new(Vec::new()),
            removed: HashMap::new(),
            status: PaginationStatus::LoadingFirstPage,
            meta: MetaCache::default(),
            meta_in_flight: false,
            meta_warned: false,
            model_chips: Rc::new(Vec::new()),
            filters: Filters::default(),
            content: Rc::new(Content::default()),
            aspects: HashMap::new(),
            masonry,
            clips: ClipScheduler::default(),
            players: artsnack_ui::ClipPlayers::default(),
            visible: true,
            hovered: None,
            screen_height: 0.0,
            selecting: false,
            selection: Selection::default(),
            deleting: false,
            removing_failed: false,
            copied: CopiedMark::default(),
            lightbox: None,
            details: None,
            _subscriptions: subscriptions,
        };
        this.load_model_chips(cx);
        this.rows_changed(cx);
        this
    }

    // --- Data -----------------------------------------------------------

    fn load_model_chips(&mut self, cx: &mut Context<Self>) {
        let task = meta::model_chips(cx);
        cx.spawn(async move |this, cx| {
            let chips = match task.await {
                Ok(chips) => chips,
                Err(error) => {
                    tracing::warn!(%error, "could not read the model registry for the result chips");
                    return;
                }
            };
            let _ = this.update(cx, |this, cx| {
                this.model_chips = Rc::new(chips);
                this.rebuild(cx);
            });
        })
        .detach();
    }

    fn rows_changed(&mut self, cx: &mut Context<Self>) {
        let (source, status) = {
            let query = self.generations.read(cx);
            (query.rows().clone(), query.status())
        };
        let status_changed = status != self.status;
        self.status = status;
        if Arc::ptr_eq(&source, &self.source) {
            if status_changed {
                self.rebuild(cx);
            }
            return;
        }
        self.source = source;
        self.removed
            .retain(|id, settled| !*settled || self.source.iter().any(|row| &row.id == id));
        self.show_rows(status_changed, cx);
    }

    /// Hides `ids` until the server has deleted them (see [`Self::removed`]).
    fn hide_rows(&mut self, ids: &[String], cx: &mut Context<Self>) {
        for id in ids {
            self.removed.insert(id.clone(), false);
        }
        self.show_rows(false, cx);
    }

    /// The server answered the delete of `ids`: settled ones stay hidden until
    /// the query drops them, failed ones come back.
    fn settle_removed(&mut self, ids: &[String], deleted: bool, cx: &mut Context<Self>) {
        for id in ids {
            if deleted && self.source.iter().any(|row| &row.id == id) {
                self.removed.insert(id.clone(), true);
            } else {
                self.removed.remove(id);
            }
        }
        if !deleted {
            self.show_rows(false, cx);
        }
    }

    /// Puts `source` minus the hidden rows on screen.
    fn show_rows(&mut self, status_changed: bool, cx: &mut Context<Self>) {
        let rows = if self.removed.is_empty() {
            self.source.clone()
        } else {
            Arc::new(
                self.source
                    .iter()
                    .filter(|row| !self.removed.contains_key(&row.id))
                    .cloned()
                    .collect(),
            )
        };
        if !status_changed && Arc::ptr_eq(&rows, &self.rows) {
            return;
        }
        let previous = std::mem::replace(&mut self.rows, rows);
        if self.kind == ResultsKind::Api {
            crate::reference_source::remember_loaded(&self.rows, cx);
        }
        self.meta.retain(&self.rows);
        self.request_meta(cx);
        if !status_changed && same_shape(&previous, &self.rows) {
            let changed: HashMap<&str, &Arc<ApiGeneration>> = previous
                .iter()
                .zip(self.rows.iter())
                .filter(|(before, after)| !Arc::ptr_eq(before, after))
                .map(|(_, after)| (after.id.as_str(), after))
                .collect();
            let totals = self.totals(cx);
            Rc::make_mut(&mut self.content).refresh(&changed, totals);
            cx.notify();
        } else {
            self.rebuild(cx);
        }
    }

    /// The totals of the rows on screen, from the current labels.
    fn totals(&self, cx: &App) -> content::Totals {
        let registry: Vec<String> = self
            .model_chips
            .iter()
            .map(|chip| chip.id.clone())
            .collect();
        let hearts = self.hearts.read(cx);
        content::totals(
            &self.rows,
            &self.filters,
            &registry,
            |b2_key| hearts.is_favorited(b2_key),
            |row| {
                self.meta
                    .get(row)
                    .and_then(|meta| meta.cost_usd)
                    .or(row.cost_usd)
            },
        )
    }

    fn hearts_changed(&mut self, cx: &mut Context<Self>) {
        // Only the Liked filter makes the hearts decide what is on screen.
        if self.filters.liked {
            self.rebuild(cx);
        } else {
            cx.notify();
        }
    }

    /// Asks the worker for the labels of rows whose labels may have changed,
    /// one batch at a time.
    fn request_meta(&mut self, cx: &mut Context<Self>) {
        if self.meta_in_flight {
            return;
        }
        let rows = self.meta.unanswered(&self.rows);
        if rows.is_empty() {
            return;
        }
        self.meta_in_flight = true;
        let task = meta::rows_meta(rows.iter().map(|(_, sent)| sent.clone()).collect(), cx);
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.meta_in_flight = false;
                let answers = match result {
                    Ok(answers) => Some(answers),
                    Err(error) => {
                        if !this.meta_warned {
                            this.meta_warned = true;
                            tracing::warn!(%error, "could not label the results; showing model ids");
                        }
                        None
                    }
                };
                this.meta.store(rows, answers);
                // Labels move no tile; only the totals read them.
                let totals = this.totals(cx);
                Rc::make_mut(&mut this.content).totals = totals;
                cx.notify();
                // Whatever changed while this batch was out.
                this.request_meta(cx);
            });
        })
        .detach();
    }

    /// Derives the grid from the rows, filters and hearts.
    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let registry: Vec<String> = self
            .model_chips
            .iter()
            .map(|chip| chip.id.clone())
            .collect();
        let content = {
            let hearts = self.hearts.read(cx);
            let meta = &self.meta;
            content::derive(
                &self.rows,
                &self.filters,
                &registry,
                |b2_key| hearts.is_favorited(b2_key),
                |row| {
                    meta.get(row)
                        .and_then(|meta| meta.cost_usd)
                        .or(row.cost_usd)
                },
            )
        };
        let items_changed = !content.same_items(&self.content);
        self.content = Rc::new(content);
        if items_changed {
            let present: HashSet<&SharedString> =
                self.content.items.iter().map(|item| &item.key).collect();
            self.aspects.retain(|key, _| present.contains(key));
            let (keys, aspects) = self.shapes(cx);
            self.masonry.set_items(keys, aspects);
            let content = self.content.clone();
            self.selection.retain_present(content.row_ids());
            self.sync_lightbox(cx);
        }
        // A filter that matches nothing loaded yet looks further, until it
        // finds something or the history ends.
        if self.content.items.is_empty() && self.status == PaginationStatus::CanLoadMore {
            self.request_page(MAX_PAGE_ROWS, cx);
        }
        cx.notify();
    }

    /// Every item's key and aspect: an output's measured one if its preview
    /// ever decoded, else the shape the job asked for.
    fn shapes(&mut self, cx: &App) -> (Vec<SharedString>, Vec<f32>) {
        let urls = Media::urls(cx);
        let content = self.content.clone();
        let mut keys = Vec::with_capacity(content.items.len());
        let mut aspects = Vec::with_capacity(content.items.len());
        for item in &content.items {
            let requested = content::parse_aspect(item.row.aspect_ratio.as_deref());
            let aspect = match &item.kind {
                ItemKind::Output { b2_key } => match self.aspects.get(&item.key) {
                    Some(aspect) => *aspect,
                    None => {
                        let preview = tiles::preview(b2_key, item.row.is_video(), urls);
                        match MediaImages::aspect(cx, preview.url()) {
                            Some(aspect) => {
                                self.aspects.insert(item.key.clone(), aspect);
                                aspect
                            }
                            None => requested,
                        }
                    }
                },
                _ => requested,
            };
            keys.push(item.key.clone());
            aspects.push(aspect);
        }
        (keys, aspects)
    }

    /// Picks up the aspects of previews that decoded since the last frame; the
    /// view that drew them is notified when they do.
    fn measure_visible(&mut self, cx: &App) {
        let urls = Media::urls(cx);
        let content = self.content.clone();
        for ix in self.masonry.visible_items() {
            let Some(item) = content.items.get(ix) else {
                continue;
            };
            let ItemKind::Output { b2_key } = &item.kind else {
                continue;
            };
            if self.aspects.contains_key(&item.key) {
                continue;
            }
            let preview = tiles::preview(b2_key, item.row.is_video(), urls);
            if let Some(aspect) = MediaImages::aspect(cx, preview.url()) {
                self.aspects.insert(item.key.clone(), aspect);
                self.masonry.set_aspect(ix, aspect);
            }
        }
    }

    /// The next page, sized to about two screens of the grid as laid out now.
    fn load_more(&mut self, cx: &mut Context<Self>) {
        if self.status != PaginationStatus::CanLoadMore {
            return;
        }
        let layout = self.masonry.layout();
        let rows = if self.content.items.is_empty() {
            MAX_PAGE_ROWS
        } else {
            page_rows_for(
                layout.columns,
                layout.column_width,
                layout.height,
                self.rows.len(),
                self.screen_height,
            )
        };
        self.request_page(rows, cx);
    }

    fn request_page(&mut self, rows: usize, cx: &mut Context<Self>) {
        self.generations
            .update(cx, |generations, cx| generations.load_more(rows, cx));
    }

    /// Shown or hidden by the tab around it. Hidden, its clips stop (their
    /// players and downloads go); shown again, the next frame picks them anew.
    pub fn set_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.visible == visible {
            return;
        }
        self.visible = visible;
        if !visible {
            self.players.sync(Vec::new());
        }
        cx.notify();
    }

    fn set_filters(&mut self, filters: Filters, cx: &mut Context<Self>) {
        if filters != self.filters {
            self.filters = filters;
            self.rebuild(cx);
        }
    }

    // --- Selection ------------------------------------------------------

    fn is_selecting(&self) -> bool {
        self.selecting || !self.selection.is_empty()
    }

    fn toggle_selection_mode(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting() {
            self.exit_selection(cx);
        } else {
            self.selecting = true;
            self.focus_handle.focus(window, cx);
            cx.notify();
        }
    }

    fn exit_selection(&mut self, cx: &mut Context<Self>) {
        self.selecting = false;
        self.selection.clear();
        cx.notify();
    }

    /// Selects every row on screen (the filters decide what that is).
    fn select_all(&mut self, cx: &mut Context<Self>) {
        let content = self.content.clone();
        let ids = content.row_ids();
        self.selection.clear();
        if let (Some(first), Some(last)) = (ids.clone().next(), ids.clone().last()) {
            self.selection.toggle(first);
            self.selection.extend_to(last, ids);
        }
        cx.notify();
    }

    /// A click on a tile while selecting, or a Shift-click anywhere.
    fn select_row(&mut self, id: String, shift: bool, window: &mut Window, cx: &mut Context<Self>) {
        let content = self.content.clone();
        if shift {
            self.selection.extend_to(&id, content.row_ids());
        } else {
            self.selection.toggle(&id);
        }
        // Escape and Delete act on the selection from here.
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    fn click_output(
        &mut self,
        key: SharedString,
        row_id: String,
        shift: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_selecting() || shift {
            self.select_row(row_id, shift, window, cx);
        } else {
            self.open_lightbox(key, window, cx);
        }
    }

    fn on_exit_selection(&mut self, _: &ExitSelection, _: &mut Window, cx: &mut Context<Self>) {
        if self.lightbox.is_none() && self.is_selecting() {
            self.exit_selection(cx);
        } else {
            cx.propagate();
        }
    }

    fn on_delete_selection(
        &mut self,
        _: &DeleteSelection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.lightbox.is_none() && !self.selection.is_empty() {
            self.confirm_delete_selection(window, cx);
        } else {
            cx.propagate();
        }
    }

    // --- Viewer ---------------------------------------------------------

    fn lightbox_items(&self, cx: &App) -> Vec<LightboxItem> {
        let urls = Media::urls(cx);
        self.content
            .outputs()
            .filter_map(|item| {
                let b2_key = item.b2_key()?;
                let video = item.row.is_video();
                let preview = tiles::preview(b2_key, video, urls);
                Some(LightboxItem {
                    key: item.key.clone(),
                    original: if video {
                        preview.clone()
                    } else {
                        tiles::original(b2_key, urls)
                    },
                    preview,
                    media: if video {
                        TileMedia::Video
                    } else {
                        TileMedia::Image
                    },
                    video_url: video.then(|| urls.video(b2_key).into()),
                })
            })
            .collect()
    }

    fn sync_lightbox(&self, cx: &mut Context<Self>) {
        if let Some((lightbox, _)) = &self.lightbox {
            let items = self.lightbox_items(cx);
            let can_load_more = self.status == PaginationStatus::CanLoadMore;
            lightbox.update(cx, |lightbox, cx| {
                lightbox.set_items(items, can_load_more, cx)
            });
        }
    }

    fn open_lightbox(&mut self, key: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let items = self.lightbox_items(cx);
        let can_load_more = self.status == PaginationStatus::CanLoadMore;
        let actions_view = cx.entity().downgrade();
        let details_view = actions_view.clone();
        let caption_view = actions_view.clone();
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
                details_view
                    .upgrade()?
                    .update(cx, |this, cx| this.details_element(&item.key, cx))
            },
            cx,
        );
        lightbox.update(cx, |lightbox, _| {
            lightbox.set_caption_for(move |item, cx| {
                let view = caption_view.upgrade()?;
                let this = view.read(cx);
                this.price_tag(&this.content.item(&item.key)?.row)
            })
        });
        let subscription =
            cx.subscribe_in(
                &lightbox,
                window,
                |this, _, event, window, cx| match event {
                    LightboxEvent::Closed => this.close_lightbox(window, cx),
                    LightboxEvent::LoadMore => this.load_more(cx),
                },
            );
        lightbox.read(cx).focus_handle(cx).focus(window, cx);
        self.lightbox = Some((lightbox, subscription));
        // The viewer covers the grid: no clip plays under it.
        self.clips.set_suspended(true);
        cx.notify();
    }

    fn close_lightbox(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.lightbox.take().is_none() {
            return;
        }
        self.details = None;
        self.clips.set_suspended(false);
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    /// A reference image picked in the details panel: the viewer closes so
    /// the composer it lands in is in view.
    fn use_reference_from_viewer(
        &mut self,
        image_url: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_lightbox(window, cx);
        cx.emit(ApiResultsEvent::UseAsReference {
            image_url,
            as_video: false,
        });
    }

    /// A reference thumbnail in the details panel: opens it, with its own
    /// source and references, over the viewer.
    fn open_reference(
        &mut self,
        reference: reference_viewer::ViewerReference,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        reference_viewer::ReferenceViewer::open(reference, cx.entity().downgrade(), window, cx);
    }

    /// The viewer's bar: the heart; for an image, Use as reference, Make video
    /// and Send to video (each closing the viewer first, as they take you to
    /// the composer); then Delete, which closes it once the row is gone.
    fn lightbox_actions(&self, key: &str, cx: &mut Context<Self>) -> Vec<TileAction> {
        let Some(item) = self.content.item(key) else {
            return Vec::new();
        };
        let Some(b2_key) = item.b2_key() else {
            return Vec::new();
        };
        let view = cx.entity().downgrade();
        let row = item.row.clone();
        let favorited = self.hearts.read(cx).favorited(b2_key);
        let hearts = self.hearts.clone();
        let args = ToggleArgs {
            api_generation_id: Some(row.id.clone()),
            b2_key: b2_key.to_string(),
            ..ToggleArgs::default()
        };
        let mut actions = Vec::new();
        // No heart until the favourites list is known.
        if let Some(favorited) = favorited {
            actions.push(TileAction::new(
                "favorite",
                if favorited {
                    IconName::HeartOff
                } else {
                    IconName::Heart
                },
                if favorited {
                    "Remove from favorites"
                } else {
                    "Add to favorites"
                },
                move |window, cx| {
                    hearts.update(cx, |hearts, cx| hearts.toggle(args.clone(), window, cx));
                },
            ));
        }
        if !row.is_video() {
            let image_url: SharedString = Media::urls(cx).original(b2_key).into();
            for (id, icon, label, as_video) in [
                (
                    "use-reference",
                    IconName::ImagePlus,
                    "Use as reference",
                    false,
                ),
                (
                    "make-video",
                    IconName::Film,
                    "Make video from this image",
                    true,
                ),
            ] {
                let view = view.clone();
                let image_url = image_url.clone();
                actions.push(TileAction::new(id, icon, label, move |window, cx| {
                    let image_url = image_url.clone();
                    let _ = view.update(cx, |this, cx| {
                        this.close_lightbox(window, cx);
                        cx.emit(ApiResultsEvent::UseAsReference {
                            image_url,
                            as_video,
                        });
                    });
                }));
            }
            if self.kind == ResultsKind::Api {
                let close_view = view.clone();
                actions.push(TileAction::menu(
                    "send-to-video",
                    IconName::Clapperboard,
                    "Use in self-hosted video",
                    send_to_video_items(&view, &image_url, move |window, cx| {
                        let _ = close_view.update(cx, |this, cx| this.close_lightbox(window, cx));
                    }),
                ));
            }
        }
        if let Some(draft) = self.meta.get(&row).and_then(|meta| meta.draft.as_ref()) {
            actions.push(drafts::finish_draft_action(&view, draft));
        }
        if row.is_video()
            && self.kind == ResultsKind::Api
            && let Some(key) = self
                .meta
                .get(&row)
                .and_then(|meta| meta.grok_source_key.clone())
        {
            let close_view = view.clone();
            actions.push(TileAction::menu(
                "grok-source",
                IconName::Film,
                "Edit or extend with Grok",
                grok_source_items(&view, &key, move |window, cx| {
                    let _ = close_view.update(cx, |this, cx| this.close_lightbox(window, cx));
                }),
            ));
        }
        actions.push(TileAction::download(b2_key, cx));
        actions.push(delete_action(&view, &row, true));
        actions
    }

    /// The details panel for the row of `key`, kept while the viewer stays on
    /// that row.
    fn details_element(&mut self, key: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        let row = self.content.item(key)?.row.clone();
        let details = match &self.details {
            Some(details) if details.read(cx).row_id() == row.id => details.clone(),
            _ => {
                let results = cx.entity().downgrade();
                let details = cx.new(|cx| GenerationDetails::new(row, results, cx));
                self.details = Some(details.clone());
                details
            }
        };
        Some(details.into_any_element())
    }

    // --- Rendering ------------------------------------------------------

    fn render_grid(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if self.content.items.is_empty() {
            // Nothing to play: clips a filter just hid let go of their players.
            self.players.sync(Vec::new());
            return self.render_empty(cx);
        }
        let content = self.content.clone();
        let visible = self.masonry.visible_items();

        // Every visible clip is a candidate to play; see `playback`.
        let layout = self.masonry.layout();
        let (top, height) = self.masonry.viewport();
        let clips: Vec<(&SharedString, MasonryCell)> = visible
            .iter()
            .filter_map(|&ix| {
                let item = content.items.get(ix)?;
                (item.row.is_video() && item.b2_key().is_some())
                    .then_some((&item.key, layout.cell(ix)?))
            })
            .collect();
        self.clips.schedule(
            clips,
            Viewport {
                top,
                height,
                width: layout.width,
            },
        );
        let urls = Media::urls(cx).clone();
        let playing: Vec<(SharedString, SharedString)> = self
            .clips
            .playing()
            .iter()
            .filter_map(|key| {
                let b2_key = content.item(key)?.b2_key()?;
                Some((key.clone(), urls.video(b2_key).into()))
            })
            .collect();
        self.players.sync(playing);

        // Tiles are cached views: a clip's frame redraws its own surface and
        // tile, not the other tiles (see `artsnack_ui::media_masonry`).
        let players = self.players.clone();
        let live_content = content.clone();
        let owner = cx.entity();
        let view = owner.downgrade();
        let grid = self
            .masonry
            .render_cached(
                &owner,
                move |ix| {
                    live_content
                        .items
                        .get(ix)
                        .is_some_and(|item| players.is_playing(&item.key))
                },
                move |ix, size, _, cx| {
                    view.update(cx, |this, cx| {
                        let content = this.content.clone();
                        let item = content.items.get(ix)?;
                        Some(this.render_item(item, size, cx))
                    })
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| div().into_any_element())
                },
                cx,
            )
            .into_any_element();
        div().flex_1().min_h_0().child(grid).into_any_element()
    }
}

impl Focusable for ApiResults {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for ApiResults {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.screen_height = window.viewport_size().height.as_f32();
        let scale = ZoomScale::TILES.clamp(Preferences::get(cx, &PREVIEW_SCALE));
        self.measure_visible(cx);
        self.masonry.prepare(scale, window);
        let grid = self.render_grid(cx);
        let lightbox = self.lightbox.as_ref().map(|(lightbox, _)| lightbox.clone());

        v_flex()
            .id("api-results")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::on_exit_selection))
            .on_action(cx.listener(Self::on_delete_selection))
            .relative()
            .size_full()
            .child(self.render_header(scale, cx))
            .children(self.render_billing_banner())
            .child(grid)
            .children(self.render_selection_bar(cx))
            .children(lightbox)
    }
}
