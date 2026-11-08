//! Reference images attached to the composer: prepared once at fal's ceiling
//! (Grok's tighter box is applied at submit), shown from a small decoded
//! preview, and kept on disk so a relaunch does not lose them — the web keeps
//! them in IndexedDB for the same reason.

use std::{path::PathBuf, sync::Arc};

use anyhow::Context as _;
use artsnack_media::{decode, upload};
use gpui_kit::{RenderImage, SharedString};
use serde::{Deserialize, Serialize};

use super::engine::RefInfo;

/// Files the decoder reads. AVIF and HEIC need a system decoder this build
/// does not have.
pub const ACCEPTED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
/// Past this the attachments are not persisted (the web's 128 MB cap).
const PERSIST_LIMIT_BYTES: usize = 128 * 1024 * 1024;
/// Thumbnails are 80 pt; decoded at twice that for Retina.
const PREVIEW_PIXELS: u32 = 160;

#[derive(Clone)]
pub struct Reference {
    pub id: SharedString,
    /// JPEG at fal's profile, what every provider but Grok receives.
    pub jpeg: Arc<Vec<u8>>,
    /// The same image re-encoded for Grok, made on the first Grok submit.
    pub grok_jpeg: Option<Arc<Vec<u8>>>,
    pub width: u32,
    pub height: u32,
    /// The source's width ÷ height.
    pub aspect: f32,
    pub selected: bool,
    /// The object key it came from, when it is one of the app's own outputs.
    pub source_key: Option<String>,
    pub preview: Arc<RenderImage>,
}

impl Reference {
    pub fn info(&self) -> RefInfo {
        RefInfo {
            id: self.id.to_string(),
            width: self.width,
            height: self.height,
            aspect: self.aspect,
            bytes: self.jpeg.len(),
        }
    }
}

/// Prepares raw image bytes for attaching. Runs off the main thread.
pub fn prepare(
    bytes: &[u8],
    limits: &upload::ProfileLimits,
    source_key: Option<String>,
) -> anyhow::Result<Reference> {
    let prepared = upload::prepare(bytes, limits)?;
    let preview = decode::decode(&prepared.jpeg, Some(PREVIEW_PIXELS))?;
    Ok(Reference {
        id: new_id().into(),
        jpeg: Arc::new(prepared.jpeg),
        grok_jpeg: None,
        width: prepared.width,
        height: prepared.height,
        aspect: prepared.aspect,
        selected: true,
        source_key,
        preview: Arc::new(preview),
    })
}

/// Base-36 time plus randomness, like the web's `refId`.
fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    format!("{millis:x}-{:06x}", rand::random::<u32>() & 0xff_ffff)
}

pub fn is_accepted(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| ACCEPTED_EXTENSIONS.contains(&extension.to_lowercase().as_str()))
}

// --- Persistence ------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    width: u32,
    height: u32,
    aspect: f32,
    selected: bool,
    source_key: Option<String>,
}

fn store_dir() -> Option<PathBuf> {
    artsnack_settings::app_support_dir().map(|dir| dir.join("api-references"))
}

/// Writes the attachments, replacing what was stored. Runs off the main
/// thread, one write at a time (the composer's writer). Each file is written
/// whole and renamed into place, the index last, and files the index no
/// longer names are removed only after it is in place — a crash at any point
/// leaves the previous set or the new one, never a mix.
pub fn save(references: &[Reference]) -> anyhow::Result<()> {
    let Some(dir) = store_dir() else {
        return Ok(());
    };
    let files: Vec<(Stored, &[u8])> = references
        .iter()
        .map(|reference| {
            (
                Stored {
                    id: reference.id.to_string(),
                    width: reference.width,
                    height: reference.height,
                    aspect: reference.aspect,
                    selected: reference.selected,
                    source_key: reference.source_key.clone(),
                },
                reference.jpeg.as_slice(),
            )
        })
        .collect();
    save_in(&dir, files)
}

fn save_in(dir: &std::path::Path, mut files: Vec<(Stored, &[u8])>) -> anyhow::Result<()> {
    let total: usize = files.iter().map(|(_, jpeg)| jpeg.len()).sum();
    if total > PERSIST_LIMIT_BYTES {
        // Too large to keep: better to lose them on relaunch than fill the
        // disk, and an empty set rather than an older one coming back.
        files.clear();
    }
    std::fs::create_dir_all(dir).context("creating the reference store")?;
    for (stored, jpeg) in &files {
        let path = dir.join(format!("{}.jpg", stored.id));
        if !path.exists() {
            write_whole(&path, jpeg).context("writing a reference")?;
        }
    }
    let index: Vec<Stored> = files.into_iter().map(|(stored, _)| stored).collect();
    write_whole(&dir.join("index.json"), &serde_json::to_vec(&index)?)
        .context("writing the reference index")?;
    // Files of references no longer attached, and leftovers of an
    // interrupted write.
    let keep: std::collections::HashSet<String> = index
        .iter()
        .map(|stored| format!("{}.jpg", stored.id))
        .collect();
    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if (name.ends_with(".jpg") && !keep.contains(&name)) || name.ends_with(".partial") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Writes `bytes` beside `path` and renames them over it.
fn write_whole(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut partial = path.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    std::fs::write(&partial, bytes)?;
    std::fs::rename(&partial, path)
}

/// The attachments of the last session. Runs off the main thread.
pub fn load() -> anyhow::Result<Vec<Reference>> {
    let Some(dir) = store_dir() else {
        return Ok(Vec::new());
    };
    let Ok(index) = std::fs::read(dir.join("index.json")) else {
        return Ok(Vec::new());
    };
    let index: Vec<Stored> = serde_json::from_slice(&index)?;
    let mut references = Vec::with_capacity(index.len());
    for stored in index {
        let Ok(jpeg) = std::fs::read(dir.join(format!("{}.jpg", stored.id))) else {
            continue;
        };
        // One unreadable file costs that attachment, not the others.
        let Ok(preview) = decode::decode(&jpeg, Some(PREVIEW_PIXELS)) else {
            tracing::warn!(id = stored.id, "could not decode a saved reference");
            continue;
        };
        references.push(Reference {
            id: stored.id.into(),
            jpeg: Arc::new(jpeg),
            grok_jpeg: None,
            width: stored.width,
            height: stored.height,
            aspect: stored.aspect,
            selected: stored.selected,
            source_key: stored.source_key,
            preview: Arc::new(preview),
        });
    }
    Ok(references)
}

// --- The strip ----------------------------------------------------------------

use gpui_kit::{
    AnyElement, AppContext as _, Context, ExternalPaths, ImageSource, InteractiveElement as _,
    IntoElement, ObjectFit, ParentElement as _, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Icon, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        menu::{DropdownMenu as _, PopupMenuItem},
        spinner::Spinner,
        tooltip::Tooltip,
        v_flex,
    },
    div, img,
    prelude::FluentBuilder as _,
    px,
};

use super::{
    ApiComposer,
    engine::{ComposerView, Edit, GrokRoleView},
};

/// Keyframe times step by a third of a second, the grid xAI snaps them to.
const KEYFRAME_STEP: f64 = 1.0 / 3.0;

/// One image's role menu on Grok 1.5 and, for a keyframe, its time with
/// steppers (the shared rule keeps it strictly inside the clip).
fn render_grok_role(
    id: &SharedString,
    index: usize,
    role: &GrokRoleView,
    cx: &mut Context<ApiComposer>,
) -> AnyElement {
    let current = role
        .options
        .iter()
        .find(|option| option.value.as_str() == Some(role.value.as_str()))
        .map(|option| option.label.clone())
        .unwrap_or_else(|| role.value.clone());
    let options = role.options.clone();
    let view = cx.entity().downgrade();
    let selected = role.value.clone();
    let menu = Button::new(SharedString::from(format!("ref-role-{id}")))
        .outline()
        .xsmall()
        .w(px(80.))
        .label(current)
        .icon(IconName::ChevronDown)
        .dropdown_menu(move |mut menu, _, _| {
            for option in &options {
                let Some(value) = option.value.as_str().map(str::to_string) else {
                    continue;
                };
                let view = view.clone();
                let checked = value == selected;
                menu = menu.item(
                    PopupMenuItem::new(option.label.clone())
                        .checked(checked)
                        .disabled(option.disabled)
                        .on_click(move |_, _, cx| {
                            let role = value.clone();
                            let _ = view.update(cx, |this, cx| {
                                this.edit_from_control(Edit::GrokRole { index, role }, cx)
                            });
                        }),
                );
            }
            menu
        });
    let Some(keyframe) = role.keyframe.clone() else {
        return menu.into_any_element();
    };
    let step = |delta: f64, icon: IconName, label: &'static str, suffix: &str| {
        // On the third-of-a-second grid xAI snaps to.
        let at = ((keyframe.at + delta) / KEYFRAME_STEP).round() * KEYFRAME_STEP;
        let disabled = at < keyframe.min - 0.01 || at > keyframe.max + 0.01;
        Button::new(SharedString::from(format!("ref-keyframe-{suffix}-{id}")))
            .ghost()
            .xsmall()
            .icon(icon)
            .tooltip(label)
            .disabled(disabled)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.edit_from_control(Edit::GrokKeyframeTime { index, at }, cx)
            }))
    };
    v_flex()
        .gap_0p5()
        .child(menu)
        .child(
            h_flex()
                .w(px(80.))
                .justify_between()
                .items_center()
                .child(step(-KEYFRAME_STEP, IconName::Minus, "Earlier", "earlier"))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(format!("{:.2}s", keyframe.at)),
                )
                .child(step(KEYFRAME_STEP, IconName::Plus, "Later", "later")),
        )
        .into_any_element()
}

impl ApiComposer {
    /// The reference block; absent, not disabled, for a model that takes none.
    pub(super) fn render_references(
        &mut self,
        view: &ComposerView,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let block = view.references.as_ref()?;
        let theme = cx.theme().clone();
        let mut selected_index = 0usize;
        let thumbnails: Vec<AnyElement> = self
            .references
            .iter()
            .map(|reference| {
                let index = reference.selected.then(|| {
                    selected_index += 1;
                    selected_index - 1
                });
                let issue =
                    index.and_then(|index| block.issues.iter().find(|issue| issue.index == index));
                let slot = index.and_then(|index| block.slots.get(index).cloned().flatten());
                // Grok 1.5: what this image does in the clip, under it.
                let role = index.and_then(|index| {
                    let role = block.roles.as_ref()?.get(index)?;
                    Some(render_grok_role(&reference.id, index, role, cx))
                });
                let id = reference.id.clone();
                let (toggle_id, remove_id) = (id.clone(), id.clone());
                let thumbnail = div()
                    .relative()
                    .size(px(80.))
                    .when(!reference.selected, |this| this.opacity(0.4))
                    .child(
                        div()
                            .id(SharedString::from(format!("ref-{id}")))
                            .size_full()
                            .rounded(theme.radius_lg)
                            .overflow_hidden()
                            .border_1()
                            .border_color(if issue.is_some() {
                                theme.danger
                            } else {
                                theme.border
                            })
                            .when(issue.is_some(), |this| this.border_2())
                            .child(
                                img(ImageSource::Render(reference.preview.clone()))
                                    .size_full()
                                    .object_fit(ObjectFit::Cover),
                            )
                            .cursor_pointer()
                            .on_click({
                                let id = id.clone();
                                cx.listener(move |this, _, window, cx| {
                                    this.preview_reference(&id, window, cx)
                                })
                            })
                            .when_some(
                                issue.map(|issue| issue.message.clone()),
                                |this, message| {
                                    this.tooltip(move |window, cx| {
                                        Tooltip::new(message.clone()).build(window, cx)
                                    })
                                },
                            ),
                    )
                    .when_some(slot.filter(|_| reference.selected), |this, slot| {
                        this.child(
                            div()
                                .absolute()
                                .bottom_1()
                                .left_1()
                                .px_1p5()
                                .rounded(theme.radius)
                                .bg(theme.background.opacity(0.9))
                                .text_xs()
                                .font_weight(gpui_kit::FontWeight::BOLD)
                                .child(slot),
                        )
                    })
                    .child(
                        div()
                            .id(SharedString::from(format!("ref-select-{id}")))
                            .absolute()
                            .top_1()
                            .left_1()
                            .size_4()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(3.))
                            .border_1()
                            .cursor_pointer()
                            .map(|this| {
                                if reference.selected {
                                    this.bg(theme.primary)
                                        .border_color(theme.primary)
                                        .text_color(theme.primary_foreground)
                                } else {
                                    this.bg(theme.background.opacity(0.8))
                                        .border_color(theme.border)
                                }
                            })
                            .when(reference.selected, |this| {
                                this.child(Icon::new(IconName::Check).xsmall())
                            })
                            .tooltip(move |window, cx| {
                                Tooltip::new(if index.is_some() {
                                    "Deselect reference"
                                } else {
                                    "Select reference"
                                })
                                .build(window, cx)
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.toggle_reference(&toggle_id, cx)
                            })),
                    )
                    .child(
                        div().absolute().top(px(-8.)).right(px(-8.)).child(
                            Button::new(SharedString::from(format!("ref-remove-{id}")))
                                .danger()
                                .xsmall()
                                .icon(IconName::X)
                                .tooltip("Remove reference image")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.remove_reference(&remove_id, cx)
                                })),
                        ),
                    );
                v_flex()
                    .gap_1()
                    .child(thumbnail)
                    .children(role)
                    .into_any_element()
            })
            .collect();

        let can_add = self.references.len() + self.preparing < block.attach_limit;
        let add_tile = |id: &'static str, icon: IconName, label: &'static str| {
            v_flex()
                .id(id)
                .size(px(80.))
                .items_center()
                .justify_center()
                .gap_1()
                .rounded(theme.radius_lg)
                .border_1()
                .border_dashed()
                .border_color(theme.border)
                .text_color(theme.muted_foreground)
                .cursor_pointer()
                .hover(|style| style.border_color(theme.primary).text_color(theme.primary))
                .child(Icon::new(icon))
                .child(div().text_xs().child(label))
        };
        let preparing = (0..self.preparing).map(|index| {
            div()
                .id(SharedString::from(format!("ref-preparing-{index}")))
                .size(px(80.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(theme.radius_lg)
                .border_1()
                .border_color(theme.border)
                .child(Spinner::new())
                .into_any_element()
        });

        let mode = block.input_mode.clone().map(|mode| {
            let frames_active = mode.current.as_deref() == Some("frames");
            let references_active = mode.current.as_deref() == Some("references");
            let (frames_id, references_id) = (mode.frames_id.clone(), mode.references_id.clone());
            h_flex()
                .justify_between()
                .gap_2()
                .child(
                    v_flex()
                        .min_w_0()
                        .child(div().text_xs().child("Use attached images as"))
                        .child(div().text_xs().text_color(theme.muted_foreground).child(mode.description.clone())),
                )
                .child(
                    h_flex()
                        .gap_0p5()
                        .p_0p5()
                        .rounded(theme.radius)
                        .bg(theme.muted)
                        .child(
                            Button::new("input-mode-frames")
                                .xsmall()
                                .when(frames_active, |button| button.secondary())
                                .when(!frames_active, |button| button.ghost())
                                .label(mode.frames_label.clone())
                                .disabled(!mode.frames_available)
                                .tooltip(if mode.frames_available {
                                    format!("Use the selected images as {} frames", mode.frames_label.to_lowercase())
                                } else {
                                    "Remove extra or reference-only inputs before switching to frames".to_string()
                                })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.edit_from_control(Edit::field("atlasVideoModel", frames_id.clone()), cx)
                                })),
                        )
                        .child(
                            Button::new("input-mode-references")
                                .xsmall()
                                .when(references_active, |button| button.secondary())
                                .when(!references_active, |button| button.ghost())
                                .label("References")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.edit_from_control(Edit::field("atlasVideoModel", references_id.clone()), cx)
                                })),
                        ),
                )
        });

        let drop_tint = theme.primary.opacity(0.05);
        let issues = (!block.issues.is_empty()).then(|| {
            v_flex()
                .gap_1()
                .px_3()
                .py_2()
                .rounded(theme.radius_lg)
                .border_1()
                .border_color(theme.danger.opacity(0.4))
                .bg(theme.danger.opacity(0.1))
                .text_xs()
                .text_color(theme.danger)
                .child(
                    div()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child("This model cannot use the highlighted reference."),
                )
                .children(
                    block
                        .issues
                        .iter()
                        .map(|issue| div().child(issue.message.clone())),
                )
        });

        Some(
            v_flex()
                .id("api-references")
                .gap_2()
                .rounded(theme.radius_lg)
                .drag_over::<ExternalPaths>(move |style, _, _, _| style.bg(drop_tint))
                .on_drop(
                    cx.listener(|this, paths: &ExternalPaths, _, cx| this.drop_files(paths, cx)),
                )
                .children(mode)
                .child(
                    h_flex()
                        .gap_1()
                        .child(div().text_xs().child(block.heading.clone()))
                        .child(
                            div()
                                .id("api-references-hint")
                                .child(Icon::new(IconName::Info).xsmall())
                                .tooltip({
                                    let hint: SharedString = block.hint.clone().into();
                                    move |window, cx| Tooltip::new(hint.clone()).build(window, cx)
                                }),
                        ),
                )
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_1p5()
                        .pt_2()
                        .pr_2()
                        .children(thumbnails)
                        .children(preparing)
                        .when(can_add, |this| {
                            this.child(add_tile("ref-upload", IconName::Plus, "Upload").on_click(
                                cx.listener(|this, _, window, cx| this.pick_files(window, cx)),
                            ))
                            .child(
                                add_tile("ref-gallery", IconName::ImagePlus, "Gallery").on_click(
                                    cx.listener(|this, _, window, cx| {
                                        this.open_gallery(window, cx)
                                    }),
                                ),
                            )
                        }),
                )
                .children(issues)
                .when_some(block.over_capacity.clone(), |this, text| {
                    this.child(div().text_xs().text_color(cx.theme().danger).child(text))
                })
                .into_any_element(),
        )
    }
}

/// The preview dialog's picture is decoded to at most this size.
const PREVIEW_DIALOG_PIXELS: u32 = 1600;

impl ApiComposer {
    /// A reference at size, with the generation it came from when it is one
    /// of the app's outputs (`preview::ReferencePreview`).
    pub(super) fn preview_reference(
        &mut self,
        id: &SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(reference) = self
            .references
            .iter()
            .find(|reference| &reference.id == id)
            .cloned()
        else {
            return;
        };
        let slot = self
            .references
            .iter()
            .filter(|candidate| candidate.selected)
            .position(|candidate| candidate.id == reference.id)
            .and_then(|index| {
                self.view
                    .as_ref()
                    .and_then(|view| view.references.as_ref())
                    .and_then(|block| block.slots.get(index).cloned().flatten())
            });
        let caption: SharedString = format!(
            "{} × {} · {} KB{}",
            reference.width,
            reference.height,
            reference.jpeg.len() / 1024,
            slot.map(|slot| format!(" · {slot}")).unwrap_or_default()
        )
        .into();
        let jpeg = reference.jpeg.clone();
        let decode = cx
            .background_executor()
            .spawn(async move { decode::decode(&jpeg, Some(PREVIEW_DIALOG_PIXELS)) });
        let window_handle = window.window_handle();
        let composer = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let Ok(image) = decode.await else {
                return;
            };
            let image = Arc::new(image);
            let _ = window_handle.update(cx, |_, window, cx| {
                let preview = cx.new(|cx| {
                    super::preview::ReferencePreview::new(
                        image,
                        caption,
                        reference.id.clone(),
                        reference.selected,
                        reference
                            .source_key
                            .clone()
                            .filter(|key| crate::reference_source::is_output_key(key, cx)),
                        composer,
                        cx,
                    )
                });
                window.open_dialog(cx, move |dialog, _, _| {
                    dialog
                        .title("Reference image")
                        .w(px(860.))
                        .child(preview.clone())
                });
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(id: &str) -> Stored {
        Stored {
            id: id.into(),
            width: 1,
            height: 1,
            aspect: 1.,
            selected: true,
            source_key: None,
        }
    }

    #[test]
    fn a_save_replaces_the_set_and_removes_what_it_no_longer_names() {
        let dir = std::env::temp_dir().join(format!("artsnack-references-{}", new_id()));
        save_in(&dir, vec![(stored("a"), b"one"), (stored("b"), b"two")]).unwrap();
        std::fs::write(dir.join("c.jpg.partial"), b"interrupted").unwrap();
        save_in(&dir, vec![(stored("b"), b"two")]).unwrap();

        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["b.jpg", "index.json"]);
        let index: Vec<Stored> =
            serde_json::from_slice(&std::fs::read(dir.join("index.json")).unwrap()).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].id, "b");
        let _ = std::fs::remove_dir_all(dir);
    }
}
