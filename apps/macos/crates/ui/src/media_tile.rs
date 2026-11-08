//! One tile of a results grid (the web's `ImageGridItem` / `VideoGridItem`).
//!
//! - The preview fills the tile. A failed image preview falls back to the
//!   original, then to "Image unavailable"; a clip's poster falls back to
//!   "Preview unavailable" — a clip's original is the video itself, which no
//!   image decoder can show.
//! - On hover: the heart top-left, the tile's actions top-right, the provenance
//!   badge bottom-left. A favourited heart stays visible.
//! - A tile smaller than 180×80 px folds its actions into a "…" menu.
//! - In selection mode a check mark replaces the actions and a click selects.
//!
//! The owner decides what a click and each action mean; the tile only reports.

use std::rc::Rc;

use artsnack_media::{ImageRequest, media_image};
use gpui_kit::{
    Anchor, AnyElement, App, ClickEvent, ElementId, InteractiveElement as _, IntoElement,
    ObjectFit, ParentElement as _, Pixels, RenderOnce, SharedString, Size,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Sizable as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        menu::{DropdownMenu as _, PopupMenu, PopupMenuItem},
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
type ActionHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// Below this size the inline actions do not fit and fold into a menu.
const COMPACT_WIDTH: f32 = 180.0;
const COMPACT_HEIGHT: f32 = 80.0;

/// One command on a tile, e.g. Reproduce or Copy prompt.
#[derive(Clone)]
pub struct TileAction {
    id: &'static str,
    icon: IconName,
    label: SharedString,
    handler: ActionHandler,
    /// Set for an action that offers choices rather than running at once.
    menu: Option<Rc<[TileMenuItem]>>,
}

/// One choice of a menu action, e.g. "As start frame".
#[derive(Clone)]
pub struct TileMenuItem {
    label: SharedString,
    hint: Option<SharedString>,
    handler: ActionHandler,
}

impl TileMenuItem {
    pub fn new(
        label: impl Into<SharedString>,
        handler: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            hint: None,
            handler: Rc::new(handler),
        }
    }

    /// A muted line under the label saying what the choice does.
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

impl TileAction {
    /// Download: the original of `key` to ~/Downloads (the viewers' button).
    pub fn download(key: &str, cx: &App) -> Self {
        let url = artsnack_media::Media::urls(cx).original(key);
        let name = artsnack_media::downloads::name_for_key(key);
        Self::new(
            "download",
            IconName::Download,
            "Download",
            move |window, cx| {
                artsnack_media::downloads::download(url.clone(), name.to_string(), window, cx)
            },
        )
    }

    pub fn new(
        id: &'static str,
        icon: IconName,
        label: impl Into<SharedString>,
        handler: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id,
            icon,
            label: label.into(),
            handler: Rc::new(handler),
            menu: None,
        }
    }

    /// An action whose button opens a menu of `items`, headed by `label`. In a
    /// compact tile's "…" menu it is a submenu.
    pub fn menu(
        id: &'static str,
        icon: IconName,
        label: impl Into<SharedString>,
        items: Vec<TileMenuItem>,
    ) -> Self {
        Self {
            id,
            icon,
            label: label.into(),
            handler: Rc::new(|_, _| {}),
            menu: Some(items.into()),
        }
    }
}

impl TileAction {
    /// The action as a toolbar button (lightbox, selection bars). A menu
    /// action's button does nothing; use [`Self::into_element`] for those.
    pub fn into_button(self) -> Button {
        let handler = self.handler.clone();
        Button::new(self.id)
            .ghost()
            .small()
            .icon(self.icon)
            .tooltip(self.label)
            .on_click(move |_, window, cx| handler(window, cx))
    }

    /// The action as a toolbar control: a button that runs it, or for a menu
    /// action one that opens the menu.
    pub fn into_element(self) -> AnyElement {
        let button = Button::new(self.id)
            .ghost()
            .small()
            .icon(self.icon)
            .tooltip(self.label.clone());
        self.attach(button, false)
    }

    /// `button` running this action, or opening its menu. On a tile the click
    /// must not reach the tile (which opens the viewer); a menu's trigger
    /// already keeps its mouse-down to itself.
    fn attach(self, button: Button, stop_propagation: bool) -> AnyElement {
        match self.menu {
            Some(items) => {
                let heading = self.label;
                button
                    .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, _, cx| {
                        menu_items(menu.label(heading.clone()), &items, cx)
                    })
                    .into_any_element()
            }
            None => {
                let handler = self.handler;
                button
                    .on_click(move |_, window, cx| {
                        if stop_propagation {
                            cx.stop_propagation();
                        }
                        handler(window, cx)
                    })
                    .into_any_element()
            }
        }
    }
}

/// A menu action's choices as menu rows; a hint goes under its label.
fn menu_items(mut menu: PopupMenu, items: &[TileMenuItem], cx: &App) -> PopupMenu {
    let muted = cx.theme().muted_foreground;
    for item in items {
        let handler = item.handler.clone();
        let row = match item.hint.clone() {
            Some(hint) => {
                let label = item.label.clone();
                PopupMenuItem::element(move |_, _| {
                    v_flex()
                        .child(label.clone())
                        .child(div().text_xs().text_color(muted).child(hint.clone()))
                })
            }
            None => PopupMenuItem::new(item.label.clone()),
        };
        menu = menu.item(row.on_click(move |_, window, cx| handler(window, cx)));
    }
    menu
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileMedia {
    Image,
    /// A clip shown by its poster frame.
    Video,
}

#[derive(IntoElement)]
pub struct MediaTile {
    id: ElementId,
    preview: ImageRequest,
    original: Option<ImageRequest>,
    media: TileMedia,
    size: Size<Pixels>,
    badge: Option<SharedString>,
    favorited: Option<bool>,
    selection: Option<bool>,
    actions: Vec<TileAction>,
    on_click: Option<ClickHandler>,
    on_toggle_favorite: Option<ActionHandler>,
    overlays: Vec<AnyElement>,
}

impl MediaTile {
    /// `id` must be the item's stable key; `size` is the tile's laid-out size.
    pub fn new(id: impl Into<ElementId>, preview: ImageRequest, size: Size<Pixels>) -> Self {
        Self {
            id: id.into(),
            preview,
            original: None,
            media: TileMedia::Image,
            size,
            badge: None,
            favorited: None,
            selection: None,
            actions: Vec::new(),
            on_click: None,
            on_toggle_favorite: None,
            overlays: Vec::new(),
        }
    }

    /// An always-visible mark over the image, under the hover controls, that
    /// the owner positions itself (an absolutely positioned corner badge).
    /// It must not collide with the corners the tile already uses: the hover
    /// badge bottom-left and a video's play marker bottom-right.
    pub fn overlay(mut self, overlay: impl IntoElement) -> Self {
        self.overlays.push(overlay.into_any_element());
        self
    }

    /// Shown if the preview fails — for [`TileMedia::Image`] only; a clip's
    /// original is the clip, not a picture, and is never fetched as one.
    pub fn original(mut self, original: ImageRequest) -> Self {
        self.original = Some(original);
        self
    }

    pub fn media(mut self, media: TileMedia) -> Self {
        self.media = media;
        self
    }

    /// Where it came from, shown on hover.
    pub fn badge(mut self, badge: impl Into<SharedString>) -> Self {
        self.badge = Some(badge.into());
        self
    }

    /// Shows the heart; `on_toggle` flips it.
    pub fn favorite(
        mut self,
        favorited: bool,
        on_toggle: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.favorited = Some(favorited);
        self.on_toggle_favorite = Some(Rc::new(on_toggle));
        self
    }

    /// Puts the tile in selection mode.
    pub fn selection(mut self, selected: bool) -> Self {
        self.selection = Some(selected);
        self
    }

    pub fn action(mut self, action: TileAction) -> Self {
        self.actions.push(action);
        self
    }

    /// A click on the tile (open, or select in selection mode). The event
    /// carries the modifiers, for Shift-click ranges.
    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for MediaTile {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let overlays = std::mem::take(&mut self.overlays);
        let group: SharedString = format!("tile-{:?}", self.id).into();
        let compact =
            self.size.width.as_f32() < COMPACT_WIDTH || self.size.height.as_f32() < COMPACT_HEIGHT;
        let selecting = self.selection.is_some();
        let selected = self.selection.unwrap_or(false);
        let theme = cx.theme();

        let original = self
            .original
            .clone()
            .filter(|_| self.media == TileMedia::Image);
        let media = self.media;
        let image = img(media_image(self.preview.clone()))
            .size_full()
            .object_fit(ObjectFit::Cover)
            .with_loading({
                let muted = theme.muted;
                move || div().size_full().bg(muted).into_any_element()
            })
            .with_fallback({
                let muted = theme.muted;
                let foreground = theme.muted_foreground;
                move || match &original {
                    Some(original) => img(media_image(original.clone()))
                        .size_full()
                        .object_fit(ObjectFit::Cover)
                        .with_fallback(move || unavailable(media, muted, foreground))
                        .into_any_element(),
                    None => unavailable(media, muted, foreground),
                }
            });

        let heart = self.on_toggle_favorite.clone().map(|toggle| {
            let favorited = self.favorited.unwrap_or(false);
            Button::new("favorite")
                .ghost()
                .xsmall()
                .icon(
                    Icon::new(IconName::Heart)
                        .when(favorited, |icon| icon.text_color(cx.theme().danger)),
                )
                .tooltip(if favorited {
                    "Remove from favorites"
                } else {
                    "Add to favorites"
                })
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    toggle(window, cx)
                })
        });

        let actions: AnyElement = if self.actions.is_empty() || selecting {
            div().into_any_element()
        } else if compact {
            let actions = self.actions.clone();
            Button::new("more")
                .ghost()
                .xsmall()
                .icon(IconName::Ellipsis)
                .tooltip("Actions")
                .dropdown_menu(move |mut menu, window, cx| {
                    for action in &actions {
                        if let Some(items) = action.menu.clone() {
                            menu = menu.submenu_with_icon(
                                Some(Icon::new(action.icon)),
                                action.label.clone(),
                                window,
                                cx,
                                move |submenu, _, cx| menu_items(submenu, &items, cx),
                            );
                            continue;
                        }
                        let handler = action.handler.clone();
                        menu = menu.item(
                            PopupMenuItem::new(action.label.clone())
                                .icon(action.icon)
                                .on_click(move |_, window, cx| handler(window, cx)),
                        );
                    }
                    menu
                })
                .into_any_element()
        } else {
            h_flex()
                .gap_0p5()
                .children(self.actions.iter().map(|action| {
                    let button = Button::new(action.id)
                        .ghost()
                        .xsmall()
                        .icon(action.icon)
                        .tooltip(action.label.clone());
                    action.clone().attach(button, true)
                }))
                .into_any_element()
        };

        let favorited = self.favorited.unwrap_or(false);
        let on_click = self.on_click.clone();

        div()
            .id(self.id.clone())
            .group(group.clone())
            .relative()
            .size_full()
            .overflow_hidden()
            .rounded(theme.radius)
            .bg(theme.muted)
            .border_1()
            .border_color(theme.border)
            .hover(|style| style.border_color(cx.theme().ring))
            .cursor_pointer()
            .when_some(on_click, |this, on_click| {
                this.on_click(move |event, window, cx| on_click(event, window, cx))
            })
            .child(image)
            .when(self.media == TileMedia::Video, |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom_1()
                        .right_1()
                        .rounded_full()
                        .p_1()
                        .bg(cx.theme().overlay)
                        .child(
                            Icon::new(IconName::Play)
                                .xsmall()
                                .text_color(cx.theme().foreground),
                        ),
                )
            })
            .children(overlays)
            .when(selected, |this| {
                this.child(
                    div()
                        .absolute()
                        .inset_0()
                        .border_2()
                        .rounded(cx.theme().radius)
                        .border_color(cx.theme().primary)
                        .bg(cx.theme().primary.opacity(0.2)),
                )
            })
            .child(
                // The overlay: hidden until hover, except a favourited heart and
                // the selection mark.
                v_flex()
                    .absolute()
                    .inset_0()
                    .p_1()
                    .justify_between()
                    .child(
                        h_flex()
                            .justify_between()
                            .items_start()
                            .child(match (selecting, heart) {
                                (true, _) => selection_mark(selected, cx).into_any_element(),
                                (false, Some(heart)) => div()
                                    .rounded(cx.theme().radius)
                                    .bg(cx.theme().overlay)
                                    .when(!favorited, |this| {
                                        this.invisible()
                                            .group_hover(group.clone(), |style| style.visible())
                                    })
                                    .child(heart)
                                    .into_any_element(),
                                (false, None) => div().into_any_element(),
                            })
                            .child(
                                div()
                                    .rounded(cx.theme().radius)
                                    .bg(cx.theme().overlay)
                                    .invisible()
                                    .group_hover(group.clone(), |style| style.visible())
                                    .child(actions),
                            ),
                    )
                    .when_some(self.badge.clone(), |this, badge| {
                        this.child(
                            div()
                                .self_start()
                                .px_1p5()
                                .py_0p5()
                                .rounded(cx.theme().radius)
                                .bg(cx.theme().overlay)
                                .text_xs()
                                .text_color(cx.theme().foreground)
                                .invisible()
                                .group_hover(group, |style| style.visible())
                                .child(badge),
                        )
                    }),
            )
    }
}

fn selection_mark(selected: bool, cx: &App) -> impl IntoElement {
    div()
        .size_5()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .border_1()
        .border_color(cx.theme().foreground)
        .when(selected, |this| {
            this.bg(cx.theme().primary).border_color(cx.theme().primary)
        })
        .when(!selected, |this| this.bg(cx.theme().overlay))
        .when(selected, |this| {
            this.child(
                Icon::new(IconName::Check)
                    .xsmall()
                    .text_color(cx.theme().primary_foreground),
            )
        })
}

fn unavailable(
    media: TileMedia,
    background: gpui_kit::Hsla,
    foreground: gpui_kit::Hsla,
) -> AnyElement {
    let (icon, label) = match media {
        TileMedia::Image => (IconName::ImageOff, "Image unavailable"),
        TileMedia::Video => (IconName::VideoOff, "Preview unavailable"),
    };
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap_1()
        .bg(background)
        .text_xs()
        .text_color(foreground)
        .child(Icon::new(icon).small())
        .child(label)
        .into_any_element()
}
