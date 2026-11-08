//! The two prompt helpers that sit beside every composer's prompt field (the
//! web's prompt-library.tsx and prompt-enhance-button.tsx):
//!
//! - [`PromptLibrary`]: Save the current prompt, or drop a saved one in.
//! - [`PromptEnhance`]: one click runs the default recipe for the media type;
//!   the chevron lists the rest and a one-off instruction. The result replaces
//!   the field and the notification offers Undo.
//!
//! Both are given closures for the prompt rather than the field itself, so a
//! composer keeps owning its text (and hears every change it makes). Both read
//! the app's one [`PromptStore`], so every composer shares one subscription
//! to the saved prompts and one to the recipes.
//!
//! A result that arrives later than the field it was meant for is never
//! written over something else: Enhance replaces the prompt only while the
//! field still shows the text it was asked about, for the same form, and
//! Undo only while the field still shows what was put in. Otherwise the
//! notification offers the result to apply by hand.

use std::{rc::Rc, sync::Arc, time::Duration};

use artsnack_backend::{
    Backend,
    api::{
        enhance_recipes::{Recipe, RecipeMedia},
        prompt_enhance::{self, EnhanceArgs, Enhanced},
        saved_prompts::{self, SaveArgs, SavedPrompt},
    },
};
use artsnack_rules::Rules;
use artsnack_settings::{Preference, Preferences};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ListAlignment, ListSizingBehavior, ListState, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, actions,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _, Sizable as _, WindowExt as _,
        button::{Button, ButtonVariants as _},
        h_flex,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        menu::{DropdownMenu as _, PopupMenuItem},
        notification::Notification,
        popover::Popover,
        scroll::ScrollableElement as _,
        spinner::Spinner,
        v_flex,
    },
    div, list,
    prelude::FluentBuilder as _,
    px,
};
use serde::Serialize;
use serde_json::Value;

use crate::store::{PromptStore, StoreEvent};

actions!(
    prompts,
    [
        /// Show the Prompts screen on its saved prompts.
        OpenSavedPrompts,
        /// Show the Prompts screen on its Enhance recipes.
        OpenRecipes,
        /// Run the custom instruction being typed (Cmd+Enter in its box).
        RunCustomInstruction
    ]
);

/// The key context around the custom-instruction box.
const INSTRUCTION_CONTEXT: &str = "PromptEnhanceInstruction";

/// Binds Cmd+Enter in the custom-instruction box to that instruction. The box
/// sits inside a composer, whose own Cmd+Enter-in-any-field binding would
/// otherwise start a (paid) generation; the two tie on depth, so this has to be
/// registered after the composers' bindings to win.
pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([gpui_kit::KeyBinding::new(
        "cmd-enter",
        RunCustomInstruction,
        Some(&format!("{INSTRUCTION_CONTEXT} > Input")),
    )]);
}

/// Reads the composer's prompt as it is now.
pub type PromptReader = Rc<dyn Fn(&App) -> String>;
/// Replaces the composer's prompt.
pub type PromptWriter = Rc<dyn Fn(String, &mut Window, &mut App)>;

/// How long the client waits for an enhancement: as long as Convex lets an
/// action run. One provider request may take 120 s and be retried, and a
/// Grok failure then tries Atlas — the server's own budget decides when it
/// gives up, and the button stays busy until it has, so the same paid call
/// is never sent twice.
const ENHANCE_DEADLINE: Duration = Duration::from_secs(600);

/// The saved-prompt dropdown's height before it scrolls.
const LIST_MAX_HEIGHT: f32 = 384.;

/// "Prompt replaced" with Undo, when something typed is about to be lost.
/// Undo puts `previous` back only while the field still shows `replaced_with`;
/// once it was edited (or another form is open), Undo would destroy that.
fn replaced_notice(
    previous: String,
    replaced_with: String,
    read: PromptReader,
    write: PromptWriter,
    title: impl Into<SharedString>,
    detail: Option<String>,
) -> Notification {
    let notice = match detail {
        Some(detail) => Notification::info(detail).title(title),
        None => Notification::info(title),
    };
    notice.action(move |_, _, cx| {
        let (previous, replaced_with) = (previous.clone(), replaced_with.clone());
        let (read, write) = (read.clone(), write.clone());
        Button::new("prompt-undo")
            .small()
            .label("Undo")
            .on_click(cx.listener(move |notification, _, window, cx| {
                if read(cx) == replaced_with {
                    write(previous.clone(), window, cx);
                } else {
                    window.push_notification(
                        Notification::info("The prompt was changed since — nothing was undone"),
                        cx,
                    );
                }
                notification.dismiss(window, cx);
            }))
    })
}

/// An enhancement for a field that has moved on: offered, not written.
fn ready_notice(
    text: String,
    read: PromptReader,
    write: PromptWriter,
    title: impl Into<SharedString>,
    detail: Option<String>,
) -> Notification {
    let message =
        "The prompt changed while it was being enhanced. Apply replaces what is there now.";
    let message = match detail {
        Some(detail) => format!("{message} {detail}"),
        None => message.to_string(),
    };
    Notification::info(message)
        .title(title)
        .autohide(false)
        .action(move |_, _, cx| {
            let text = text.clone();
            let (read, write) = (read.clone(), write.clone());
            Button::new("prompt-apply")
                .small()
                .label("Apply")
                .on_click(cx.listener(move |notification, _, window, cx| {
                    let previous = read(cx);
                    write(text.clone(), window, cx);
                    notification.dismiss(window, cx);
                    if !previous.trim().is_empty() && previous != text {
                        window.push_notification(
                            replaced_notice(
                                previous,
                                text.clone(),
                                read.clone(),
                                write.clone(),
                                "Prompt replaced",
                                None,
                            ),
                            cx,
                        );
                    }
                }))
        })
}

// --- Saved prompts ------------------------------------------------------------

/// The saved prompts the filter lets through, for the rows they were worked
/// out from.
struct Matches {
    rows: Arc<Vec<SavedPrompt>>,
    needle: String,
    indices: Vec<usize>,
}

pub struct PromptLibrary {
    store: Entity<PromptStore>,
    filter: Entity<InputState>,
    /// The dropdown's rows: only those on screen are built.
    list: ListState,
    matches: Option<Matches>,
    open: bool,
    saving: bool,
    read: PromptReader,
    write: PromptWriter,
    _subscriptions: Vec<Subscription>,
}

impl PromptLibrary {
    pub fn new(
        read: PromptReader,
        write: PromptWriter,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let store = PromptStore::global(cx);
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter saved prompts"));
        let subscriptions = vec![
            cx.subscribe(&store, |_, _, event: &StoreEvent, cx| {
                if *event == StoreEvent::SavedPrompts {
                    cx.notify();
                }
            }),
            cx.subscribe(&filter, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
        ];
        Self {
            store,
            filter,
            list: ListState::new(0, ListAlignment::Top, px(LIST_MAX_HEIGHT)),
            matches: None,
            open: false,
            saving: false,
            read,
            write,
            _subscriptions: subscriptions,
        }
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = (self.read)(cx).trim().to_string();
        if text.is_empty() || self.saving {
            return;
        }
        self.saving = true;
        cx.notify();
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.mutate(
                saved_prompts::SAVE,
                &SaveArgs {
                    text,
                    ..SaveArgs::default()
                },
                cx,
            )
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                cx.notify();
            });
            let notification = match result {
                Ok(saved) if saved.duplicate => Notification::info("Already saved"),
                Ok(_) => Notification::success("Prompt saved"),
                Err(error) => Notification::error(error.user_message()),
            };
            let _ = window_handle.update(cx, |_, window, cx| {
                window.push_notification(notification, cx)
            });
        })
        .detach();
    }

    fn insert(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let previous = (self.read)(cx);
        (self.write)(text.clone(), window, cx);
        self.set_open(false, window, cx);
        // Inserting replaces the field; what was there took effort too.
        if !previous.trim().is_empty() && previous != text {
            window.push_notification(
                replaced_notice(
                    previous,
                    text,
                    self.read.clone(),
                    self.write.clone(),
                    "Prompt replaced",
                    None,
                ),
                cx,
            );
        }
    }

    fn set_open(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.open = open;
        if !open {
            // A filter left behind would disagree with the count next time.
            self.filter
                .update(cx, |filter, cx| filter.set_value("", window, cx));
        }
        cx.notify();
    }

    /// Works the matches out again when the rows or the filter changed.
    fn refresh_matches(&mut self, rows: Arc<Vec<SavedPrompt>>, needle: String) {
        if self
            .matches
            .as_ref()
            .is_some_and(|matches| Arc::ptr_eq(&matches.rows, &rows) && matches.needle == needle)
        {
            return;
        }
        let indices: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                needle.is_empty()
                    || row.title.to_lowercase().contains(&needle)
                    || row.text.to_lowercase().contains(&needle)
            })
            .map(|(ix, _)| ix)
            .collect();
        self.list.reset(indices.len());
        self.matches = Some(Matches {
            rows,
            needle,
            indices,
        });
    }

    fn render_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let rows = self.store.read(cx).saved_prompts(cx);
        let Some(data) = rows.data else {
            if let Some(error) = rows.error {
                return v_flex()
                    .px_3()
                    .py_6()
                    .gap_2()
                    .items_center()
                    .text_sm()
                    .child(
                        div()
                            .text_center()
                            .text_color(theme.danger)
                            .child(format!("Could not load your prompts: {error}")),
                    )
                    .child(
                        Button::new("prompt-library-retry")
                            .xsmall()
                            .outline()
                            .label("Retry")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.store.update(cx, |store, cx| store.retry(cx));
                            })),
                    )
                    .into_any_element();
            }
            return div()
                .py_8()
                .flex()
                .justify_center()
                .child(Spinner::new())
                .into_any_element();
        };
        let needle = self.filter.read(cx).value().trim().to_lowercase();
        let total = data.len();
        self.refresh_matches(data, needle);
        let count = self
            .matches
            .as_ref()
            .map_or(0, |matches| matches.indices.len());
        if count == 0 {
            return div()
                .px_3()
                .py_8()
                .text_center()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(if total == 0 {
                    "Nothing saved yet — write a prompt and press Save."
                } else {
                    "No prompt matches that."
                })
                .into_any_element();
        }
        div()
            .relative()
            .child(
                list(
                    self.list.clone(),
                    cx.processor(|this, ix: usize, _, cx| this.render_row(ix, cx)),
                )
                .with_sizing_behavior(ListSizingBehavior::Infer)
                .w_full()
                .max_h(px(LIST_MAX_HEIGHT)),
            )
            .vertical_scrollbar(&self.list)
            .into_any_element()
    }

    fn render_row(&mut self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        let Some(row) = self.matches.as_ref().and_then(|matches| {
            matches
                .indices
                .get(ix)
                .and_then(|row_ix| matches.rows.get(*row_ix))
        }) else {
            return div().into_any_element();
        };
        let theme = cx.theme();
        let text = row.text.clone();
        v_flex()
            .id(SharedString::from(format!("saved-{}", row.id)))
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .cursor_pointer()
            .hover(|style| style.bg(theme.accent))
            .child(
                div()
                    .truncate()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .child(row.title.clone()),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .line_clamp(2)
                    .child(row.text.clone()),
            )
            .on_click(cx.listener(move |this, _, window, cx| this.insert(text.clone(), window, cx)))
            .into_any_element()
    }
}

impl Render for PromptLibrary {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let has_text = !(self.read)(cx).trim().is_empty();
        let count = self
            .store
            .read(cx)
            .saved_prompts(cx)
            .data
            .map(|prompts| prompts.len())
            .unwrap_or(0);
        let view = cx.entity();
        h_flex()
            .gap_1()
            .child(
                Button::new("prompt-save")
                    .ghost()
                    .xsmall()
                    .icon(IconName::BookmarkPlus)
                    .label("Save")
                    .loading(self.saving)
                    .disabled(!has_text || self.saving)
                    .tooltip(if has_text {
                        "Save this prompt"
                    } else {
                        "Nothing to save yet"
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
            )
            .child(
                Popover::new("prompt-library")
                    .anchor(gpui_kit::Anchor::TopRight)
                    .open(self.open)
                    .on_open_change({
                        let view = view.downgrade();
                        move |open, window, cx| {
                            let _ = view.update(cx, |this, cx| this.set_open(*open, window, cx));
                        }
                    })
                    .trigger(
                        Button::new("prompt-library-trigger")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Library)
                            .label("Saved")
                            .when(count > 0, |button| {
                                button.child(div().ml_1().opacity(0.6).child(count.to_string()))
                            }),
                    )
                    .content(move |_, _, cx| {
                        let filter = view.read(cx).filter.clone();
                        let list = view.update(cx, |this, cx| this.render_list(cx));
                        v_flex()
                            .w(px(480.))
                            .child(
                                div()
                                    .p_2()
                                    .border_b_1()
                                    .border_color(cx.theme().border)
                                    .child(Input::new(&filter).small().prefix(
                                        gpui_kit::component::Icon::new(IconName::Search).xsmall(),
                                    )),
                            )
                            .child(list)
                            .child(
                                div()
                                    .px_3()
                                    .py_2()
                                    .border_t_1()
                                    .border_color(cx.theme().border)
                                    .child(
                                        Button::new("prompt-manage")
                                            .ghost()
                                            .xsmall()
                                            .label("Manage all prompts →")
                                            .on_click(|_, window, cx| {
                                                window
                                                    .dispatch_action(Box::new(OpenSavedPrompts), cx)
                                            }),
                                    ),
                            )
                    }),
            )
    }
}

// --- Enhance ------------------------------------------------------------------

/// The last custom instruction, offered again next time — they tend to repeat.
const LAST_INSTRUCTION: Preference<String> =
    Preference::new("prompts.lastCustomInstruction", String::new);

/// Supplies the `EnhanceContext` for the current form.
pub type ContextReader = Rc<dyn Fn(&App) -> Value>;

/// Which form a context is for: its media and target model. A composer with
/// several forms (H3 and LTX) says a different target for each.
fn form_key(context: &Value) -> (String, String) {
    let field = |name: &str| {
        context[name]
            .as_str()
            .map(str::to_string)
            .unwrap_or_default()
    };
    (field("media"), field("targetModel"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecipeKey<'a> {
    #[serde(rename = "_id")]
    id: &'a str,
    media: RecipeMedia,
    is_default: bool,
}

/// The recipes listed for a media type, for the recipe rows they were worked
/// out from (held, so the identity check cannot be fooled by a reused
/// address).
struct Listed {
    recipes: Arc<Vec<Recipe>>,
    media: String,
    listed: Rc<(Vec<Recipe>, Option<Recipe>)>,
}

pub struct PromptEnhance {
    store: Entity<PromptStore>,
    open: bool,
    custom: bool,
    instruction: Entity<TextareaState>,
    /// Which run is out: a recipe id or "custom".
    busy: Option<String>,
    listed_cache: Option<Listed>,
    read: PromptReader,
    write: PromptWriter,
    context: ContextReader,
    _subscriptions: Vec<Subscription>,
}

impl PromptEnhance {
    pub fn new(
        read: PromptReader,
        write: PromptWriter,
        context: ContextReader,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let store = PromptStore::global(cx);
        // Enter runs, Shift+Enter breaks the line.
        let instruction = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(4, 8)
                .submit_on_enter(true)
                .placeholder("e.g. Add more visual details about the lighting and the setting")
        });
        let subscriptions = vec![
            cx.subscribe(&store, |_, _, event: &StoreEvent, cx| {
                if *event != StoreEvent::SavedPrompts {
                    cx.notify();
                }
            }),
            cx.subscribe_in(&instruction, window, |this, _, event, window, cx| {
                if let InputEvent::PressEnter { shift: false, .. } = event {
                    this.run_custom(window, cx);
                }
            }),
        ];
        Self {
            store,
            open: false,
            custom: false,
            instruction,
            busy: None,
            listed_cache: None,
            read,
            write,
            context,
            _subscriptions: subscriptions,
        }
    }

    fn media(&self, cx: &App) -> String {
        let media = (self.context)(cx)["media"]
            .as_str()
            .unwrap_or("image")
            .to_string();
        if media == "video" {
            media
        } else {
            "image".into()
        }
    }

    /// The recipes listed for the media type (defaults first) and the default,
    /// worked out by the shared rules once per recipe list and media type.
    fn listed(&mut self, cx: &App) -> Rc<(Vec<Recipe>, Option<Recipe>)> {
        let Some(recipes) = self.store.read(cx).recipes(cx).data else {
            return Rc::new((Vec::new(), None));
        };
        let media = self.media(cx);
        if let Some(cached) = &self.listed_cache
            && Arc::ptr_eq(&cached.recipes, &recipes)
            && cached.media == media
        {
            return cached.listed.clone();
        }
        let listed = Rc::new(Self::work_out(&recipes, &media, cx));
        self.listed_cache = Some(Listed {
            recipes,
            media,
            listed: listed.clone(),
        });
        listed
    }

    fn work_out(recipes: &[Recipe], media: &str, cx: &App) -> (Vec<Recipe>, Option<Recipe>) {
        let keys: Vec<RecipeKey> = recipes
            .iter()
            .map(|recipe| RecipeKey {
                id: &recipe.id,
                media: recipe.media,
                is_default: recipe.is_default,
            })
            .collect();
        let pick = |ids: Vec<String>| -> Vec<Recipe> {
            ids.iter()
                .filter_map(|id| recipes.iter().find(|recipe| &recipe.id == id).cloned())
                .collect()
        };
        let Some(rules) = Rules::global(cx) else {
            return (Vec::new(), None);
        };
        #[derive(serde::Deserialize)]
        struct Key {
            #[serde(rename = "_id")]
            id: String,
        }
        let listed: Vec<Key> = rules
            .call("promptEnhance.recipesFor", &(&keys, media))
            .unwrap_or_default();
        let fallback: Option<Key> = rules
            .call("promptEnhance.defaultRecipeFor", &(&keys, media))
            .unwrap_or(None);
        (
            pick(listed.into_iter().map(|key| key.id).collect()),
            fallback.and_then(|key| recipes.iter().find(|recipe| recipe.id == key.id).cloned()),
        )
    }

    fn run(&mut self, recipe: Recipe, window: &mut Window, cx: &mut Context<Self>) {
        let sent = (self.read)(cx);
        let prompt = sent.trim().to_string();
        if prompt.is_empty() || self.busy.is_some() {
            return;
        }
        let args = EnhanceArgs {
            prompt,
            recipe_id: Some(recipe.id.clone()),
            instruction: None,
            context: (self.context)(cx),
        };
        self.start(
            args,
            sent,
            recipe.id.clone(),
            recipe.title.clone(),
            window,
            cx,
        );
    }

    fn run_custom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let sent = (self.read)(cx);
        let prompt = sent.trim().to_string();
        let instruction = self.instruction.read(cx).value().trim().to_string();
        if prompt.is_empty() || instruction.is_empty() || self.busy.is_some() {
            return;
        }
        Preferences::set(cx, &LAST_INSTRUCTION, instruction.clone());
        let args = EnhanceArgs {
            prompt,
            recipe_id: None,
            instruction: Some(instruction),
            context: (self.context)(cx),
        };
        self.start(
            args,
            sent,
            "custom".into(),
            "Custom instruction".into(),
            window,
            cx,
        );
    }

    /// Sends the request for the field as it is now (`sent`, exactly). The
    /// answer replaces the field only if it still shows `sent` in the same
    /// form; otherwise it is offered with Apply.
    fn start(
        &mut self,
        args: EnhanceArgs,
        sent: String,
        busy: String,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open = false;
        self.custom = false;
        self.busy = Some(busy);
        cx.notify();
        let form = form_key(&args.context);
        let task = Backend::global(cx).update(cx, |backend, cx| {
            backend.act_within(prompt_enhance::ENHANCE, &args, ENHANCE_DEADLINE, cx)
        });
        let window_handle = window.window_handle();
        let (read, write, context) = (self.read.clone(), self.write.clone(), self.context.clone());
        cx.spawn(async move |this, cx| {
            let result: Result<Enhanced, _> = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                cx.notify();
            });
            let _ = window_handle.update(cx, |_, window, cx| match result {
                Ok(enhanced) => {
                    let via = if enhanced.model.provider == "atlas" {
                        format!("Atlas · {}", enhanced.model.label)
                    } else {
                        enhanced.model.label.clone()
                    };
                    let cost = enhanced
                        .cost_usd
                        .map(|cost| format!(" · ${cost:.4}"))
                        .unwrap_or_default();
                    let label = format!("{title} · via {via}{cost}");
                    let detail = enhanced.fell_back.then(|| {
                        format!(
                            "Grok did not answer ({}), Atlas did.",
                            enhanced.reason.as_deref().unwrap_or("unknown")
                        )
                    });
                    let unchanged = read(cx) == sent && form_key(&context(cx)) == form;
                    let notice = if unchanged {
                        write(enhanced.text.clone(), window, cx);
                        replaced_notice(sent, enhanced.text, read, write, label, detail)
                    } else {
                        ready_notice(enhanced.text, read, write, label, detail)
                    };
                    window.push_notification(notice, cx);
                }
                Err(error) => {
                    window.push_notification(Notification::error(error.user_message()), cx)
                }
            });
        })
        .detach();
    }

    fn open_custom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let last = Preferences::get(cx, &LAST_INSTRUCTION);
        self.instruction.update(cx, |input, cx| {
            input.set_value(last, window, cx);
            input.focus(window, cx);
        });
        self.custom = true;
        cx.notify();
    }

    fn set_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.open = open;
        if open {
            // Opening the menu tries the built-ins again after a failed copy.
            self.store.update(cx, |store, cx| store.ensure_seeded(cx));
        } else {
            // Every opening starts at the list.
            self.custom = false;
        }
        cx.notify();
    }

    /// The menu's recipe rows, or why there are none.
    fn render_recipes(&mut self, has_text: bool, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = cx.theme().clone();
        let store = self.store.read(cx);
        let rows = store.recipes(cx);
        let seeding_error = store.seeding_error().cloned();
        if rows.data.is_none() {
            return vec![match rows.error {
                Some(error) => self.render_problem(
                    format!("Could not load your recipes: {error}"),
                    |store, cx| store.retry(cx),
                    cx,
                ),
                None => div()
                    .py_6()
                    .flex()
                    .justify_center()
                    .child(Spinner::new())
                    .into_any_element(),
            }];
        }
        let listed = self.listed(cx);
        let (listed, fallback) = (&listed.0, &listed.1);
        if listed.is_empty() {
            if let Some(error) = seeding_error {
                return vec![self.render_problem(
                    format!("The built-in recipes could not be added: {error}"),
                    |store, cx| store.ensure_seeded(cx),
                    cx,
                )];
            }
            let media = self.media(cx);
            return vec![
                div()
                    .px_3()
                    .py_6()
                    .text_center()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(format!("No recipes for {media} yet."))
                    .into_any_element(),
            ];
        }
        let models = crate::enhance_models(cx);
        listed
            .iter()
            .map(|recipe| {
                let is_default = fallback
                    .as_ref()
                    .is_some_and(|fallback| fallback.id == recipe.id);
                let summary = {
                    let first = recipe
                        .instructions
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let runs_on = recipe
                        .model_id
                        .as_ref()
                        .and_then(|id| models.iter().find(|model| &model.id == id))
                        .map(|model| format!("Runs on {} · ", model.label))
                        .unwrap_or_default();
                    format!("{runs_on}{}", strip_placeholders(&first))
                };
                let clicked = recipe.clone();
                h_flex()
                    .id(SharedString::from(format!("recipe-{}", recipe.id)))
                    .justify_between()
                    .gap_2()
                    .px_2()
                    .py_1p5()
                    .rounded(theme.radius)
                    .when(has_text, |this| {
                        this.cursor_pointer().hover(|style| style.bg(theme.accent))
                    })
                    .when(!has_text, |this| this.opacity(0.5))
                    .child(
                        v_flex()
                            .min_w_0()
                            .child(div().truncate().text_sm().child(recipe.title.clone()))
                            .child(
                                div()
                                    .truncate()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(summary),
                            ),
                    )
                    .when(is_default, |this| {
                        this.child(
                            div()
                                .flex_shrink_0()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("DEFAULT"),
                        )
                    })
                    .on_click(
                        cx.listener(move |this, _, window, cx| {
                            this.run(clicked.clone(), window, cx)
                        }),
                    )
                    .into_any_element()
            })
            .collect()
    }

    /// A problem in the menu, with Retry.
    fn render_problem(
        &self,
        message: String,
        retry: fn(&mut PromptStore, &mut Context<PromptStore>),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        v_flex()
            .px_3()
            .py_4()
            .gap_2()
            .items_center()
            .text_sm()
            .child(
                div()
                    .text_center()
                    .text_color(cx.theme().danger)
                    .child(message),
            )
            .child(
                Button::new("enhance-retry")
                    .xsmall()
                    .outline()
                    .label("Retry")
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.store.update(cx, retry);
                    })),
            )
            .into_any_element()
    }

    fn render_menu(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let has_text = !(self.read)(cx).trim().is_empty();
        let models = crate::enhance_models(cx);
        let model_id = self
            .store
            .read(cx)
            .settings(cx)
            .map(|settings| settings.model_id)
            .unwrap_or_default();
        let model_label = models
            .iter()
            .find(|model| model.id == model_id)
            .or_else(|| models.first())
            .map(|model| model.label.clone())
            .unwrap_or_default();

        let body: AnyElement = if self.custom {
            v_flex()
                .gap_2()
                .p_1()
                .child(
                    h_flex()
                        .gap_1()
                        .child(
                            Button::new("enhance-back")
                                .ghost()
                                .xsmall()
                                .icon(IconName::ArrowLeft)
                                .tooltip("Back to recipes")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.custom = false;
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .text_sm()
                                .font_weight(gpui_kit::FontWeight::MEDIUM)
                                .child("Custom instruction"),
                        ),
                )
                .child(
                    div()
                        .key_context(INSTRUCTION_CONTEXT)
                        .on_action(cx.listener(|this, _: &RunCustomInstruction, window, cx| {
                            this.run_custom(window, cx)
                        }))
                        .child(Textarea::new(&self.instruction)),
                )
                .child(
                    Button::new("enhance-custom-run")
                        .primary()
                        .small()
                        .w_full()
                        .icon(IconName::Sparkles)
                        .label("Enhance")
                        .disabled(!has_text || self.instruction.read(cx).value().trim().is_empty())
                        .on_click(cx.listener(|this, _, window, cx| this.run_custom(window, cx))),
                )
                .into_any_element()
        } else {
            let rows = self.render_recipes(has_text, cx);
            v_flex()
                .children(rows)
                .child(div().my_1().border_t_1().border_color(theme.border))
                .child(
                    v_flex()
                        .id("enhance-custom")
                        .px_2()
                        .py_1p5()
                        .rounded(theme.radius)
                        .cursor_pointer()
                        .hover(|style| style.bg(theme.accent))
                        .child(div().text_sm().child("Custom instruction…"))
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("Tell the model what to change"),
                        )
                        .on_click(cx.listener(|this, _, window, cx| this.open_custom(window, cx))),
                )
                .into_any_element()
        };

        let model_menu = Button::new("enhance-model")
            .ghost()
            .xsmall()
            .label(format!("Model · {model_label}"))
            .icon(IconName::ChevronDown)
            .dropdown_menu(move |mut menu, _, _| {
                for model in &models {
                    let id = model.id.clone();
                    let label = if model.provider == "atlas" {
                        format!("{} · Atlas", model.label)
                    } else {
                        format!("{} · subscription", model.label)
                    };
                    menu = menu.item(
                        PopupMenuItem::new(label)
                            .checked(model.id == model_id)
                            .on_click(move |_, window, cx| {
                                let window = window.window_handle();
                                PromptStore::global(cx).update(cx, |store, cx| {
                                    store.set_model(id.clone(), window, cx)
                                });
                            }),
                    );
                }
                menu
            });

        v_flex()
            .w(px(288.))
            .p_1()
            .child(body)
            .child(
                h_flex()
                    .mt_1()
                    .pt_1p5()
                    .px_1()
                    .justify_between()
                    .border_t_1()
                    .border_color(theme.border)
                    .child(model_menu)
                    .child(
                        Button::new("enhance-edit-recipes")
                            .ghost()
                            .xsmall()
                            .label("Edit recipes →")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open = false;
                                cx.notify();
                                window.dispatch_action(Box::new(OpenRecipes), cx);
                            })),
                    ),
            )
            .into_any_element()
    }
}

/// `{{targetModel}}` → `…`, as the menu's one-line summary shows it.
fn strip_placeholders(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        match rest[start..].find("}}") {
            Some(end) => {
                out.push('…');
                rest = &rest[start + end + 2..];
            }
            None => {
                rest = &rest[start..];
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

impl Render for PromptEnhance {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let has_text = !(self.read)(cx).trim().is_empty();
        let fallback = self.listed(cx).1.clone();
        let busy = self.busy.is_some();
        let tooltip = if !has_text {
            "Write something first".to_string()
        } else {
            match &fallback {
                Some(recipe) => format!("Enhance with \u{201c}{}\u{201d}", recipe.title),
                None => "No recipe for this media type".to_string(),
            }
        };
        let view = cx.entity();
        h_flex()
            .child(
                Button::new("prompt-enhance")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Sparkles)
                    .label(if busy { "Enhancing" } else { "Enhance" })
                    .loading(busy)
                    .disabled(!has_text || busy || fallback.is_none())
                    .tooltip(tooltip)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(recipe) = fallback.clone() {
                            this.run(recipe, window, cx);
                        }
                    })),
            )
            .child(
                Popover::new("prompt-enhance-menu")
                    .anchor(gpui_kit::Anchor::TopRight)
                    .open(self.open)
                    .on_open_change({
                        let view = view.downgrade();
                        move |open, _, cx| {
                            let _ = view.update(cx, |this, cx| this.set_open(*open, cx));
                        }
                    })
                    .trigger(
                        Button::new("prompt-enhance-chevron")
                            .ghost()
                            .xsmall()
                            .icon(IconName::ChevronDown)
                            .tooltip("Choose an enhance recipe")
                            .disabled(busy),
                    )
                    .content(move |_, _, cx| view.update(cx, |this, cx| this.render_menu(cx))),
            )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{form_key, strip_placeholders};

    #[test]
    fn hides_placeholders_in_summaries() {
        assert_eq!(
            strip_placeholders("Rewrite for {{targetModel}} as {{ media }}."),
            "Rewrite for … as …."
        );
        assert_eq!(strip_placeholders("plain"), "plain");
        assert_eq!(strip_placeholders("open {{brace"), "open {{brace");
    }

    #[test]
    fn a_form_is_its_media_and_target_model() {
        let h3 = json!({ "media": "video", "targetModel": "MiniMax H3", "duration": 5 });
        let longer = json!({ "media": "video", "targetModel": "MiniMax H3", "duration": 10 });
        let ltx = json!({ "media": "video", "targetModel": "LTX 2.3" });
        assert_eq!(form_key(&h3), form_key(&longer));
        assert_ne!(form_key(&h3), form_key(&ltx));
    }
}
