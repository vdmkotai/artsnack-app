//! The window shown instead of the app when it is not configured: what is
//! missing, and where to put it. Nothing else starts — no Convex connection,
//! no Clerk session, no media pipeline — so no request leaves the machine.

use gpui_kit::{
    App, AppContext as _, Bounds, ClipboardItem, Context, FontWeight, IntoElement, KeyBinding,
    Menu, MenuItem, ParentElement as _, Render, Styled as _, Window, WindowBounds, WindowOptions,
    component::{
        ActiveTheme as _,
        button::{Button, ButtonVariants as _},
        h_flex, v_flex,
    },
    div,
    prelude::FluentBuilder as _,
    px, size,
};

use crate::{
    commands::Quit,
    environment::{ConfigError, SETTINGS},
};

/// Runs the app as the setup window only. Closing it quits.
pub fn run(problem: ConfigError, cx: &mut App) {
    gpui_kit::init(cx);
    crate::theme::init(cx);
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-w", Quit, None),
    ]);
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.set_menus(vec![
        Menu::new("ArtSnack").items([MenuItem::action("Quit ArtSnack", Quit)]),
    ]);
    cx.on_window_closed(|cx, _| cx.quit()).detach();

    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(640.), px(600.)),
            cx,
        ))),
        ..Default::default()
    };
    let opened = gpui_kit::open_window(options, cx, |_, cx| cx.new(|_| SetupView { problem }));
    if let Err(error) = opened {
        tracing::error!(?error, "could not open the setup window");
        cx.quit();
        return;
    }
    cx.activate(true);
}

struct SetupView {
    problem: ConfigError,
}

impl Render for SetupView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let problem = &self.problem;
        let profile = problem.profile;
        let example = problem.example_file();
        let file = problem
            .file
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "config.json in the app's Application Support folder".into());

        let line = |text: String| div().text_sm().child(text);
        let mono = |text: String| {
            div()
                .p_3()
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .bg(theme.muted)
                .font_family(theme.mono_font_family.clone())
                .text_xs()
                .child(text)
        };

        v_flex()
            .size_full()
            .p_6()
            .gap_3()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("ArtSnack is not configured"),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(format!(
                        "This build has no backend built in. Tell it which deployment to use ({} profile; ARTSNACK_ENV=dev selects development).",
                        profile.name()
                    )),
            )
            .when_some(problem.file_problem.clone(), |this, file_problem| {
                this.child(div().text_sm().text_color(theme.danger).child(file_problem))
            })
            .children(problem.missing.iter().map(|setting| {
                line(format!(
                    "{} is not set: {}, e.g. {}",
                    setting.var_for(profile),
                    setting.role,
                    setting.example
                ))
            }))
            .children(
                problem
                    .invalid
                    .iter()
                    .map(|invalid| div().text_sm().text_color(theme.danger).child(invalid.clone())),
            )
            .child(
                div()
                    .pt_2()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(format!(
                        "Set them as environment variables ({}), or write them to {file}:",
                        SETTINGS
                            .iter()
                            .map(|setting| setting.var_for(profile))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )),
            )
            .child(mono(example.clone()))
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child("Then open ArtSnack again. A build can also carry them: set the same variables when running cargo build or script/install.sh."),
            )
            .child(
                h_flex()
                    .pt_2()
                    .gap_2()
                    .child(
                        Button::new("copy-example")
                            .outline()
                            .label("Copy Example")
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(example.clone()))
                            }),
                    )
                    .child(
                        Button::new("quit")
                            .primary()
                            .label("Quit")
                            .on_click(|_, _, cx| cx.quit()),
                    ),
            )
    }
}
