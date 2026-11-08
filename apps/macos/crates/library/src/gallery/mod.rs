//! Gallery: every self-hosted image, newest first, one tile per image (a batch
//! of four is four tiles); hearts, multi-select to delete, and the viewer.
//!
//! - Selection follows the web: Select enters the mode, and Shift-click selects
//!   even outside it; while selecting, Escape leaves the mode and Delete or
//!   Backspace deletes the selection (after a confirmation).
//! - A progress tick of a running generation changes its row but no image, so
//!   it does not rebuild the images: rows are compared by identity before
//!   anything is flattened. Each tile is a cached view (`tile_view`), so a
//!   frame drawn for a spinner or a progress bar reuses the image tiles.
//! - The next page loads when the last rows come within the grid's overdraw of
//!   the viewport — also when the first page is too short to scroll, which a
//!   scroll handler alone would never see.
//!
//! The same view is the results column of Generate's self-hosted tab
//! ([`GalleryView::results`]): running and failed jobs ahead of the images,
//! "Remove all failed", and a preview-size control.
//!
//! Hidden ([`GalleryView::set_active`]), the screen keeps what it shows and
//! lets go of its subscriptions after a grace period (see `feed`).

mod actions;
mod hearts;
mod image;
mod jobs;

pub(crate) use actions::{CopiedMark, ImageScreen, download_action, image_actions};
pub use hearts::FavoriteHearts;
pub(crate) use image::{image_key, lightbox_item, original, preview, split_image_key};

use std::{cell::RefCell, rc::Rc, sync::Arc};

use artsnack_backend::{
    Backend, CallError, LivePaginatedQuery, NoArgs, PaginationStatus,
    api::{
        favorites::{ToggleArgs, short_checkpoint_name},
        generations::{self, Generation, ImageRef, RemoveImagesArgs},
    },
};
use artsnack_media::{Media, MediaUrls};
use artsnack_settings::{Preference, Preferences};
use artsnack_ui::{
    Lightbox, LightboxEvent, LightboxItem, MediaGridState, MediaTile, TileAction, ZoomControl,
    ZoomScale,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    FontWeight, InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, Render,
    SharedString, Styled as _, Subscription, Task, WeakEntity, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariant, ButtonVariants as _},
        h_flex,
        notification::Notification,
        skeleton::Skeleton,
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    rems,
};

use self::{
    image::{GalleryImage, by_key, keys},
    jobs::{Jobs, job_key, job_tile},
};
use crate::{
    command::MediaCommand,
    feed::{Feed, release_after_grace},
    grid_sync::GridSync,
    history::details,
    selection::Selection,
    tile_view::{Same, TileRenderer, TileViews},
};

actions!(gallery, [ExitSelection, DeleteSelection]);

const CONTEXT: &str = "Gallery";
/// First page and every page after it, as the web loads them.
const PAGE_SIZE: usize = 15;
const RESULTS_PAGE_SIZE: usize = 30;
/// The results column's preview size, `generate-preview-scale-models` on the web.
const RESULTS_TILE_SCALE: Preference<f32> = Preference::new("generate.previewScale.models", || 1.0);
/// Shapes for the loading placeholder, as on the web.
const SKELETON_ASPECTS: [f32; 12] = [
    3. / 4.,
    4. / 3.,
    1.,
    16. / 9.,
    3. / 4.,
    1.,
    4. / 3.,
    3. / 4.,
    16. / 9.,
    1.,
    4. / 3.,
    3. / 4.,
];

pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("escape", ExitSelection, Some(CONTEXT)),
        KeyBinding::new("backspace", DeleteSelection, Some(CONTEXT)),
        KeyBinding::new("delete", DeleteSelection, Some(CONTEXT)),
    ]);
}

/// Which screen the view is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GalleryKind {
    Gallery,
    /// Generate's self-hosted results column.
    Results,
}

/// A tile's revision: its row by identity, and the heart, selection mark and
/// Copy check it shows.
type TileRevision = (Same<Generation>, Option<bool>, Option<bool>, bool);

pub struct GalleryView {
    kind: GalleryKind,
    focus_handle: FocusHandle,
    /// The live rows; released while the screen stays hidden.
    generations: Feed<LivePaginatedQuery<Generation>>,
    hearts: Entity<FavoriteHearts>,
    /// The rows that have images, by identity: what `images` was built from.
    image_rows: Vec<Arc<Generation>>,
    /// The images of the loaded rows, rebuilt only when one of them changed.
    images: Rc<Vec<GalleryImage>>,
    /// Running and failed jobs, ahead of the images (results column only).
    jobs: Rc<Jobs>,
    /// The grid's keys and shapes (jobs, then images), and their revision.
    grid_keys: Rc<Vec<SharedString>>,
    grid_aspects: Rc<Vec<f32>>,
    grid_revision: u64,
    grid_sync: GridSync,
    tiles: Rc<RefCell<TileViews<TileRevision>>>,
    removing_failed: bool,
    status: PaginationStatus,
    error: Option<SharedString>,
    grid: MediaGridState,
    /// Select mode, entered by the Select button. Selecting is also on while
    /// anything is selected (a Shift-click outside the mode).
    selecting: bool,
    selection: Selection,
    deleting: bool,
    copied: CopiedMark,
    lightbox: Option<(Entity<Lightbox>, Subscription)>,
    active: bool,
    _release: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<MediaCommand> for GalleryView {}

impl ImageScreen for GalleryView {
    fn copied_mark(&mut self) -> &mut CopiedMark {
        &mut self.copied
    }
}

impl GalleryView {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(GalleryKind::Gallery, cx)
    }

    /// Generate's self-hosted results column. Reproduce is reported like the
    /// rest; the Generate screen applies it to its own form.
    pub fn results(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(GalleryKind::Results, cx)
    }

    fn build(kind: GalleryKind, cx: &mut Context<Self>) -> Self {
        let hearts = cx.new(FavoriteHearts::new);
        let subscriptions = vec![cx.observe(&hearts, |_, _, cx| cx.notify())];
        let grid = MediaGridState::new();
        let view = cx.entity().downgrade();
        grid.on_near_end(move |cx| {
            let _ = view.update(cx, |this, cx| this.load_more(cx));
        });
        let mut this = Self {
            kind,
            focus_handle: cx.focus_handle(),
            generations: Feed::default(),
            hearts,
            image_rows: Vec::new(),
            images: Rc::default(),
            jobs: Rc::default(),
            grid_keys: Rc::default(),
            grid_aspects: Rc::default(),
            grid_revision: 0,
            grid_sync: GridSync::default(),
            tiles: Rc::default(),
            removing_failed: false,
            status: PaginationStatus::LoadingFirstPage,
            error: None,
            grid,
            selecting: false,
            selection: Selection::default(),
            deleting: false,
            copied: CopiedMark::default(),
            lightbox: None,
            active: true,
            _release: None,
            _subscriptions: subscriptions,
        };
        this.connect(cx);
        this
    }

    /// Subscribes to the rows, starting from the ones last delivered.
    fn connect(&mut self, cx: &mut Context<Self>) {
        let page_size = self.page_size();
        self.generations.connect(
            |cx| LivePaginatedQuery::new(generations::LIST_PAGINATED, &NoArgs {}, page_size, cx),
            Self::rows_changed,
            cx,
        );
        self.rows_changed(cx);
    }

    /// Whether the screen is shown (the shell, or Generate's tab switch, says
    /// so). Hidden, it keeps its rows, scroll and viewer, and lets go of the
    /// subscriptions after a grace period; shown again, it subscribes from
    /// where it was.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if active == self.active {
            return;
        }
        self.active = active;
        self.hearts
            .update(cx, |hearts, cx| hearts.set_active(active, cx));
        if active {
            self._release = None;
            self.connect(cx);
        } else {
            self._release = Some(release_after_grace(cx, |this, _| {
                this.generations.release();
            }));
        }
    }

    // --- Data -----------------------------------------------------------

    /// Whether `row`'s images are tiles. The results column leaves out a
    /// failed row's images, as the web does; a running row has none yet.
    fn shows_images(kind: GalleryKind, row: &Generation) -> bool {
        !row.b2_keys.is_empty()
            && match kind {
                GalleryKind::Gallery => true,
                GalleryKind::Results => !row.is_running() && !row.is_failed(),
            }
    }

    fn page_size(&self) -> usize {
        match self.kind {
            GalleryKind::Gallery => PAGE_SIZE,
            GalleryKind::Results => RESULTS_PAGE_SIZE,
        }
    }

    /// The rows changed. A progress tick changes a running row and nothing
    /// else, so the rows with images are compared by identity first, without
    /// building anything; only a real change flattens them again.
    fn rows_changed(&mut self, cx: &mut Context<Self>) {
        let Some(query) = self.generations.get() else {
            return;
        };
        let query = query.read(cx);
        let rows = query.rows().clone();
        let status = query.status();
        let error = query.error().cloned();

        let kind = self.kind;
        let mut with_images = rows.iter().filter(|row| Self::shows_images(kind, row));
        let same_images = self
            .image_rows
            .iter()
            .all(|old| with_images.next().is_some_and(|new| Arc::ptr_eq(new, old)))
            && with_images.next().is_none();
        let jobs = match kind {
            GalleryKind::Gallery => Jobs::default(),
            GalleryKind::Results => Jobs::of(&rows),
        };
        let same_jobs = jobs.is_same(&self.jobs);
        if same_images && same_jobs && status == self.status && error == self.error {
            return;
        }
        self.status = status;
        self.error = error;
        if !same_jobs {
            self.jobs = Rc::new(jobs);
        }
        if !same_images {
            self.image_rows = rows
                .iter()
                .filter(|row| Self::shows_images(kind, row))
                .cloned()
                .collect();
            self.images = Rc::new(GalleryImage::all(&self.image_rows));
            self.selection.retain_present(keys(&self.images));
            let present: std::collections::HashSet<&str> = keys(&self.images).collect();
            self.tiles.borrow_mut().retain(|key| present.contains(key));
        }
        if !same_images || !same_jobs {
            self.rebuild_grid_items();
        }

        // A page of rows with no output yet (all running or failed) shows no
        // tile, so nothing on screen would ever ask for the next one.
        if self.images.is_empty() && status == PaginationStatus::CanLoadMore {
            self.load_more(cx);
        }

        self.sync_lightbox(cx);
        cx.notify();
    }

    /// The grid's keys and shapes: the jobs, then the images.
    fn rebuild_grid_items(&mut self) {
        self.grid_keys = Rc::new(
            self.jobs
                .shown
                .iter()
                .map(|job| job_key(job))
                .chain(self.images.iter().map(|image| image.key.clone()))
                .collect(),
        );
        self.grid_aspects = Rc::new(
            self.jobs
                .shown
                .iter()
                .map(|job| job.form_state.aspect())
                .chain(
                    self.images
                        .iter()
                        .map(|image| image.generation.form_state.aspect()),
                )
                .collect(),
        );
        self.grid_revision += 1;
    }

    fn load_more(&mut self, cx: &mut Context<Self>) {
        let size = self.page_size();
        if let Some(generations) = self.generations.get() {
            generations.update(cx, |generations, cx| generations.load_more(size, cx));
        }
    }

    /// Deletes every failed job (the server's, not only the loaded ones). No
    /// confirmation, as on the web: a failure holds an error, not an image.
    fn remove_all_failed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.removing_failed {
            return;
        }
        self.removing_failed = true;
        cx.notify();
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(generations::REMOVE_ALL_FAILED, &NoArgs {}, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result: Result<f64, CallError> = task.await;
            let _ = this.update(cx, |this, cx| {
                this.removing_failed = false;
                cx.notify();
            });
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(removed) => {
                    let removed = removed as usize;
                    let plural = if removed == 1 { "" } else { "s" };
                    window.push_notification(
                        Notification::success(format!(
                            "Removed {removed} failed generation{plural}"
                        )),
                        cx,
                    );
                }
                Err(error) => window.push_notification(
                    Notification::error(format!(
                        "Couldn\u{2019}t remove the failed generations. {}",
                        error.user_message()
                    )),
                    cx,
                ),
            });
        })
        .detach();
    }

    fn image(&self, key: &str) -> Option<&GalleryImage> {
        self.images.iter().find(|image| &*image.key == key)
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

    fn click_tile(
        &mut self,
        key: SharedString,
        shift: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_selecting() || shift {
            if shift {
                self.selection.extend_to(&key, keys(&self.images));
            } else {
                self.selection.toggle(&key);
            }
            // Escape and Delete act on the selection from here.
            self.focus_handle.focus(window, cx);
            cx.notify();
            return;
        }
        self.open_lightbox(key, window, cx);
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

    fn confirm_delete_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.deleting {
            return;
        }
        let images = by_key(&self.images);
        let targets: Vec<ImageRef> = self
            .selection
            .ordered(keys(&self.images))
            .iter()
            .filter_map(|key| images.get(key.as_str()))
            .map(|image| image.image_ref())
            .collect();
        if targets.is_empty() {
            return;
        }
        let count = targets.len();
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let targets = targets.clone();
            let view = view.clone();
            alert
                .title(format!("Delete {}?", images_label(count)))
                .description("This cannot be undone.")
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let targets = targets.clone();
                    let _ = view.update(cx, |this, cx| this.delete_images(targets, window, cx));
                    true
                })
        });
    }

    fn delete_images(
        &mut self,
        images: Vec<ImageRef>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.deleting = true;
        cx.notify();
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(generations::REMOVE_IMAGES, &RemoveImagesArgs { images }, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result: Result<f64, CallError> = task.await;
            let _ = this.update(cx, |this, cx| {
                this.deleting = false;
                if result.is_ok() {
                    this.exit_selection(cx);
                }
                cx.notify();
            });
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(removed) => window.push_notification(
                    Notification::success(format!("Deleted {}", images_label(removed as usize))),
                    cx,
                ),
                Err(error) => window.push_notification(
                    Notification::error(format!(
                        "Couldn\u{2019}t delete the images. {}",
                        error.user_message()
                    )),
                    cx,
                ),
            });
        })
        .detach();
    }

    // --- Commands -------------------------------------------------------

    fn toggle_args(image: &GalleryImage) -> ToggleArgs {
        ToggleArgs {
            generation_id: Some(image.generation.id.clone()),
            b2_key: image.b2_key.clone(),
            ..ToggleArgs::default()
        }
    }

    fn tile_actions(&self, image: &GalleryImage, cx: &Context<Self>) -> Vec<TileAction> {
        image_actions(
            &cx.entity().downgrade(),
            &image.generation,
            &image.b2_key,
            image.key.clone(),
            self.copied.is(&image.key),
        )
    }

    /// The viewer's bar: the heart (once favourites are known), the tile's
    /// commands, then Download.
    fn lightbox_actions(&self, key: &str, cx: &Context<Self>) -> Vec<TileAction> {
        let Some(image) = self.image(key) else {
            return Vec::new();
        };
        let mut actions: Vec<TileAction> =
            FavoriteHearts::viewer_action(&self.hearts, Self::toggle_args(image), cx)
                .into_iter()
                .collect();
        actions.extend(self.tile_actions(image, cx));
        actions.push(download_action(&image.b2_key, cx));
        actions
    }

    // --- Viewer ---------------------------------------------------------

    fn lightbox_items(&self, cx: &App) -> Vec<LightboxItem> {
        let urls = Media::urls(cx);
        self.images
            .iter()
            .map(|image| lightbox_item(image.key.clone(), &image.b2_key, urls))
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
                let generation = view.read(cx).image(&item.key)?.generation.clone();
                Some(details(&generation, cx))
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
                    LightboxEvent::LoadMore => this.load_more(cx),
                },
            );
        lightbox.read(cx).focus_handle(cx).focus(window, cx);
        self.lightbox = Some((lightbox, subscription));
        cx.notify();
    }

    // --- Rendering ------------------------------------------------------

    fn render_header(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.kind == GalleryKind::Results {
            return self.render_results_header(cx);
        }
        let loading_first = self.status == PaginationStatus::LoadingFirstPage;
        let selecting = self.is_selecting();
        h_flex()
            .px_4()
            .pt_4()
            .gap_3()
            .child(
                div()
                    .flex_1()
                    .text_xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Gallery"),
            )
            .when(self.status == PaginationStatus::LoadingMore, |this| {
                this.child(
                    h_flex()
                        .gap_2()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(Spinner::new().small())
                        .child("Loading more…"),
                )
            })
            .child(
                Button::new("select")
                    .small()
                    .when(selecting, |button| button.secondary())
                    .when(!selecting, |button| button.outline())
                    .label(if selecting { "Cancel" } else { "Select" })
                    .disabled(loading_first && self.images.is_empty())
                    .on_click(
                        cx.listener(|this, _, window, cx| this.toggle_selection_mode(window, cx)),
                    ),
            )
            .into_any_element()
    }

    /// The results column's header, a bar like the settings column's.
    fn render_results_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let selecting = self.is_selecting();
        let scale = ZoomScale::TILES.clamp(Preferences::get(cx, &RESULTS_TILE_SCALE));
        let view = cx.entity().downgrade();
        let running = self.jobs.running;
        h_flex()
            .p_3()
            .gap_3()
            .justify_between()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Results"),
            )
            .child(
                h_flex()
                    .gap_3()
                    .child(
                        ZoomControl::new("preview-zoom", scale, ZoomScale::TILES, "previews")
                            .on_change(move |factor, _, cx| {
                                Preferences::set(cx, &RESULTS_TILE_SCALE, factor);
                                let _ = view.update(cx, |_, cx| cx.notify());
                            }),
                    )
                    .when(running > 0, |this| {
                        this.child(
                            h_flex()
                                .gap_2()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(Spinner::new().small())
                                .child(format!("{running} generating…")),
                        )
                    })
                    .when(self.status == PaginationStatus::LoadingMore, |this| {
                        this.child(
                            h_flex()
                                .gap_2()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(Spinner::new().small())
                                .child("Loading more…"),
                        )
                    })
                    .when(self.jobs.failed > 0, |this| {
                        this.child(
                            Button::new("remove-failed")
                                .small()
                                .outline()
                                .text_color(cx.theme().danger)
                                .icon(IconName::Trash)
                                .label("Remove all failed")
                                .loading(self.removing_failed)
                                .disabled(self.removing_failed)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.remove_all_failed(window, cx)
                                })),
                        )
                    })
                    .when(!self.images.is_empty(), |this| {
                        this.child(
                            Button::new("select")
                                .small()
                                .when(selecting, |button| button.secondary())
                                .when(!selecting, |button| button.outline())
                                .label(if selecting { "Cancel" } else { "Select" })
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.toggle_selection_mode(window, cx)
                                })),
                        )
                    }),
            )
            .into_any_element()
    }

    fn render_grid(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if self.kind == GalleryKind::Results && self.images.is_empty() && self.jobs.shown.is_empty()
        {
            return match self.status {
                PaginationStatus::Failed => message_state(
                    "Couldn\u{2019}t load the results",
                    self.error.clone().unwrap_or_default(),
                    cx,
                ),
                _ => message_state(
                    "No results yet",
                    "Generated images will appear here".into(),
                    cx,
                ),
            };
        }
        if self.images.is_empty() && self.jobs.shown.is_empty() {
            return match self.status {
                PaginationStatus::Failed => message_state(
                    "Couldn\u{2019}t load the gallery",
                    self.error.clone().unwrap_or_default(),
                    cx,
                ),
                PaginationStatus::Exhausted => message_state(
                    "No images yet",
                    "Generate some images to see them appear in your gallery.".into(),
                    cx,
                ),
                // First page, or rows without output while the next page loads.
                _ => skeleton(cx),
            };
        }

        let tile_scale = match self.kind {
            GalleryKind::Gallery => 1.0,
            GalleryKind::Results => {
                ZoomScale::TILES.clamp(Preferences::get(cx, &RESULTS_TILE_SCALE))
            }
        };
        let (keys, aspects) = (self.grid_keys.clone(), self.grid_aspects.clone());
        self.grid_sync.sync(
            &mut self.grid,
            self.grid_revision,
            tile_scale,
            window,
            || (keys.to_vec(), aspects.to_vec()),
        );

        let urls = Media::urls(cx).clone();
        let jobs = self.jobs.clone();
        let images = self.images.clone();
        let tiles = self.tiles.clone();
        let view = cx.entity();
        let hearts = self.hearts.clone();
        let results = self.kind == GalleryKind::Results;

        div()
            .flex_1()
            .min_h_0()
            .px_4()
            .pb_4()
            .when(results, |this| this.pt_3())
            .child(self.grid.render(view.entity_id(), move |ix, size, _, cx| {
                // A job's spinner turns every frame: never worth caching.
                if let Some(job) = jobs.shown.get(ix) {
                    return job_tile(job, size, cx);
                }
                let Some(image) = images.get(ix - jobs.shown.len()) else {
                    return div().into_any_element();
                };
                let favorited = hearts.read(cx).favorited(&image.b2_key);
                let (selected, copied) = {
                    let this = view.read(cx);
                    let selected = this
                        .is_selecting()
                        .then(|| this.selection.is_selected(&image.key));
                    (selected, this.copied.is(&image.key))
                };
                let revision = (Same(image.generation.clone()), favorited, selected, copied);
                tiles.borrow_mut().element(
                    &image.key,
                    size,
                    revision,
                    false,
                    || {
                        image_tile(
                            image.clone(),
                            TileState {
                                favorited,
                                selected,
                                copied,
                            },
                            view.downgrade(),
                            hearts.clone(),
                            &urls,
                        )
                    },
                    cx,
                )
            }))
            .into_any_element()
    }

    fn render_selection_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.selection.is_empty() {
            return None;
        }
        let count = self.selection.len();
        Some(
            h_flex()
                .absolute()
                .bottom_4()
                .left_0()
                .right_0()
                .justify_center()
                .child(
                    h_flex()
                        .gap_2()
                        .px_3()
                        .py_1p5()
                        .rounded_full()
                        .border_1()
                        .border_color(cx.theme().border)
                        .bg(cx.theme().popover)
                        .shadow_lg()
                        .child(div().text_sm().child(format!("{count} selected")))
                        .child(
                            Button::new("delete-selection")
                                .small()
                                .danger()
                                .icon(IconName::Trash)
                                .label("Delete")
                                .loading(self.deleting)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.confirm_delete_selection(window, cx)
                                })),
                        )
                        .child(
                            Button::new("clear-selection")
                                .small()
                                .ghost()
                                .icon(IconName::X)
                                .tooltip("Clear selection")
                                .on_click(cx.listener(|this, _, _, cx| this.exit_selection(cx))),
                        ),
                )
                .into_any_element(),
        )
    }
}

/// What a tile shows besides its image.
struct TileState {
    favorited: Option<bool>,
    selected: Option<bool>,
    copied: bool,
}

/// Draws one image's tile: its preview, the heart (once favourites are
/// known), the selection mark or its commands. Made once per revision.
fn image_tile(
    image: GalleryImage,
    state: TileState,
    view: WeakEntity<GalleryView>,
    hearts: Entity<FavoriteHearts>,
    urls: &MediaUrls,
) -> TileRenderer {
    let preview = preview(&image.b2_key, urls);
    let original = original(&image.b2_key, urls);
    let checkpoint: SharedString =
        short_checkpoint_name(&image.generation.form_state.checkpoint).into();
    Rc::new(move |size, _, _| {
        let click_view = view.clone();
        let key = image.key.clone();
        let mut tile = MediaTile::new(image.key.clone(), preview.clone(), size)
            .original(original.clone())
            .when(!checkpoint.is_empty(), |tile| {
                tile.badge(checkpoint.clone())
            })
            .on_click(move |event, window, cx| {
                let key = key.clone();
                let shift = event.modifiers().shift;
                let _ = click_view.update(cx, |this, cx| this.click_tile(key, shift, window, cx));
            });
        if let Some(favorited) = state.favorited {
            let hearts = hearts.clone();
            let args = GalleryView::toggle_args(&image);
            tile = tile.favorite(favorited, move |window, cx| {
                hearts.update(cx, |hearts, cx| hearts.toggle(args.clone(), window, cx));
            });
        }
        match state.selected {
            Some(selected) => tile = tile.selection(selected),
            None => {
                let actions = image_actions(
                    &view,
                    &image.generation,
                    &image.b2_key,
                    image.key.clone(),
                    state.copied,
                );
                for action in actions {
                    tile = tile.action(action);
                }
            }
        }
        tile.into_any_element()
    })
}

fn images_label(count: usize) -> String {
    if count == 1 {
        "1 image".into()
    } else {
        format!("{count} images")
    }
}

fn skeleton(cx: &App) -> AnyElement {
    h_flex()
        .flex_1()
        .min_h_0()
        .px_4()
        .flex_wrap()
        .content_start()
        .items_start()
        .gap_2()
        .overflow_hidden()
        .children(SKELETON_ASPECTS.iter().map(|aspect| {
            Skeleton::new()
                .h(rems(14.))
                .w(rems(14. * aspect))
                .rounded(cx.theme().radius)
        }))
        .into_any_element()
}

/// The empty and failed states: a title and a line of explanation.
fn message_state(title: &'static str, body: SharedString, cx: &App) -> AnyElement {
    v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_1()
        .child(
            div()
                .text_lg()
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .child(
            div()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .child(body),
        )
        .into_any_element()
}

impl Focusable for GalleryView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for GalleryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let grid = self.render_grid(window, cx);
        let selection_bar = self.render_selection_bar(cx);
        let lightbox = self.lightbox.as_ref().map(|(lightbox, _)| lightbox.clone());

        let gap = match self.kind {
            GalleryKind::Gallery => rems(0.75),
            GalleryKind::Results => rems(0.),
        };
        v_flex()
            .id("gallery")
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::on_exit_selection))
            .on_action(cx.listener(Self::on_delete_selection))
            .relative()
            .size_full()
            .gap(gap)
            .child(self.render_header(cx))
            .child(grid)
            .children(selection_bar)
            .children(lightbox)
    }
}

#[cfg(test)]
mod tests {
    use super::images_label;

    #[test]
    fn counts_images() {
        assert_eq!(images_label(1), "1 image");
        assert_eq!(images_label(3), "3 images");
    }
}
