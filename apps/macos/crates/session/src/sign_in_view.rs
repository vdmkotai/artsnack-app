//! The screen shown while nobody is signed in.
//!
//! One path only: Google sign-in in the default browser, handed back through
//! `artsnack-native://`. The web app's "Other ways to sign in" fallback ran
//! Clerk's own UI in the window; there is no such UI natively, and the owner
//! signs in with Google.

use gpui_kit::{
    Context, Entity, FontWeight, IntoElement, ParentElement as _, Render, Styled as _,
    Subscription, Window,
    assets::IconName,
    component::{
        ActiveTheme as _, Disableable as _,
        button::{Button, ButtonVariants as _},
        spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

use crate::{Session, SessionStatus};

pub struct SignInView {
    session: Entity<Session>,
    _observe: Subscription,
}

impl SignInView {
    pub fn new(session: Entity<Session>, cx: &mut Context<Self>) -> Self {
        let observe = cx.observe(&session, |_, _, cx| cx.notify());
        Self {
            session,
            _observe: observe,
        }
    }
}

impl Render for SignInView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let session = self.session.read(cx);
        let status = session.status().clone();
        let error = session.error().cloned();
        let waiting = status == SessionStatus::AwaitingBrowser;
        let completing = status == SessionStatus::Completing;
        let restoring = status == SessionStatus::Restoring;

        let message = if completing {
            "Finishing sign-in…"
        } else if waiting {
            "Finish signing in there. This window updates by itself."
        } else {
            "Google sign-in happens in your browser. It hands the session back to the app when it is done."
        };

        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .bg(cx.theme().background)
            .child(
                v_flex()
                    .w_96()
                    .gap_4()
                    .p_6()
                    .items_center()
                    .rounded(cx.theme().radius_lg)
                    .border_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().popover)
                    .shadow_lg()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Sign in to ArtSnack"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_center()
                            .text_color(cx.theme().muted_foreground)
                            .child(message),
                    )
                    .when(restoring || completing, |this| this.child(Spinner::new()))
                    .when(!restoring && !completing, |this| {
                        this.child(
                            Button::new("continue-in-browser")
                                .primary()
                                .w_full()
                                .icon(IconName::Globe)
                                .label(if waiting {
                                    "Open again in browser"
                                } else {
                                    "Continue in browser"
                                })
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.session
                                        .update(cx, |session, cx| session.begin_sign_in(cx));
                                })),
                        )
                    })
                    .when(waiting, |this| {
                        this.child(
                            Button::new("cancel-sign-in")
                                .ghost()
                                .label("Cancel")
                                .disabled(completing)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.session
                                        .update(cx, |session, cx| session.cancel_sign_in(cx));
                                })),
                        )
                    })
                    .when_some(error, |this, error| {
                        this.child(
                            div()
                                .text_sm()
                                .text_center()
                                .text_color(cx.theme().danger)
                                .child(error),
                        )
                    }),
            )
    }
}
