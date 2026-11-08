//! History: every self-hosted generation as a card, newest first — its status,
//! settings and images, with Reproduce, Enhance, Copy prompt and Delete — and
//! a viewer over one card's images.
//!
//! - A running generation's progress re-measures its own card only; finished
//!   rows keep their identity across live updates. The cards' image tiles are
//!   cached views (`tile_view`), so a frame drawn for a running card's spinner
//!   reuses every image; a card's height follows its text, which is why the
//!   card itself is drawn each frame.
//! - The next page loads when the footer comes within the list's overdraw of
//!   the viewport (the web's sentinel), also when the first page is too short
//!   to scroll.
//! - Hidden ([`HistoryView::set_active`]), the screen keeps its cards and lets
//!   go of its subscriptions after a grace period.

mod card;
mod card_grid;
mod time;

pub(crate) use card::details;

use std::{cell::RefCell, collections::HashSet, rc::Rc, sync::Arc};

use artsnack_backend::{
    Backend, LivePaginatedQuery, NoArgs, PaginationStatus,
    api::generations::{self, Generation, RemoveArgs},
};
use artsnack_media::Media;
use artsnack_ui::{Lightbox, LightboxEvent, LightboxItem, TileAction};
use gpui_kit::{
    AnyElement, App, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Task, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariant},
        h_flex,
        notification::Notification,
        skeleton::Skeleton,
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    px, rems,
};

use self::{
    card::{CardCommand, GenerationCard, status_notice},
    card_grid::{CardGrid, row},
};
use crate::{
    command::{MediaCommand, ReproduceSource},
    feed::{Feed, release_after_grace},
    gallery::{
        CopiedMark, ImageScreen, download_action, image_actions, image_key, lightbox_item,
        split_image_key,
    },
    tile_view::{Same, TileViews},
};

/// First page and every page after it, as the web loads them.
const PAGE_SIZE: usize = 20;
/// Placeholder cards while the first page loads.
const SKELETON_CARDS: usize = 4;

/// What History asks of the shell besides [`MediaCommand`]s.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryEvent {
    /// "Start generating" on the empty history: open Generate.
    StartGenerating,
}

/// What a card's height depends on: its row and its two disclosures. Rows
/// compare by identity: the paginated query keeps a row's `Arc` for as long as
/// its value is unchanged, and holding it here keeps the address from being
/// reused.
struct CardRevision {
    row: Arc<Generation>,
    prompt_expanded: bool,
    settings_open: bool,
}

impl PartialEq for CardRevision {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.row, &other.row)
            && self.prompt_expanded == other.prompt_expanded
            && self.settings_open == other.settings_open
    }
}

struct OpenLightbox {
    lightbox: Entity<Lightbox>,
    /// The generation whose images it pages through.
    generation_id: String,
    _subscription: Subscription,
}

/// The cards' image tiles, by image key; a tile's revision is its row.
pub(crate) type ImageTiles = Rc<RefCell<TileViews<Same<Generation>>>>;

pub struct HistoryView {
    focus_handle: FocusHandle,
    /// The live rows; released while the screen stays hidden.
    generations: Feed<LivePaginatedQuery<Generation>>,
    /// The rows as last read; kept while the subscription is released.
    rows: Arc<Vec<Arc<Generation>>>,
    status: PaginationStatus,
    error: Option<SharedString>,
    grid: CardGrid<CardRevision>,
    tiles: ImageTiles,
    /// Cards whose prompt is shown in full, by generation id.
    expanded_prompts: HashSet<String>,
    /// Cards whose "All settings" is open.
    open_settings: HashSet<String>,
    /// Bumped whenever a card's row or disclosures change.
    cards_revision: u64,
    /// Generations being deleted (their Delete button spins).
    deleting: HashSet<String>,
    copied: CopiedMark,
    lightbox: Option<OpenLightbox>,
    active: bool,
    _release: Option<Task<()>>,
}

impl EventEmitter<MediaCommand> for HistoryView {}
impl EventEmitter<HistoryEvent> for HistoryView {}

impl ImageScreen for HistoryView {
    fn copied_mark(&mut self) -> &mut CopiedMark {
        &mut self.copied
    }
}

impl HistoryView {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            focus_handle: cx.focus_handle(),
            generations: Feed::default(),
            rows: Arc::default(),
            status: PaginationStatus::LoadingFirstPage,
            error: None,
            grid: CardGrid::new(),
            tiles: Rc::default(),
            expanded_prompts: HashSet::new(),
            open_settings: HashSet::new(),
            cards_revision: 0,
            deleting: HashSet::new(),
            copied: CopiedMark::default(),
            lightbox: None,
            active: true,
            _release: None,
        };
        this.connect(cx);
        this
    }

    /// Subscribes to the rows, starting from the ones last delivered.
    fn connect(&mut self, cx: &mut Context<Self>) {
        self.generations.connect(
            |cx| LivePaginatedQuery::new(generations::LIST_PAGINATED, &NoArgs {}, PAGE_SIZE, cx),
            Self::rows_changed,
            cx,
        );
        self.rows_changed(cx);
    }

    /// Whether the screen is shown (the shell says so). Hidden, it keeps its
    /// cards, scroll and viewer, and lets go of the subscription after a grace
    /// period; shown again, it subscribes from where it was.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if active == self.active {
            return;
        }
        self.active = active;
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

    fn generation(&self, id: &str) -> Option<Arc<Generation>> {
        self.rows.iter().find(|row| row.id == id).cloned()
    }

    fn rows_changed(&mut self, cx: &mut Context<Self>) {
        let Some(query) = self.generations.get() else {
            return;
        };
        let query = query.read(cx);
        let rows = query.rows().clone();
        self.status = query.status();
        self.error = query.error().cloned();
        if !Arc::ptr_eq(&rows, &self.rows) {
            self.rows = rows;
            self.cards_revision += 1;
            let present: HashSet<&str> = self.rows.iter().map(|row| row.id.as_str()).collect();
            self.expanded_prompts
                .retain(|id| present.contains(id.as_str()));
            self.open_settings
                .retain(|id| present.contains(id.as_str()));
            self.tiles
                .borrow_mut()
                .retain(|key| split_image_key(key).is_some_and(|(id, _)| present.contains(id)));
            if let Some(open) = &self.lightbox {
                let items = self
                    .rows
                    .iter()
                    .find(|row| row.id == open.generation_id)
                    .map(|generation| lightbox_items(generation, cx))
                    .unwrap_or_default();
                // An empty list closes the viewer: its generation was deleted.
                open.lightbox
                    .update(cx, |lightbox, cx| lightbox.set_items(items, false, cx));
            }
        }
        cx.notify();
    }

    fn load_more(&mut self, cx: &mut Context<Self>) {
        if let Some(generations) = self.generations.get() {
            generations.update(cx, |generations, cx| generations.load_more(PAGE_SIZE, cx));
        }
    }

    // --- Commands -------------------------------------------------------

    fn on_card_command(
        &mut self,
        generation: &Arc<Generation>,
        command: CardCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = &generation.id;
        let image_url = |ix: usize, cx: &App| -> Option<SharedString> {
            let b2_key = generation.b2_keys.get(ix)?;
            Some(Media::urls(cx).original(b2_key).into())
        };
        match command {
            CardCommand::TogglePrompt => {
                if !self.expanded_prompts.remove(id) {
                    self.expanded_prompts.insert(id.clone());
                }
                self.cards_revision += 1;
                cx.notify();
            }
            CardCommand::ToggleSettings => {
                if !self.open_settings.remove(id) {
                    self.open_settings.insert(id.clone());
                }
                self.cards_revision += 1;
                cx.notify();
            }
            CardCommand::CopyPrompt => {
                let prompt = generation.form_state.prompt.clone();
                self.copied
                    .copy(id.clone().into(), prompt, Self::copied_mark, cx);
            }
            CardCommand::Delete => self.confirm_delete(generation, window, cx),
            CardCommand::Reproduce => {
                cx.emit(MediaCommand::Reproduce(ReproduceSource::SelfHosted {
                    form_state: generation.form_state.to_value(),
                }))
            }
            CardCommand::Enhance => {
                if let Some(image_url) = image_url(0, cx) {
                    cx.emit(MediaCommand::Enhance {
                        image_url,
                        form_state: Some(generation.form_state.to_value()),
                    });
                }
            }
            CardCommand::SendToApi(ix) => {
                if let Some(image_url) = image_url(ix, cx) {
                    cx.emit(MediaCommand::UseAsReference { image_url });
                }
            }
            CardCommand::Open(ix) => self.open_lightbox(generation, ix, window, cx),
        }
    }

    fn confirm_delete(
        &mut self,
        generation: &Generation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.deleting.contains(&generation.id) {
            return;
        }
        let title = match generation.b2_keys.len() {
            0 => "Delete this generation?".to_string(),
            1 => "Delete this generation and its image?".to_string(),
            count => format!("Delete this generation and its {count} images?"),
        };
        let id = generation.id.clone();
        let view = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let id = id.clone();
            let view = view.clone();
            alert
                .title(title.clone())
                .description("This cannot be undone.")
                .confirm()
                .ok_text("Delete")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let id = id.clone();
                    let _ = view.update(cx, |this, cx| this.delete(id, window, cx));
                    true
                })
        });
    }

    fn delete(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.deleting.insert(id.clone());
        cx.notify();
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(generations::REMOVE, &RemoveArgs { id: id.clone() }, cx)
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.deleting.remove(&id);
                cx.notify();
            });
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(()) => window.push_notification(Notification::success("Generation deleted"), cx),
                Err(error) => window.push_notification(
                    Notification::error(format!(
                        "Couldn\u{2019}t delete this generation. {}",
                        error.user_message()
                    )),
                    cx,
                ),
            });
        })
        .detach();
    }

    // --- Viewer ---------------------------------------------------------

    fn open_lightbox(
        &mut self,
        generation: &Generation,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items = lightbox_items(generation, cx);
        let Some(key) = items.get(ix).map(|item| item.key.clone()) else {
            return;
        };
        let actions_view = cx.entity().downgrade();
        let details_view = actions_view.clone();
        let lightbox = Lightbox::new(
            items,
            key,
            false,
            move |item, _, cx| {
                actions_view
                    .upgrade()
                    .map(|view| view.update(cx, |this, cx| this.lightbox_actions(item, cx)))
                    .unwrap_or_default()
            },
            move |item, _, cx| {
                let view = details_view.upgrade()?;
                let (generation_id, _) = split_image_key(&item.key)?;
                let generation = view.read(cx).generation(generation_id)?;
                Some(details(&generation, cx))
            },
            cx,
        );
        let subscription = cx.subscribe_in(&lightbox, window, |this, _, event, window, cx| {
            if *event == LightboxEvent::Closed {
                this.lightbox = None;
                this.focus_handle.focus(window, cx);
                cx.notify();
            }
        });
        lightbox.read(cx).focus_handle(cx).focus(window, cx);
        self.lightbox = Some(OpenLightbox {
            lightbox,
            generation_id: generation.id.clone(),
            _subscription: subscription,
        });
        cx.notify();
    }

    /// The viewer's bar: the image's commands, then Download.
    fn lightbox_actions(&self, item: &LightboxItem, cx: &Context<Self>) -> Vec<TileAction> {
        let Some((generation_id, b2_key)) = split_image_key(&item.key) else {
            return Vec::new();
        };
        let Some(generation) = self.generation(generation_id) else {
            return Vec::new();
        };
        let mut actions = image_actions(
            &cx.entity().downgrade(),
            &generation,
            b2_key,
            item.key.clone(),
            self.copied.is(&item.key),
        );
        actions.push(download_action(b2_key, cx));
        actions
    }

    // --- Rendering ------------------------------------------------------

    fn render_header(&self, rows: usize, cx: &App) -> AnyElement {
        let loading_first = rows == 0 && self.status == PaginationStatus::LoadingFirstPage;
        h_flex()
            .px_4()
            .pt_4()
            .justify_between()
            .child(
                div()
                    .text_xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("History"),
            )
            .when(!loading_first, |this| {
                this.child(
                    div()
                        .text_sm()
                        .font_family(cx.theme().mono_font_family.clone())
                        .text_color(cx.theme().muted_foreground)
                        .child(if rows == 1 {
                            "1 entry".to_string()
                        } else {
                            format!("{rows} entries")
                        }),
                )
            })
            .into_any_element()
    }

    fn render_cards(
        &mut self,
        rows: Arc<Vec<Arc<Generation>>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if rows.is_empty() {
            return self.render_without_rows(cx);
        }

        // The cards' keys and revisions only when they can have changed: the
        // rows, or a disclosure. Not on every frame a spinner draws.
        self.grid.sync(self.cards_revision, window, || {
            let keys = rows
                .iter()
                .map(|row| SharedString::from(row.id.clone()))
                .collect();
            let revisions = rows
                .iter()
                .map(|row| CardRevision {
                    row: row.clone(),
                    prompt_expanded: self.expanded_prompts.contains(&row.id),
                    settings_open: self.open_settings.contains(&row.id),
                })
                .collect();
            (keys, revisions)
        });

        let view = cx.entity();
        let footer_view = view.clone();
        div()
            .flex_1()
            .min_h_0()
            .child(self.grid.render(
                view.entity_id(),
                move |range, window, cx| {
                    let generations = rows[range].to_vec();
                    view.update(cx, |this, cx| this.render_row(&generations, window, cx))
                },
                move |_, cx| {
                    // The footer is within the overdraw: fetch the next page
                    // (a no-op unless one can be loaded).
                    let weak = footer_view.downgrade();
                    cx.defer(move |cx| {
                        let _ = weak.update(cx, |this, cx| this.load_more(cx));
                    });
                    footer_view.read(cx).render_footer(cx)
                },
            ))
            .into_any_element()
    }

    fn render_row(
        &self,
        generations: &[Arc<Generation>],
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let columns = self.grid.columns();
        let width = px(self.grid.card_width());
        let view = cx.entity().downgrade();
        row()
            .children(generations.iter().map(|generation| {
                let view = view.clone();
                let target = generation.clone();
                let card =
                    GenerationCard::new(generation.clone(), width, move |command, window, cx| {
                        let _ = view.update(cx, |this, cx| {
                            this.on_card_command(&target, command, window, cx)
                        });
                    })
                    .image_tiles(self.tiles.clone())
                    .prompt_expanded(self.expanded_prompts.contains(&generation.id))
                    .settings_open(self.open_settings.contains(&generation.id))
                    .prompt_copied(self.copied.is(&generation.id))
                    .deleting(self.deleting.contains(&generation.id));
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_2()
                    .children(status_notice(generation, cx))
                    .child(card)
            }))
            .children((generations.len()..columns).map(|_| div().flex_1()))
            .into_any_element()
    }

    fn render_footer(&self, cx: &App) -> AnyElement {
        let status = self.status;
        h_flex()
            .h_16()
            .justify_center()
            .gap_2()
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .when(status == PaginationStatus::LoadingMore, |this| {
                this.child(Spinner::new().small()).child("Loading more…")
            })
            .when(status == PaginationStatus::Exhausted, |this| {
                this.child("No more entries")
            })
            .into_any_element()
    }

    /// Before the first page, after a failure, or with nothing made yet.
    fn render_without_rows(&self, cx: &mut Context<Self>) -> AnyElement {
        match self.status {
            PaginationStatus::Failed => {
                let message = self.error.clone().unwrap_or_default();
                message_state("Couldn\u{2019}t load history", message, None, cx)
            }
            PaginationStatus::Exhausted => {
                let start = Button::new("start-generating")
                    .icon(IconName::Sparkles)
                    .label("Start generating")
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(HistoryEvent::StartGenerating)))
                    .into_any_element();
                message_state(
                    "No history yet",
                    "Your generated images will appear here.".into(),
                    Some(start),
                    cx,
                )
            }
            _ => row()
                .children((0..SKELETON_CARDS).map(|_| {
                    Skeleton::new()
                        .flex_1()
                        .h(rems(25.))
                        .rounded(cx.theme().radius_lg)
                }))
                .into_any_element(),
        }
    }
}

fn lightbox_items(generation: &Generation, cx: &App) -> Vec<LightboxItem> {
    let urls = Media::urls(cx);
    generation
        .b2_keys
        .iter()
        .map(|b2_key| lightbox_item(image_key(&generation.id, b2_key), b2_key, urls))
        .collect()
}

fn message_state(
    title: &'static str,
    body: SharedString,
    action: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
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
        .when_some(action, |this, action| {
            this.child(div().pt_3().child(action))
        })
        .into_any_element()
}

impl Focusable for HistoryView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for HistoryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows.clone();
        let header = self.render_header(rows.len(), cx);
        let cards = self.render_cards(rows, window, cx);
        let lightbox = self.lightbox.as_ref().map(|open| open.lightbox.clone());

        v_flex()
            .id("history")
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            .gap_3()
            .child(header)
            .child(cards)
            .children(lightbox)
    }
}
