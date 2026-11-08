//! One self-hosted generation as a card (the web's `GenerationCard`), and the
//! status notice above it.
//!
//! - Header: when, the size and step count, the model (full name on hover);
//!   Copy prompt and Delete.
//! - The prompt, two lines until "Show more"; "All settings" opens the form's
//!   values.
//! - The images, one or two to a row, each a media tile that opens the viewer
//!   and offers Send to API. The tiles are the owner's cached views
//!   ([`ImageTiles`]): the card is drawn every frame, its images are not.
//! - Reproduce and Enhance.
//!
//! The card holds no state: the owner says what is open, copied or being
//! deleted, and receives every interaction as a [`CardCommand`]. It is
//! domain-aware (a generation row, media URLs), which is why it lives with
//! History rather than in the UI crate.

use std::{rc::Rc, sync::Arc};

use artsnack_backend::api::generations::{FormState, Generation};
use artsnack_media::Media;
use artsnack_ui::{MediaTile, TileAction};
use gpui_kit::{
    AnyElement, App, ClickEvent, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Icon, Sizable as _,
        alert::Alert,
        button::{Button, ButtonVariants as _},
        description_list::DescriptionList,
        h_flex,
        progress::Progress,
        spinner::Spinner,
        tag::Tag,
        tooltip::Tooltip,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    px, rems, size,
};

use super::{ImageTiles, time::format_timestamp};
use crate::{
    gallery::{image_key, original, preview},
    tile_view::Same,
};

/// A prompt longer than this gets "Show more".
const LONG_PROMPT_CHARS: usize = 100;
/// Model names longer than this are cut, with the full name on hover.
const MODEL_NAME_CHARS: usize = 28;
/// The longest failure text shown above a card.
const ERROR_CHARS: usize = 240;

/// Everything a card asks its owner to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CardCommand {
    TogglePrompt,
    ToggleSettings,
    CopyPrompt,
    Delete,
    Reproduce,
    /// Enhance the first image.
    Enhance,
    /// Open the viewer on image `ix`.
    Open(usize),
    /// Send image `ix` to the API tab as a reference.
    SendToApi(usize),
}

type CommandHandler = Rc<dyn Fn(CardCommand, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub(crate) struct GenerationCard {
    generation: Arc<Generation>,
    width: Pixels,
    prompt_expanded: bool,
    settings_open: bool,
    prompt_copied: bool,
    deleting: bool,
    on_command: CommandHandler,
    tiles: Option<ImageTiles>,
}

impl GenerationCard {
    /// `width` is the card's laid-out width, which sizes its image tiles.
    pub fn new(
        generation: Arc<Generation>,
        width: Pixels,
        on_command: impl Fn(CardCommand, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            generation,
            width,
            prompt_expanded: false,
            settings_open: false,
            prompt_copied: false,
            deleting: false,
            on_command: Rc::new(on_command),
            tiles: None,
        }
    }

    /// Draws the images as cached tiles kept in `tiles`.
    pub fn image_tiles(mut self, tiles: ImageTiles) -> Self {
        self.tiles = Some(tiles);
        self
    }

    pub fn prompt_expanded(mut self, expanded: bool) -> Self {
        self.prompt_expanded = expanded;
        self
    }

    pub fn settings_open(mut self, open: bool) -> Self {
        self.settings_open = open;
        self
    }

    pub fn prompt_copied(mut self, copied: bool) -> Self {
        self.prompt_copied = copied;
        self
    }

    pub fn deleting(mut self, deleting: bool) -> Self {
        self.deleting = deleting;
        self
    }

    fn command(
        &self,
        command: CardCommand,
    ) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static + use<> {
        let handler = self.on_command.clone();
        move |_, window, cx| handler(command, window, cx)
    }

    fn render_header(&self, cx: &App) -> impl IntoElement {
        let form = &self.generation.form_state;
        let id = &self.generation.id;
        let theme = cx.theme();
        let model = model_label(&form.checkpoint);
        let full_model: SharedString = form.checkpoint.clone().into();

        h_flex()
            .items_start()
            .justify_between()
            .gap_2()
            .p_4()
            .pb_2()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_1p5()
                    .when_some(format_timestamp(self.generation.timestamp), |this, when| {
                        this.child(
                            div()
                                .text_xs()
                                .font_family(theme.mono_font_family.clone())
                                .text_color(theme.muted_foreground)
                                .child(when),
                        )
                    })
                    .child(
                        h_flex()
                            .flex_wrap()
                            .gap_1p5()
                            .child(meta_tag(format!("{}x{}", form.width, form.height), cx))
                            .child(meta_tag(format!("{} steps", form.steps), cx)),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("model-{id}")))
                            .min_w_0()
                            .tooltip(move |window, cx| {
                                Tooltip::new(full_model.clone()).build(window, cx)
                            })
                            .child(
                                Tag::secondary()
                                    .small()
                                    .max_w_full()
                                    .gap_0p5()
                                    .font_family(theme.mono_font_family.clone())
                                    .child(Icon::new(IconName::Cpu).xsmall())
                                    .child(div().truncate().child(model)),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .flex_shrink_0()
                    // Copy and Delete apart: a mis-click on Copy must not land
                    // on the button that destroys the batch.
                    .gap_3()
                    .when(!form.prompt.trim().is_empty(), |this| {
                        this.child(
                            Button::new("copy-prompt")
                                .ghost()
                                .small()
                                .icon(if self.prompt_copied {
                                    IconName::Check
                                } else {
                                    IconName::Copy
                                })
                                .tooltip(if self.prompt_copied {
                                    "Prompt copied"
                                } else {
                                    "Copy prompt"
                                })
                                .on_click(self.command(CardCommand::CopyPrompt)),
                        )
                    })
                    .child(
                        Button::new("delete")
                            .ghost()
                            .small()
                            .icon(IconName::Trash)
                            .tooltip("Delete generation")
                            .loading(self.deleting)
                            .on_click(self.command(CardCommand::Delete)),
                    ),
            )
    }

    fn render_prompt(&self, cx: &App) -> impl IntoElement {
        let prompt = self.generation.form_state.prompt.clone();
        let long = prompt.chars().count() > LONG_PROMPT_CHARS;
        v_flex()
            .gap_1()
            .items_start()
            .child(
                div()
                    .w_full()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(cx.theme().foreground)
                    .when(!self.prompt_expanded, |this| this.line_clamp(2))
                    .child(prompt),
            )
            .when(long, |this| {
                this.child(
                    Button::new("toggle-prompt")
                        .ghost()
                        .xsmall()
                        .icon(if self.prompt_expanded {
                            IconName::ChevronUp
                        } else {
                            IconName::ChevronDown
                        })
                        .label(if self.prompt_expanded {
                            "Show less"
                        } else {
                            "Show more"
                        })
                        .on_click(self.command(CardCommand::TogglePrompt)),
                )
            })
    }

    fn render_images(&self, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let keys = &self.generation.b2_keys;
        if keys.is_empty() {
            return None;
        }
        let urls = Media::urls(cx).clone();
        let columns = if keys.len() == 1 { 1 } else { 2 };
        let aspect = self.generation.form_state.aspect();
        // The card's inner width (`px_4` each side), less the `gap_2` between
        // two images. Measured geometry: the tile's height follows from it,
        // and so does the tile's compact-actions rule.
        let rem = window.rem_size().as_f32();
        let inner = self.width.as_f32() - 2.0 * rem;
        let tile_width = ((inner - 0.5 * rem * (columns - 1) as f32) / columns as f32).max(0.0);
        let tile_size = size(px(tile_width), px(tile_width / aspect));

        let tiles: Vec<AnyElement> = keys
            .iter()
            .enumerate()
            .map(|(ix, b2_key)| {
                let key = image_key(&self.generation.id, b2_key);
                let tile = match &self.tiles {
                    Some(tiles) => tiles.borrow_mut().element(
                        &key,
                        tile_size,
                        Same(self.generation.clone()),
                        false,
                        || self.image_tile(ix, key.clone(), b2_key, &urls),
                        cx,
                    ),
                    None => self.image_tile(ix, key.clone(), b2_key, &urls)(tile_size, window, cx),
                };
                div()
                    .flex_1()
                    .min_w_0()
                    .h(tile_size.height)
                    .child(tile)
                    .into_any_element()
            })
            .collect();

        let mut rows = Vec::new();
        let mut tiles = tiles.into_iter().peekable();
        while tiles.peek().is_some() {
            let mut row = h_flex().items_start().gap_2();
            for _ in 0..columns {
                row = match tiles.next() {
                    Some(tile) => row.child(tile),
                    None => row.child(div().flex_1()),
                };
            }
            rows.push(row);
        }
        Some(v_flex().gap_2().children(rows).into_any_element())
    }
}

impl GenerationCard {
    /// Draws image `ix`: it opens the viewer and offers Send to API.
    fn image_tile(
        &self,
        ix: usize,
        key: SharedString,
        b2_key: &str,
        urls: &artsnack_media::MediaUrls,
    ) -> crate::tile_view::TileRenderer {
        let preview = preview(b2_key, urls);
        let original = original(b2_key, urls);
        let on_command = self.on_command.clone();
        Rc::new(move |size, _, _| {
            let open = on_command.clone();
            let send = on_command.clone();
            MediaTile::new(key.clone(), preview.clone(), size)
                .original(original.clone())
                .action(TileAction::new(
                    "reference",
                    IconName::Sparkles,
                    "Send to API as reference",
                    move |window, cx| send(CardCommand::SendToApi(ix), window, cx),
                ))
                .on_click(move |_, window, cx| open(CardCommand::Open(ix), window, cx))
                .into_any_element()
        })
    }
}

impl RenderOnce for GenerationCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let has_images = !self.generation.b2_keys.is_empty();
        let images = self.render_images(window, cx);
        let header = self.render_header(cx);
        let prompt = self.render_prompt(cx);
        let settings_open = self.settings_open;

        v_flex()
            .id(SharedString::from(format!(
                "generation-{}",
                self.generation.id
            )))
            .w_full()
            .rounded(cx.theme().radius_lg)
            .border_1()
            .border_color(cx.theme().border)
            .child(header)
            .child(
                v_flex()
                    .px_4()
                    .pt_2()
                    .pb_4()
                    .gap_3()
                    .child(prompt)
                    .child(
                        div().child(
                            Button::new("toggle-settings")
                                .ghost()
                                .xsmall()
                                .icon(IconName::Settings2)
                                .label(if settings_open {
                                    "Hide settings"
                                } else {
                                    "All settings"
                                })
                                .on_click(self.command(CardCommand::ToggleSettings)),
                        ),
                    )
                    .when(settings_open, |this| {
                        this.child(settings_list(&self.generation.form_state, cx))
                    })
                    .children(images),
            )
            .child(
                h_flex()
                    .px_4()
                    .pb_4()
                    .gap_2()
                    .child(
                        Button::new("reproduce")
                            .flex_1()
                            .icon(IconName::RefreshCw)
                            .label("Reproduce")
                            .on_click(self.command(CardCommand::Reproduce)),
                    )
                    .when(has_images, |this| {
                        this.child(
                            Button::new("enhance")
                                .flex_1()
                                .icon(IconName::Zap)
                                .label("Enhance")
                                .on_click(self.command(CardCommand::Enhance)),
                        )
                    }),
            )
    }
}

fn meta_tag(text: String, cx: &App) -> impl IntoElement {
    Tag::secondary()
        .outline()
        .small()
        .font_family(cx.theme().mono_font_family.clone())
        .child(text)
}

/// Above the card: why a row has no images yet, or never will.
pub(crate) fn status_notice(generation: &Generation, cx: &App) -> Option<AnyElement> {
    if generation.is_failed() {
        let message = generation
            .error
            .as_deref()
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .unwrap_or("Unknown error");
        let message: String = message.chars().take(ERROR_CHARS).collect();
        return Some(
            Alert::error(
                SharedString::from(format!("failed-{}", generation.id)),
                message,
            )
            .title("Failed")
            .small()
            .into_any_element(),
        );
    }
    if !generation.is_running() {
        return None;
    }
    let label = generation.progress_label();
    let percent = generation.progress_percent();
    let theme = cx.theme();
    Some(
        h_flex()
            .gap_3()
            .px_3()
            .py_2()
            .rounded(theme.radius)
            .border_1()
            .border_color(theme.border)
            .bg(theme.muted.opacity(0.3))
            .child(Spinner::new().small().color(theme.muted_foreground))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_1p5()
                    .child(
                        h_flex()
                            .justify_between()
                            .gap_2()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(div().min_w_0().truncate().child(label.clone()))
                            .when_some(percent, |this, percent| {
                                this.child(
                                    div()
                                        .flex_shrink_0()
                                        .child(format!("{}%", percent.round() as u32)),
                                )
                            }),
                    )
                    .child(
                        Progress::new(SharedString::from(format!("progress-{}", generation.id)))
                            .xsmall()
                            .value(percent.unwrap_or_default())
                            .loading(percent.is_none())
                            .accessibility_label(label),
                    ),
            )
            .into_any_element(),
    )
}

/// The form's values, as "All settings" and the viewer's details show them.
fn settings_list(form: &FormState, cx: &App) -> impl IntoElement {
    let mono = cx.theme().mono_font_family.clone();
    DescriptionList::new()
        .columns(1)
        .small()
        .label_width(rems(7.))
        .children(settings_rows(form).into_iter().map(|(label, value)| {
            gpui_kit::component::description_list::DescriptionItem::new(label).value(
                div()
                    .font_family(mono.clone())
                    .child(value)
                    .into_any_element(),
            )
        }))
}

/// `(label, value)` for every non-empty setting, then the enabled LoRAs.
fn settings_rows(form: &FormState) -> Vec<(&'static str, String)> {
    let text = |value: &str| (!value.trim().is_empty()).then(|| value.to_string());
    let number = |value: f64| Some(format!("{value}"));
    let mut rows: Vec<(&'static str, String)> = [
        ("Negative prompt", text(&form.negative_prompt)),
        ("Model", text(&form.checkpoint)),
        ("Width", number(form.width)),
        ("Height", number(form.height)),
        ("Seed", number(form.seed)),
        ("Steps", number(form.steps)),
        ("CFG", number(form.cfg)),
        ("Sampler", text(&form.sampler)),
        ("Scheduler", text(&form.scheduler)),
        ("Denoise", number(form.denoise)),
        ("Batch size", number(form.batch_size)),
    ]
    .into_iter()
    .filter_map(|(label, value)| value.map(|value| (label, value)))
    .collect();
    let loras: Vec<String> = form
        .loras
        .iter()
        .filter(|lora| lora.enabled)
        .map(|lora| {
            format!(
                "{} ({}/{})",
                lora.lora_name, lora.strength_model, lora.strength_clip
            )
        })
        .collect();
    if !loras.is_empty() {
        rows.push(("LoRAs", loras.join("\n")));
    }
    rows
}

/// The viewer's details panel for a generation's image.
pub(crate) fn details(generation: &Generation, cx: &App) -> AnyElement {
    let form = &generation.form_state;
    let muted = cx.theme().muted_foreground;
    v_flex()
        .p_4()
        .gap_3()
        .when(!form.prompt.trim().is_empty(), |this| {
            this.child(
                v_flex()
                    .gap_0p5()
                    .child(div().text_xs().text_color(muted).child("Prompt"))
                    .child(div().text_sm().child(form.prompt.clone())),
            )
        })
        .child(settings_list(form, cx))
        .into_any_element()
}

/// The checkpoint as the card's model badge: no directory, no extension, at
/// most 28 characters.
fn model_label(checkpoint: &str) -> String {
    if checkpoint.is_empty() {
        return "Unknown".into();
    }
    let without_extension = match checkpoint.rfind('.') {
        Some(dot) if !checkpoint[dot..].contains(['/', '\\']) => &checkpoint[..dot],
        _ => checkpoint,
    };
    let name = without_extension
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(checkpoint);
    if name.chars().count() > MODEL_NAME_CHARS {
        let cut: String = name.chars().take(MODEL_NAME_CHARS - 2).collect();
        format!("{cut}\u{2026}")
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use artsnack_backend::api::generations::LoraSlot;

    use super::*;

    #[test]
    fn model_labels_drop_directory_and_extension_and_cut_long_names() {
        assert_eq!(
            model_label("SDXL/juggernaut_v9.safetensors"),
            "juggernaut_v9"
        );
        assert_eq!(model_label("win\\model.ckpt"), "model");
        assert_eq!(model_label(""), "Unknown");
        assert_eq!(model_label("v1.5/plain"), "plain");
        let long = "a".repeat(40);
        let label = model_label(&long);
        assert_eq!(label.chars().count(), 27);
        assert!(label.ends_with('\u{2026}'));
    }

    #[test]
    fn settings_skip_empty_text_and_list_enabled_loras() {
        let form = FormState {
            prompt: "p".into(),
            negative_prompt: " ".into(),
            checkpoint: "m.safetensors".into(),
            width: 832.0,
            height: 1216.0,
            cfg: 6.5,
            loras: vec![
                LoraSlot {
                    enabled: true,
                    lora_name: "a".into(),
                    strength_model: 0.8,
                    strength_clip: 1.0,
                },
                LoraSlot {
                    enabled: false,
                    lora_name: "b".into(),
                    ..LoraSlot::default()
                },
            ],
            ..FormState::default()
        };
        let rows = settings_rows(&form);
        let labels: Vec<&str> = rows.iter().map(|(label, _)| *label).collect();
        assert!(!labels.contains(&"Negative prompt"));
        assert!(!labels.contains(&"Sampler"));
        assert!(rows.contains(&("Width", "832".into())));
        assert!(rows.contains(&("CFG", "6.5".into())));
        assert_eq!(rows.last(), Some(&("LoRAs", "a (0.8/1)".into())));
    }
}
