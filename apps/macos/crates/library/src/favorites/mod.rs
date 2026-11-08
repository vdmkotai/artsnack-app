//! Favorites: folders, filters, a grid of everything hearted, multi-select to
//! file or remove, and the viewer.
//!
//! Responsiveness rules carried over from the web (AGENTS.md):
//! - a filter click changes the chips in the same frame and narrows the rows
//!   already held with the server's own predicate; the new query result
//!   replaces them when it lands — controls never unmount, no page skeleton;
//! - revisiting is instant: the last result for these filters is remembered;
//! - the filter survives a restart (the web keeps it in the URL);
//! - removing a favourite takes it off the grid at once; a failed removal
//!   puts it back.
//!
//! While a clip plays the screen draws every frame, so nothing a frame needs
//! is worked out in `render`: the rows, their keys and shapes, an index by id
//! ([`Shown`]) and the folder and filter chips ([`FilterBar`]) are prepared
//! when the data or the filter changes, and each tile is a cached view that
//! only the playing ones bypass.
//!
//! Hidden ([`FavoritesView::set_active`]), the clips stop and the viewer
//! closes at once, and the subscriptions go after a grace period.

mod item;

use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap, HashSet},
    rc::Rc,
    sync::Arc,
};

use artsnack_backend::{
    Backend, LivePaginatedQuery, LiveQuery, NoArgs, PaginationStatus, QueryState,
    api::favorites::{
        self, CreateFolderArgs, Facets, FacetsArgs, Favorite, FavoriteFilter, Folder, Folders,
        MediaType, MoveToFolderArgs, RemoveByKeyArgs, RemoveFolderArgs, RemoveManyArgs,
        RenameFolderArgs, provider, short_checkpoint_name,
    },
};
use artsnack_media::{Media, MediaUrls};
use artsnack_settings::{Preference, Preferences};
use artsnack_ui::{
    ClipChooser, ClipPlayers, Lightbox, LightboxEvent, LightboxItem, MediaGridState, MediaTile,
    TileAction,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, ClipboardItem, Context, Entity, EventEmitter,
    FocusHandle, Focusable, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, Styled as _, Subscription, Task, WeakEntity, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Selectable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonGroup, ButtonVariant, ButtonVariants as _},
        dialog::{DialogAction, DialogClose, DialogFooter},
        h_flex,
        input::{Input, InputEvent, InputState},
        menu::{DropdownMenu as _, PopupMenuItem},
        notification::Notification,
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

use crate::{
    command::MediaCommand,
    feed::{Feed, release_after_grace},
    grid_sync::GridSync,
    selection::Selection,
    tile_view::{Same, TileRenderer, TileViews},
};

/// First page, as the web loads it.
const PAGE_SIZE: usize = 30;
/// With a column filter on, the server filters after paging and pages come
/// back sparse; ask for more at a time.
const FILTERED_PAGE_SIZE: usize = 90;

const FILTER: Preference<FavoriteFilter> =
    Preference::new("favorites.filter", FavoriteFilter::default);

/// A tile's revision: its row by identity, its selection mark, and whether its
/// clip is playing (a stopped clip goes back to its poster).
type TileRevision = (Same<Favorite>, Option<bool>, bool);

/// The rows on screen and what the grid needs of them.
#[derive(Default)]
struct Shown {
    rows: Rc<Vec<Arc<Favorite>>>,
    keys: Rc<Vec<SharedString>>,
    aspects: Rc<Vec<f32>>,
    /// Position by favourite id.
    index: HashMap<SharedString, usize>,
    /// Bumped whenever the rows change.
    revision: u64,
}

impl Shown {
    fn get(&self, id: &str) -> Option<&Arc<Favorite>> {
        self.index.get(id).and_then(|ix| self.rows.get(*ix))
    }
}

/// A chip: its element id, label, and whether it is the current choice.
struct Chip {
    id: SharedString,
    label: SharedString,
    selected: bool,
}

/// The folder chips and the filter row as they read.
#[derive(Default)]
struct FilterBar {
    /// All, Unfiled, then one per folder, each with the folder it selects.
    folders: Vec<(Chip, Option<String>)>,
    /// The selected folder, once the live folder list is in: Rename and
    /// Delete never act on a remembered copy.
    selected_folder: Option<Folder>,
    /// All, Images, Videos.
    media: [SharedString; 3],
    /// Shown when there is a choice; a selected provider stays listed after
    /// its count drops to zero, so it can be cleared.
    providers: Vec<(Chip, String)>,
    /// Every checkpoint (value, menu label, checked); selected ones stay
    /// listed.
    checkpoints: Rc<Vec<(String, SharedString, bool)>>,
    checkpoints_label: SharedString,
}

pub struct FavoritesView {
    focus_handle: FocusHandle,
    filter: FavoriteFilter,
    favorites: Feed<LivePaginatedQuery<Favorite>>,
    folders: Feed<LiveQuery<Folders>>,
    facets: Feed<LiveQuery<Facets>>,
    /// The query's rows as last read; kept while the subscriptions are released.
    rows: Arc<Vec<Arc<Favorite>>>,
    stale: bool,
    status: PaginationStatus,
    error: Option<SharedString>,
    folders_data: Option<(Arc<Folders>, bool)>,
    facets_data: Option<Arc<Facets>>,
    shown: Shown,
    bar: FilterBar,
    grid: MediaGridState,
    grid_sync: GridSync,
    tiles: Rc<RefCell<TileViews<TileRevision>>>,
    /// Which clips play (the four nearest the centre, muted) and their players.
    clips: ClipChooser,
    players: ClipPlayers,
    selection: Option<Selection>,
    /// Favourites being removed, by id: off the grid until the live list
    /// drops them, or back if the removal fails.
    removing: HashSet<String>,
    /// Favourites being filed, by id, with the folder they go to: shown where
    /// that folder puts them until the live list agrees, or back where they
    /// were if the move fails.
    moving: HashMap<String, Option<String>>,
    lightbox: Option<(Entity<Lightbox>, Subscription)>,
    folder_name: Option<(Entity<InputState>, Subscription)>,
    busy: bool,
    active: bool,
    _release: Option<Task<()>>,
}

impl EventEmitter<MediaCommand> for FavoritesView {}

impl FavoritesView {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let grid = MediaGridState::new();
        let view = cx.entity().downgrade();
        grid.on_near_end(move |cx| {
            let _ = view.update(cx, |this, cx| this.load_more(cx));
        });

        let mut this = Self {
            focus_handle: cx.focus_handle(),
            filter: Preferences::get(cx, &FILTER),
            favorites: Feed::default(),
            folders: Feed::default(),
            facets: Feed::default(),
            rows: Arc::default(),
            stale: false,
            status: PaginationStatus::LoadingFirstPage,
            error: None,
            folders_data: None,
            facets_data: None,
            shown: Shown::default(),
            bar: FilterBar::default(),
            grid,
            grid_sync: GridSync::default(),
            tiles: Rc::default(),
            clips: ClipChooser::default(),
            players: ClipPlayers::default(),
            selection: None,
            removing: HashSet::new(),
            moving: HashMap::new(),
            lightbox: None,
            folder_name: None,
            busy: false,
            active: true,
            _release: None,
        };
        this.connect(cx);
        this
    }

    /// Subscribes to the favourites, folders and facets, starting from what
    /// they last delivered.
    fn connect(&mut self, cx: &mut Context<Self>) {
        let filter = self.filter.clone();
        self.favorites.connect(
            |cx| LivePaginatedQuery::new(favorites::LIST_FAVORITES, &filter, PAGE_SIZE, cx),
            Self::rows_changed,
            cx,
        );
        self.folders.connect(
            |cx| LiveQuery::new(favorites::LIST_FOLDERS, &NoArgs {}, cx),
            Self::chips_changed,
            cx,
        );
        let args = FacetsArgs {
            folder_id: self.filter.folder_id.clone(),
        };
        self.facets.connect(
            |cx| LiveQuery::new(favorites::FACETS, &args, cx),
            Self::chips_changed,
            cx,
        );
        self.rows_changed(cx);
        self.chips_changed(cx);
    }

    /// Whether the screen is shown (the shell says so). Hidden, the clips
    /// stop and the viewer closes at once — a clip must not go on playing, or
    /// be heard, behind another screen — and the subscriptions go after a
    /// grace period. The rows, the filter and the scroll position stay.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if active == self.active {
            return;
        }
        self.active = active;
        if active {
            self._release = None;
            self.clips.set_suspended(false);
            self.connect(cx);
        } else {
            self.clips.set_suspended(true);
            self.players.sync(std::iter::empty());
            self.lightbox = None;
            self._release = Some(release_after_grace(cx, |this, _| {
                this.favorites.release();
                this.folders.release();
                this.facets.release();
            }));
        }
        cx.notify();
    }

    // --- Data -----------------------------------------------------------

    /// The query changed: read its rows, then work out what is shown.
    fn rows_changed(&mut self, cx: &mut Context<Self>) {
        let Some(query) = self.favorites.get() else {
            return;
        };
        let query = query.read(cx);
        let status = query.status();
        self.rows = query.rows().clone();
        self.stale = query.is_stale();
        self.error = query.error().cloned();
        let status_changed = status != self.status;
        self.status = status;
        // A removal is settled once the live list no longer has the row.
        if !self.stale {
            let present: HashSet<&str> = self.rows.iter().map(|row| row.id.as_str()).collect();
            self.removing.retain(|id| present.contains(id.as_str()));
            let rows = &self.rows;
            self.moving.retain(|id, folder| {
                rows.iter()
                    .any(|row| &row.id == id && row.folder_id != *folder)
            });
        }
        if !self.reshow(cx) && status_changed {
            // Whether the viewer can ask for more follows the status.
            self.sync_lightbox(cx);
        }

        // The server filters a page after reading it, so a filtered page can
        // come back empty while more remain: with nothing on the grid nothing
        // would ever ask for the next one.
        if self.shown.rows.is_empty() && self.status == PaginationStatus::CanLoadMore {
            self.load_more(cx);
        }
    }

    /// Rebuilds what is shown: the rows, narrowed by the current filter while
    /// they are still the previous filter's (or a remembered snapshot), less
    /// the favourites being removed. Returns whether they changed.
    fn reshow(&mut self, cx: &mut Context<Self>) -> bool {
        let rows: Vec<Arc<Favorite>> = self
            .rows
            .iter()
            .filter(|row| !self.stale || self.filter.matches(row))
            .filter(|row| !self.removing.contains(&row.id))
            .filter(|row| match self.moving.get(&row.id) {
                Some(folder) => self.filter.matches(&Favorite {
                    folder_id: folder.clone(),
                    ..row.as_ref().clone()
                }),
                None => true,
            })
            .cloned()
            .collect();
        let unchanged = rows.len() == self.shown.rows.len()
            && rows
                .iter()
                .zip(self.shown.rows.iter())
                .all(|(new, old)| Arc::ptr_eq(new, old));
        if !unchanged {
            let keys: Vec<SharedString> = rows.iter().map(|row| item::key(row)).collect();
            self.shown = Shown {
                aspects: Rc::new(rows.iter().map(|row| item::aspect(row)).collect()),
                index: keys
                    .iter()
                    .enumerate()
                    .map(|(ix, key)| (key.clone(), ix))
                    .collect(),
                keys: Rc::new(keys),
                rows: Rc::new(rows),
                revision: self.shown.revision + 1,
            };
            let index = &self.shown.index;
            if let Some(selection) = &mut self.selection {
                selection.retain_present(self.shown.rows.iter().map(|row| row.id.as_str()));
            }
            self.tiles
                .borrow_mut()
                .retain(|key| index.contains_key(key));
            self.sync_lightbox(cx);
        }
        cx.notify();
        !unchanged
    }

    /// The folders or the facets changed (or the filter did).
    fn chips_changed(&mut self, cx: &mut Context<Self>) {
        if let Some(folders) = self.folders.get() {
            let folders = folders.read(cx);
            if let Some(data) = folders.data() {
                let live = matches!(folders.state(), QueryState::Ready { stale: false, .. });
                self.folders_data = Some((data.clone(), live));
            }
        }
        if let Some(facets) = self.facets.get()
            && let Some(data) = facets.read(cx).data()
        {
            self.facets_data = Some(data.clone());
        }
        self.bar = FilterBar::new(
            &self.filter,
            self.folders_data.as_ref(),
            self.facets_data.as_deref(),
        );
        cx.notify();
    }

    fn sync_lightbox(&self, cx: &mut Context<Self>) {
        if let Some((lightbox, _)) = &self.lightbox {
            let urls = Media::urls(cx).clone();
            let items: Vec<LightboxItem> = self
                .shown
                .rows
                .iter()
                .map(|row| item::lightbox_item(row, &urls))
                .collect();
            let can_load_more = self.status == PaginationStatus::CanLoadMore;
            lightbox.update(cx, |lightbox, cx| {
                lightbox.set_items(items, can_load_more, cx)
            });
        }
    }

    fn load_more(&mut self, cx: &mut Context<Self>) {
        let size = if self.filter.has_column_filters() {
            FILTERED_PAGE_SIZE
        } else {
            PAGE_SIZE
        };
        if let Some(favorites) = self.favorites.get() {
            favorites.update(cx, |favorites, cx| favorites.load_more(size, cx));
        }
    }

    fn set_filter(&mut self, filter: FavoriteFilter, cx: &mut Context<Self>) {
        if filter == self.filter {
            return;
        }
        let folder_changed = filter.folder_id != self.filter.folder_id;
        self.filter = filter;
        Preferences::set(cx, &FILTER, self.filter.clone());
        let filter = self.filter.clone();
        if let Some(favorites) = self.favorites.get() {
            favorites.update(cx, |favorites, cx| favorites.set_args(&filter, cx));
        }
        if folder_changed && let Some(facets) = self.facets.get() {
            let args = FacetsArgs {
                folder_id: self.filter.folder_id.clone(),
            };
            facets.update(cx, |facets, cx| {
                facets.set_args(favorites::FACETS, &args, cx)
            });
        }
        // The chips follow the click in this frame, and the rows held are
        // narrowed with the new filter until its first page lands.
        self.rows_changed(cx);
        self.chips_changed(cx);
    }

    fn select_folder(&mut self, folder_id: Option<String>, cx: &mut Context<Self>) {
        let filter = FavoriteFilter {
            folder_id,
            ..self.filter.clone()
        };
        self.set_filter(filter, cx);
    }

    // --- Commands ---------------------------------------------------------

    /// Takes the favourite off the grid now and asks the server to follow;
    /// a failure puts it back. A second click finds it already gone.
    fn unfavorite(&mut self, favorite: &Favorite, window: &mut Window, cx: &mut Context<Self>) {
        if !self.removing.insert(favorite.id.clone()) {
            return;
        }
        self.reshow(cx);
        let args = RemoveByKeyArgs {
            b2_key: favorite.b2_key.clone(),
        };
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(favorites::REMOVE_BY_KEY, &args, cx)
        });
        let id = favorite.id.clone();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            if let Err(error) = task.await {
                let _ = this.update(cx, |this, cx| {
                    this.removing.remove(&id);
                    this.reshow(cx);
                });
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.push_notification(Notification::error(error.user_message()), cx);
                });
            }
        })
        .detach();
    }

    fn copy_prompt(prompt: &str, window: &mut Window, cx: &mut App) {
        cx.write_to_clipboard(ClipboardItem::new_string(prompt.to_string()));
        window.push_notification(Notification::success("Prompt copied"), cx);
    }

    /// A click on the tile of favourite `id` — by id, not position: the grid
    /// it was drawn in may have moved since.
    fn click_tile(
        &mut self,
        id: &str,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(favorite) = self.shown.get(id).cloned() else {
            return;
        };
        if let Some(selection) = &mut self.selection {
            if event.modifiers().shift {
                selection.extend_to(
                    &favorite.id,
                    self.shown.rows.iter().map(|row| row.id.as_str()),
                );
            } else {
                selection.toggle(&favorite.id);
            }
            cx.notify();
            return;
        }
        self.open_lightbox(item::key(&favorite), window, cx);
    }

    /// The viewer's bar for one favourite: Remove, the tile's commands,
    /// Download.
    fn lightbox_actions(&self, id: &str, cx: &mut Context<Self>) -> Vec<TileAction> {
        let Some(favorite) = self.shown.get(id).cloned() else {
            return Vec::new();
        };
        let view = cx.entity().downgrade();
        let mut actions = tile_actions(&view, &favorite, Media::urls(cx));
        actions.push(TileAction::download(&favorite.b2_key, cx));
        actions.insert(
            0,
            TileAction::new(
                "unfavorite",
                IconName::HeartOff,
                "Remove from favorites",
                move |window, cx| {
                    let favorite = favorite.clone();
                    let _ = view.update(cx, |this, cx| this.unfavorite(&favorite, window, cx));
                },
            ),
        );
        actions
    }

    fn open_lightbox(&mut self, key: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let urls = Media::urls(cx).clone();
        let items = self
            .shown
            .rows
            .iter()
            .map(|row| item::lightbox_item(row, &urls))
            .collect();
        let can_load_more = self.status == PaginationStatus::CanLoadMore;
        let view = cx.entity().downgrade();
        let details_view = view.clone();

        let lightbox = Lightbox::new(
            items,
            key,
            can_load_more,
            move |item, _, cx| {
                view.upgrade()
                    .map(|view| view.update(cx, |this, cx| this.lightbox_actions(&item.key, cx)))
                    .unwrap_or_default()
            },
            move |item, _, cx| {
                let view = details_view.upgrade()?;
                let favorite = view.read(cx).shown.get(&item.key)?.clone();
                Some(details(&favorite, cx))
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

    // --- Selection ------------------------------------------------------

    fn toggle_selection_mode(&mut self, cx: &mut Context<Self>) {
        self.selection = match self.selection {
            Some(_) => None,
            None => Some(Selection::default()),
        };
        cx.notify();
    }

    fn selected_ids(&self) -> Vec<String> {
        self.selection
            .as_ref()
            .map(|selection| selection.ordered(self.shown.rows.iter().map(|row| row.id.as_str())))
            .unwrap_or_default()
    }

    /// Files `ids` into `folder` (`None` takes them out of every folder).
    fn move_to_folder(
        &mut self,
        ids: Vec<String>,
        folder: Option<(String, SharedString)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if ids.is_empty() {
            return;
        }
        let count = ids.len();
        let folder_id = folder.as_ref().map(|(id, _)| id.clone());
        // Filed now: inside another folder they leave the grid this frame.
        for id in &ids {
            self.moving.insert(id.clone(), folder_id.clone());
        }
        if let Some(selection) = &mut self.selection {
            selection.clear();
        }
        self.reshow(cx);
        let args = MoveToFolderArgs {
            favorite_ids: ids.clone(),
            folder_id,
        };
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(favorites::MOVE_TO_FOLDER, &args, cx)
        });
        let message = match &folder {
            Some((_, name)) => format!("Moved {count} to \u{201c}{name}\u{201d}"),
            None => format!("Removed {count} from folders"),
        };
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            if result.is_err() {
                let _ = this.update(cx, |this, cx| {
                    for id in &ids {
                        this.moving.remove(id);
                    }
                    this.reshow(cx);
                });
            }
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(()) => window.push_notification(Notification::success(message), cx),
                Err(error) => {
                    window.push_notification(Notification::error(error.user_message()), cx)
                }
            });
        })
        .detach();
    }

    fn confirm_remove_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.selected_ids();
        if ids.is_empty() {
            return;
        }
        let count = ids.len();
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let ids = ids.clone();
            let view = view.clone();
            alert
                .title(format!("Remove {count} from favorites?"))
                .description("The images themselves are not deleted.")
                .confirm()
                .ok_text("Remove")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let ids = ids.clone();
                    let _ = view.update(cx, |this, cx| this.remove_many(ids, window, cx));
                    true
                })
        });
    }

    /// Takes `ids` off the grid now and removes them; a failure puts them
    /// back.
    fn remove_many(&mut self, ids: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.removing.extend(ids.iter().cloned());
        if let Some(selection) = &mut self.selection {
            selection.clear();
        }
        self.reshow(cx);
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(
                favorites::REMOVE_MANY,
                &RemoveManyArgs {
                    favorite_ids: ids.clone(),
                },
                cx,
            )
        });
        self.busy = true;
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                if result.is_err() {
                    for id in &ids {
                        this.removing.remove(id);
                    }
                }
                this.reshow(cx);
            });
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(()) => {
                    window.push_notification(Notification::success("Removed from favorites"), cx)
                }
                Err(error) => {
                    window.push_notification(Notification::error(error.user_message()), cx)
                }
            });
        })
        .detach();
    }

    /// Runs a write, then reports how it went.
    fn run(
        &mut self,
        task: gpui_kit::Task<Result<(), artsnack_backend::CallError>>,
        success: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.busy = true;
        cx.notify();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                cx.notify();
            });
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(()) => window.push_notification(Notification::success(success), cx),
                Err(error) => {
                    window.push_notification(Notification::error(error.user_message()), cx)
                }
            });
        })
        .detach();
    }

    // --- Folders --------------------------------------------------------

    /// Opens the name dialog: a new folder (`rename: None`), or a rename.
    /// `then_move` files these favourites into the new folder once it exists —
    /// the ones selected when the command was given, whatever the selection
    /// is by the time the server answers.
    fn open_folder_dialog(
        &mut self,
        rename: Option<(String, String)>,
        then_move: Option<Vec<String>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let initial = rename
            .as_ref()
            .map(|(_, name)| name.clone())
            .unwrap_or_default();
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Folder name")
                .default_value(initial)
        });
        let submit = {
            let rename = rename.clone();
            move |this: &mut Self, window: &mut Window, cx: &mut Context<Self>| {
                let Some((input, _)) = &this.folder_name else {
                    return;
                };
                let name = input.read(cx).value().trim().to_string();
                if name.is_empty() {
                    return;
                }
                window.close_dialog(cx);
                this.folder_name = None;
                this.save_folder(name, rename.clone(), then_move.clone(), window, cx);
            }
        };
        let on_enter = submit.clone();
        let subscription = cx.subscribe_in(&input, window, move |this, _, event, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                on_enter(this, window, cx);
            }
        });
        self.folder_name = Some((input.clone(), subscription));

        let title = if rename.is_some() {
            "Rename folder"
        } else {
            "New folder"
        };
        let action = if rename.is_some() { "Rename" } else { "Create" };
        let view = cx.entity().downgrade();
        let focused = std::cell::Cell::new(false);
        window.open_dialog(cx, move |dialog, window, cx| {
            if !focused.replace(true) {
                input.read(cx).focus_handle(cx).focus(window, cx);
            }
            let view = view.clone();
            let submit = submit.clone();
            dialog
                .title(title)
                .w(gpui_kit::px(420.))
                .child(Input::new(&input))
                .on_ok(move |_, window, cx| {
                    let submit = submit.clone();
                    let _ = view.update(cx, |this, cx| submit(this, window, cx));
                    false
                })
                .footer(
                    DialogFooter::new()
                        .gap_2()
                        .child(
                            DialogClose::new()
                                .child(Button::new("cancel").outline().label("Cancel")),
                        )
                        .child(
                            DialogAction::new().child(Button::new("save").primary().label(action)),
                        ),
                )
        });
    }

    fn save_folder(
        &mut self,
        name: String,
        rename: Option<(String, String)>,
        then_move: Option<Vec<String>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let backend = Backend::global(cx);
        let window_handle = window.window_handle();
        match rename {
            Some((folder_id, _)) => {
                let task = backend.update(cx, |backend, cx| {
                    backend.mutate(
                        favorites::RENAME_FOLDER,
                        &RenameFolderArgs { folder_id, name },
                        cx,
                    )
                });
                self.run(task, "Folder renamed".to_string(), window, cx);
            }
            None => {
                let task = backend.update(cx, |backend, cx| {
                    backend.mutate(
                        favorites::CREATE_FOLDER,
                        &CreateFolderArgs { name: name.clone() },
                        cx,
                    )
                });
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    let _ = window_handle.update(cx, |_, window, cx| match result {
                        Ok(created) => {
                            let _ = this.update(cx, |this, cx| match then_move {
                                Some(ids) => this.move_to_folder(
                                    ids,
                                    Some((created.folder_id, name.into())),
                                    window,
                                    cx,
                                ),
                                None => this.select_folder(Some(created.folder_id), cx),
                            });
                        }
                        Err(error) => {
                            window.push_notification(Notification::error(error.user_message()), cx)
                        }
                    });
                })
                .detach();
            }
        }
    }

    fn confirm_delete_folder(
        &mut self,
        folder_id: String,
        name: String,
        count: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            let folder_id = folder_id.clone();
            alert
                .title(format!("Delete \u{201c}{name}\u{201d}?"))
                .description(format!(
                    "Its {} favorites go back to the main list.",
                    count as u64
                ))
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let folder_id = folder_id.clone();
                    let _ = view.update(cx, |this, cx| {
                        let task = Backend::global(cx).update(cx, |backend, cx| {
                            backend.mutate(
                                favorites::REMOVE_FOLDER,
                                &RemoveFolderArgs { folder_id },
                                cx,
                            )
                        });
                        this.run(task, "Folder deleted".to_string(), window, cx);
                        this.select_folder(None, cx);
                    });
                    true
                })
        });
    }

    // --- Rendering ------------------------------------------------------

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .px_4()
            .pt_4()
            .justify_between()
            .child(
                div()
                    .text_xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Favorites"),
            )
            .child(
                Button::new("select")
                    .small()
                    .when(self.selection.is_some(), |button| button.primary())
                    .when(self.selection.is_none(), |button| button.outline())
                    .label(if self.selection.is_some() {
                        "Done"
                    } else {
                        "Select"
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_selection_mode(cx))),
            )
    }

    fn render_folders(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let mut row = h_flex().px_4().gap_1p5().flex_wrap();
        for (chip, target) in &self.bar.folders {
            let target = target.clone();
            row = row.child(
                Button::new(chip.id.clone())
                    .small()
                    .when(chip.selected, |button| button.primary())
                    .when(!chip.selected, |button| button.outline())
                    .label(chip.label.clone())
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.select_folder(target.clone(), cx)),
                    ),
            );
        }
        row = row.child(
            Button::new("new-folder")
                .small()
                .ghost()
                .icon(IconName::FolderPlus)
                .label("New folder")
                .on_click(cx.listener(|this, _, window, cx| {
                    this.open_folder_dialog(None, None, window, cx)
                })),
        );
        if let Some(folder) = &self.bar.selected_folder {
            let rename = (folder.id.clone(), folder.name.clone());
            let (id, name, count) = (folder.id.clone(), folder.name.clone(), folder.count);
            row = row
                .child(
                    Button::new("rename-folder")
                        .small()
                        .ghost()
                        .icon(IconName::Pencil)
                        .tooltip("Rename folder")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_folder_dialog(Some(rename.clone()), None, window, cx)
                        })),
                )
                .child(
                    Button::new("delete-folder")
                        .small()
                        .ghost()
                        .icon(IconName::Trash)
                        .tooltip("Delete folder")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.confirm_delete_folder(id.clone(), name.clone(), count, window, cx)
                        })),
                );
        }
        row
    }

    fn render_filters(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let filter = &self.filter;
        let bar = &self.bar;
        let media = ButtonGroup::new("media-type")
            .small()
            .outline()
            .child(
                Button::new("media-all")
                    .label(bar.media[0].clone())
                    .selected(filter.media_type.is_none()),
            )
            .child(
                Button::new("media-image")
                    .label(bar.media[1].clone())
                    .selected(filter.media_type == Some(MediaType::Image)),
            )
            .child(
                Button::new("media-video")
                    .label(bar.media[2].clone())
                    .selected(filter.media_type == Some(MediaType::Video)),
            )
            .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                let media_type = match selected.first() {
                    Some(1) => Some(MediaType::Image),
                    Some(2) => Some(MediaType::Video),
                    _ => None,
                };
                let filter = FavoriteFilter {
                    media_type,
                    ..this.filter.clone()
                };
                this.set_filter(filter, cx);
            }));

        let view = cx.entity().downgrade();
        let checkpoints = bar.checkpoints.clone();

        h_flex()
            .px_4()
            .gap_1p5()
            .flex_wrap()
            .child(media)
            .children(bar.providers.iter().map(|(chip, value)| {
                let value = value.clone();
                Button::new(chip.id.clone())
                    .small()
                    .when(chip.selected, |button| button.primary().icon(IconName::X))
                    .when(!chip.selected, |button| button.outline())
                    .label(chip.label.clone())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let mut filter = this.filter.clone();
                        if let Some(ix) = filter.providers.iter().position(|p| *p == value) {
                            filter.providers.remove(ix);
                        } else {
                            filter.providers.push(value.clone());
                        }
                        this.set_filter(filter, cx);
                    }))
            }))
            .when(!checkpoints.is_empty(), |row| {
                row.child(
                    Button::new("checkpoints")
                        .small()
                        .outline()
                        .label(bar.checkpoints_label.clone())
                        .dropdown_caret(true)
                        .dropdown_menu(move |mut menu, window, _| {
                            menu = menu.max_h(window.rem_size() * 20.).scrollable(true);
                            for (value, label, checked) in checkpoints.iter() {
                                let view = view.clone();
                                let value = value.clone();
                                menu = menu.item(
                                    PopupMenuItem::new(label.clone())
                                        .checked(*checked)
                                        .on_click(move |_, _, cx| {
                                            let value = value.clone();
                                            let _ = view.update(cx, |this, cx| {
                                                let mut filter = this.filter.clone();
                                                if let Some(ix) = filter
                                                    .checkpoints
                                                    .iter()
                                                    .position(|c| *c == value)
                                                {
                                                    filter.checkpoints.remove(ix);
                                                } else {
                                                    filter.checkpoints.push(value);
                                                }
                                                this.set_filter(filter, cx);
                                            });
                                        }),
                                );
                            }
                            menu
                        }),
                )
            })
            .when(filter.has_column_filters(), |row| {
                row.child(
                    Button::new("clear-filters")
                        .small()
                        .ghost()
                        .label("Clear filters")
                        .on_click(cx.listener(|this, _, _, cx| {
                            let filter = FavoriteFilter {
                                folder_id: this.filter.folder_id.clone(),
                                ..FavoriteFilter::default()
                            };
                            this.set_filter(filter, cx);
                        })),
                )
            })
    }

    fn render_grid(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if self.shown.rows.is_empty() {
            // No grid, so no clip may go on playing.
            self.clips.choose(std::iter::empty(), self.grid.viewport());
            self.players.sync(std::iter::empty());
            let filtered = self.filter.folder_id.is_some() || self.filter.has_column_filters();
            return match self.status {
                PaginationStatus::Exhausted => empty_state(filtered, cx).into_any_element(),
                PaginationStatus::Failed => message(
                    "Couldn\u{2019}t load favorites",
                    self.error.clone().unwrap_or_default(),
                    cx,
                )
                .into_any_element(),
                // The first page, or a filtered page that came back empty
                // while more remain: still looking.
                _ => div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(Spinner::new())
                    .into_any_element(),
            };
        }

        let (keys, aspects) = (self.shown.keys.clone(), self.shown.aspects.clone());
        self.grid_sync
            .sync(&mut self.grid, self.shown.revision, 1.0, window, || {
                (keys.to_vec(), aspects.to_vec())
            });

        // Clips nearest the centre play, muted; none while the viewer is up.
        self.clips
            .set_suspended(self.lightbox.is_some() || !self.active);
        let rows = self.shown.rows.clone();
        let keys = self.shown.keys.clone();
        let clip_tiles: Vec<(SharedString, gpui_kit::Bounds<gpui_kit::Pixels>)> = self
            .grid
            .visible_tiles()
            .into_iter()
            .filter_map(|(ix, bounds)| {
                let row = rows.get(ix)?;
                (row.media_type == MediaType::Video).then(|| (keys[ix].clone(), bounds))
            })
            .collect();
        let urls = Media::urls(cx).clone();
        let shown = &self.shown;
        let playing: Vec<(SharedString, SharedString)> = self
            .clips
            .choose(clip_tiles, self.grid.viewport())
            .iter()
            .filter_map(|key| {
                let row = shown.get(key)?;
                Some((key.clone(), urls.video(&row.b2_key).into()))
            })
            .collect();
        // Each playing clip redraws its own surface (`ClipPlayers::surface`);
        // the grid is not re-rendered for its frames.
        self.players.sync(playing.iter().cloned());
        let playing: Rc<HashSet<SharedString>> =
            Rc::new(playing.into_iter().map(|(key, _)| key).collect());

        let players = self.players.clone();
        let tiles = self.tiles.clone();
        let view = cx.entity();

        div()
            .flex_1()
            .min_h_0()
            .px_4()
            .pb_4()
            .when(self.stale, |this| this.opacity(0.6))
            .child(self.grid.render(view.entity_id(), move |ix, size, _, cx| {
                let (Some(favorite), Some(key)) = (rows.get(ix), keys.get(ix)) else {
                    return div().into_any_element();
                };
                let selected = view
                    .read(cx)
                    .selection
                    .as_ref()
                    .map(|selection| selection.is_selected(&favorite.id));
                let live = playing.contains(key);
                let revision = (Same(favorite.clone()), selected, live);
                tiles.borrow_mut().element(
                    key,
                    size,
                    revision,
                    live,
                    || {
                        favorite_tile(
                            favorite.clone(),
                            selected,
                            live.then(|| players.clone()),
                            view.downgrade(),
                            &urls,
                        )
                    },
                    cx,
                )
            }))
            .into_any_element()
    }

    fn render_selection_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let selection = self.selection.as_ref()?;
        if selection.is_empty() {
            return None;
        }
        let count = selection.len();
        let folders = self
            .folders_data
            .as_ref()
            .map(|(data, _)| data.folders.clone())
            .unwrap_or_default();
        let view = cx.entity().downgrade();

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
                            Button::new("move-to-folder")
                                .small()
                                .outline()
                                .icon(IconName::FolderInput)
                                .label("Move to folder")
                                .loading(self.busy)
                                .dropdown_menu(move |mut menu, _, _| {
                                    let remove_view = view.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new("Remove from folder").on_click(
                                            move |_, window, cx| {
                                                let _ = remove_view.update(cx, |this, cx| {
                                                    let ids = this.selected_ids();
                                                    this.move_to_folder(ids, None, window, cx)
                                                });
                                            },
                                        ),
                                    );
                                    menu = menu.separator();
                                    for folder in &folders {
                                        let view = view.clone();
                                        let target = (
                                            folder.id.clone(),
                                            SharedString::from(folder.name.clone()),
                                        );
                                        menu = menu.item(
                                            PopupMenuItem::new(format!(
                                                "{} {}",
                                                folder.name, folder.count as u64
                                            ))
                                            .icon(IconName::Folder)
                                            .on_click(move |_, window, cx| {
                                                let target = target.clone();
                                                let _ = view.update(cx, |this, cx| {
                                                    let ids = this.selected_ids();
                                                    this.move_to_folder(
                                                        ids,
                                                        Some(target),
                                                        window,
                                                        cx,
                                                    )
                                                });
                                            }),
                                        );
                                    }
                                    let create_view = view.clone();
                                    menu.separator().item(
                                        PopupMenuItem::new("New folder…")
                                            .icon(IconName::FolderPlus)
                                            .on_click(move |_, window, cx| {
                                                let _ = create_view.update(cx, |this, cx| {
                                                    let ids = this.selected_ids();
                                                    this.open_folder_dialog(
                                                        None,
                                                        Some(ids),
                                                        window,
                                                        cx,
                                                    )
                                                });
                                            }),
                                    )
                                }),
                        )
                        .child(
                            Button::new("remove-selection")
                                .small()
                                .outline()
                                .icon(IconName::Trash)
                                .label("Remove")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.confirm_remove_selection(window, cx)
                                })),
                        )
                        .child(
                            Button::new("clear-selection")
                                .small()
                                .ghost()
                                .icon(IconName::X)
                                .tooltip("Clear selection")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some(selection) = &mut this.selection {
                                        selection.clear();
                                    }
                                    cx.notify();
                                })),
                        ),
                )
                .into_any_element(),
        )
    }
}

impl FilterBar {
    fn new(
        filter: &FavoriteFilter,
        folders: Option<&(Arc<Folders>, bool)>,
        facets: Option<&Facets>,
    ) -> Self {
        let count = |n: f64| n as u64;
        let current = filter.folder_id.as_deref();

        let mut folder_chips = Vec::new();
        let mut selected_folder = None;
        if let Some((data, live)) = folders {
            folder_chips.push((
                Chip {
                    id: "folder-all".into(),
                    label: format!("All {}", count(data.total)).into(),
                    selected: current.is_none(),
                },
                None,
            ));
            if !data.folders.is_empty() {
                folder_chips.push((
                    Chip {
                        id: "folder-unfiled".into(),
                        label: format!("Unfiled {}", count(data.unfiled)).into(),
                        selected: current == Some(FavoriteFilter::UNFILED),
                    },
                    Some(FavoriteFilter::UNFILED.to_string()),
                ));
            }
            for folder in &data.folders {
                let selected = current == Some(folder.id.as_str());
                folder_chips.push((
                    Chip {
                        id: format!("folder-{}", folder.id).into(),
                        label: format!("{} {}", folder.name, count(folder.count)).into(),
                        selected,
                    },
                    Some(folder.id.clone()),
                ));
                if selected && *live {
                    selected_folder = Some(folder.clone());
                }
            }
        }

        let media = match facets {
            Some(facets) => [
                format!("All {}", count(facets.total)).into(),
                format!("Images {}", count(facets.media_types.image)).into(),
                format!("Videos {}", count(facets.media_types.video)).into(),
            ],
            None => ["All".into(), "Images 0".into(), "Videos 0".into()],
        };

        let mut providers: Vec<(String, f64)> = facets
            .map(|facets| {
                facets
                    .providers
                    .iter()
                    .map(|facet| (facet.value.clone(), facet.count))
                    .collect()
            })
            .unwrap_or_default();
        for selected in &filter.providers {
            if !providers.iter().any(|(value, _)| value == selected) {
                providers.push((selected.clone(), 0.0));
            }
        }
        let show_providers = providers.len() >= 2 || !filter.providers.is_empty();
        let providers = if show_providers {
            providers
                .into_iter()
                .map(|(value, n)| {
                    let chip = Chip {
                        id: format!("provider-{value}").into(),
                        label: format!("{} {}", provider::label(&value), count(n)).into(),
                        selected: filter.providers.contains(&value),
                    };
                    (chip, value)
                })
                .collect()
        } else {
            Vec::new()
        };

        let mut checkpoints: Vec<(String, f64)> = facets
            .map(|facets| {
                facets
                    .checkpoints
                    .iter()
                    .map(|facet| (facet.value.clone(), facet.count))
                    .collect()
            })
            .unwrap_or_default();
        for selected in &filter.checkpoints {
            if !checkpoints.iter().any(|(value, _)| value == selected) {
                checkpoints.push((selected.clone(), 0.0));
            }
        }
        let selected: BTreeSet<&String> = filter.checkpoints.iter().collect();
        let checkpoints = checkpoints
            .into_iter()
            .map(|(value, n)| {
                let label = format!("{} {}", short_checkpoint_name(&value), count(n)).into();
                let checked = selected.contains(&value);
                (value, label, checked)
            })
            .collect();
        let checkpoints_label = if filter.checkpoints.is_empty() {
            "Checkpoint".into()
        } else {
            format!("Checkpoint · {}", filter.checkpoints.len()).into()
        };

        Self {
            folders: folder_chips,
            selected_folder,
            media,
            providers,
            checkpoints: Rc::new(checkpoints),
            checkpoints_label,
        }
    }
}

/// A favourite's hover commands: Reproduce, Send to Enhance and to the API
/// (images), Copy prompt.
fn tile_actions(
    view: &WeakEntity<FavoritesView>,
    favorite: &Arc<Favorite>,
    urls: &MediaUrls,
) -> Vec<TileAction> {
    let mut actions = Vec::new();

    if let Some(source) = item::reproduce_source(favorite) {
        let view = view.clone();
        actions.push(TileAction::new(
            "reproduce",
            IconName::RefreshCw,
            "Reproduce",
            move |_, cx| {
                let source = source.clone();
                let _ = view.update(cx, |_, cx| cx.emit(MediaCommand::Reproduce(source)));
            },
        ));
    }
    if favorite.media_type == MediaType::Image {
        let image_url: SharedString = urls.original(&favorite.b2_key).into();
        let form_state = favorite.form_state.clone();
        let enhance_view = view.clone();
        let enhance_url = image_url.clone();
        actions.push(TileAction::new(
            "enhance",
            IconName::Zap,
            "Send to Enhance",
            move |_, cx| {
                let command = MediaCommand::Enhance {
                    image_url: enhance_url.clone(),
                    form_state: form_state.clone(),
                };
                let _ = enhance_view.update(cx, |_, cx| cx.emit(command));
            },
        ));
        let reference_view = view.clone();
        actions.push(TileAction::new(
            "reference",
            IconName::Sparkles,
            "Send to API as reference",
            move |_, cx| {
                let command = MediaCommand::UseAsReference {
                    image_url: image_url.clone(),
                };
                let _ = reference_view.update(cx, |_, cx| cx.emit(command));
            },
        ));
    }
    if let Some(prompt) = favorite
        .prompt
        .clone()
        .filter(|prompt| !prompt.trim().is_empty())
    {
        actions.push(TileAction::new(
            "copy-prompt",
            IconName::Copy,
            "Copy prompt",
            move |window, cx| FavoritesView::copy_prompt(&prompt, window, cx),
        ));
    }
    actions
}

/// Draws one favourite's tile. Made once per revision; `players` is given
/// while its clip plays, and the tile then draws the clip's current frame on
/// every render.
fn favorite_tile(
    favorite: Arc<Favorite>,
    selected: Option<bool>,
    players: Option<ClipPlayers>,
    view: WeakEntity<FavoritesView>,
    urls: &MediaUrls,
) -> TileRenderer {
    let key = item::key(&favorite);
    let preview = item::preview(&favorite, urls);
    let original = item::original(&favorite, urls);
    let badge = item::badge(&favorite);
    let actions = tile_actions(&view, &favorite, urls);
    Rc::new(move |size, _, cx| {
        let heart_view = view.clone();
        let heart_favorite = favorite.clone();
        let click_view = view.clone();
        let id = favorite.id.clone();
        let mut tile = MediaTile::new(key.clone(), preview.clone(), size)
            .original(original.clone())
            .media(item::media(&favorite))
            .badge(badge.clone())
            .favorite(true, move |window, cx| {
                let favorite = heart_favorite.clone();
                let _ = heart_view.update(cx, |this, cx| this.unfavorite(&favorite, window, cx));
            })
            .on_click(move |event, window, cx| {
                let _ = click_view.update(cx, |this, cx| this.click_tile(&id, event, window, cx));
            });
        if let Some(surface) = players
            .as_ref()
            .and_then(|players| players.surface(&key, cx))
        {
            tile = tile.overlay(div().absolute().inset_0().child(surface));
        }
        if let Some(selected) = selected {
            tile = tile.selection(selected);
        }
        for action in &actions {
            tile = tile.action(action.clone());
        }
        tile.into_any_element()
    })
}

fn empty_state(filtered: bool, cx: &App) -> impl IntoElement {
    let (title, body) = if filtered {
        (
            "Nothing here",
            "No favorites match this folder and these filters.",
        )
    } else {
        (
            "No favorites yet",
            "Click the heart on any image or video to save it here.",
        )
    };
    message(title, body.into(), cx)
}

/// A title and a line of explanation, centred.
fn message(title: &'static str, body: SharedString, cx: &App) -> impl IntoElement {
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
}

/// The details panel for a favourite in the viewer.
fn details(favorite: &Favorite, cx: &App) -> AnyElement {
    let muted = cx.theme().muted_foreground;
    let field = |label: &'static str, value: String| {
        v_flex()
            .gap_0p5()
            .child(div().text_xs().text_color(muted).child(label))
            .child(div().text_sm().child(value))
    };
    v_flex()
        .p_4()
        .gap_3()
        .child(field(
            "Source",
            provider::label(&favorite.provider).to_string(),
        ))
        .when_some(favorite.checkpoint.clone(), |this, checkpoint| {
            this.child(field(
                "Checkpoint",
                short_checkpoint_name(&checkpoint).to_string(),
            ))
        })
        .when_some(favorite.prompt.clone(), |this, prompt| {
            this.child(field("Prompt", prompt))
        })
        .into_any_element()
}

impl Focusable for FavoritesView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for FavoritesView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let grid = self.render_grid(window, cx);
        let lightbox = self.lightbox.as_ref().map(|(lightbox, _)| lightbox.clone());
        let selection_bar = self.render_selection_bar(cx);

        v_flex()
            .id("favorites")
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            .gap_3()
            .child(self.render_header(cx))
            .child(self.render_folders(cx))
            .child(self.render_filters(cx))
            .child(grid)
            .children(selection_bar)
            .children(lightbox)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use artsnack_backend::api::favorites::{
        Facet, Facets, FavoriteFilter, Folder, Folders, MediaTypeCounts,
    };

    use super::FilterBar;

    fn folders() -> Arc<Folders> {
        Arc::new(Folders {
            folders: vec![Folder {
                id: "f1".into(),
                name: "Cats".into(),
                created_at: 0.0,
                count: 3.0,
            }],
            unfiled: 2.0,
            total: 5.0,
        })
    }

    fn facets() -> Facets {
        Facets {
            total: 5.0,
            media_types: MediaTypeCounts {
                image: 4.0,
                video: 1.0,
            },
            providers: vec![Facet {
                value: "grok".into(),
                count: 5.0,
            }],
            checkpoints: Vec::new(),
        }
    }

    #[test]
    fn the_bar_keeps_selections_listed_and_folder_commands_live() {
        let filter = FavoriteFilter {
            folder_id: Some("f1".into()),
            providers: vec!["fal".into()],
            checkpoints: vec!["a.safetensors".into()],
            ..FavoriteFilter::default()
        };
        let bar = FilterBar::new(&filter, Some(&(folders(), true)), Some(&facets()));
        let labels: Vec<&str> = bar.folders.iter().map(|(chip, _)| &*chip.label).collect();
        assert_eq!(labels, ["All 5", "Unfiled 2", "Cats 3"]);
        assert!(bar.folders[2].0.selected);
        assert_eq!(
            bar.selected_folder.map(|folder| folder.id),
            Some("f1".into())
        );
        // A selected provider with no favourites left stays, to be cleared.
        let providers: Vec<&str> = bar.providers.iter().map(|(_, value)| &**value).collect();
        assert_eq!(providers, ["grok", "fal"]);
        assert_eq!(&*bar.media[1], "Images 4");
        assert!(bar.checkpoints[0].2);
        assert_eq!(&*bar.checkpoints_label, "Checkpoint · 1");

        // A remembered folder list offers no Rename or Delete.
        let remembered = FilterBar::new(&filter, Some(&(folders(), false)), None);
        assert!(remembered.selected_folder.is_none());
    }
}
