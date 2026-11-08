//! Generate's results column shows what is still running, and what failed,
//! ahead of the images: every running job, then the newest failures.

use std::sync::Arc;

use artsnack_backend::api::generations::Generation;
use gpui_kit::{
    AnyElement, App, IntoElement, ParentElement as _, Pixels, SharedString, Size, Styled as _,
    component::{
        ActiveTheme as _, Sizable as _, progress::Progress, skeleton::Skeleton, spinner::Spinner,
        v_flex,
    },
    div,
    prelude::FluentBuilder as _,
};

/// Failed jobs shown at most, newest first (the web's `slice(0, 3)`).
const MAX_FAILED_SHOWN: usize = 3;

/// The jobs of the loaded rows, in display order.
#[derive(Clone, Debug, Default)]
pub(crate) struct Jobs {
    pub shown: Vec<Arc<Generation>>,
    pub running: usize,
    /// Every loaded failure, shown or not ("Remove all failed" appears for any).
    pub failed: usize,
}

impl Jobs {
    pub fn of(rows: &[Arc<Generation>]) -> Self {
        let running: Vec<_> = rows
            .iter()
            .filter(|row| row.is_running())
            .cloned()
            .collect();
        let failed: Vec<_> = rows.iter().filter(|row| row.is_failed()).cloned().collect();
        let (running_count, failed_count) = (running.len(), failed.len());
        let mut shown = running;
        shown.extend(failed.into_iter().take(MAX_FAILED_SHOWN));
        Self {
            shown,
            running: running_count,
            failed: failed_count,
        }
    }

    /// The same rows as the same values: no job tile changed.
    pub fn is_same(&self, other: &Self) -> bool {
        self.failed == other.failed
            && self.shown.len() == other.shown.len()
            && self
                .shown
                .iter()
                .zip(&other.shown)
                .all(|(new, old)| Arc::ptr_eq(new, old))
    }
}

pub(crate) fn job_key(generation: &Generation) -> SharedString {
    format!("job:{}", generation.id).into()
}

/// A running job's placeholder, sized like the image it will become, or a
/// failure with its reason.
pub(crate) fn job_tile(generation: &Generation, size: Size<Pixels>, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let frame = div()
        .relative()
        .w(size.width)
        .h(size.height)
        .rounded(theme.radius_lg)
        .border_1()
        .overflow_hidden();

    if generation.is_failed() {
        let error = generation
            .error
            .as_deref()
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .unwrap_or("Unknown error")
            .to_string();
        return frame
            .border_color(theme.danger.opacity(0.3))
            .bg(theme.danger.opacity(0.1))
            .child(
                v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .px_4()
                    .text_center()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(theme.danger)
                            .child("Failed"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .line_clamp(2)
                            .child(error),
                    ),
            )
            .into_any_element();
    }

    let label = generation.progress_label();
    let percent = generation.progress_percent();
    frame
        .border_color(theme.border)
        .child(Skeleton::new().absolute().size_full())
        .child(
            v_flex()
                .relative()
                .size_full()
                .items_center()
                .justify_center()
                .gap_3()
                .px_4()
                .child(Spinner::new().large().color(theme.primary))
                .child(
                    v_flex()
                        .w_full()
                        .gap_1p5()
                        .child(
                            div()
                                .w_full()
                                .text_xs()
                                .text_center()
                                .text_color(theme.muted_foreground)
                                .truncate()
                                .child(label.clone())
                                .when_some(percent, |this, percent| {
                                    this.child(format!(" · {}%", percent.round() as u32))
                                }),
                        )
                        .child(
                            Progress::new(SharedString::from(format!(
                                "job-progress-{}",
                                generation.id
                            )))
                            .xsmall()
                            .value(percent.unwrap_or_default())
                            .loading(percent.is_none())
                            .accessibility_label(label),
                        ),
                ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use artsnack_backend::api::generations::{FormState, GenerationStatus};

    use super::*;

    fn row(id: &str, status: GenerationStatus) -> Arc<Generation> {
        Arc::new(Generation {
            id: id.into(),
            timestamp: 0.0,
            form_state: FormState::default(),
            b2_keys: Vec::new(),
            status: Some(status),
            error: None,
            progress_stage: None,
            progress_message: None,
            progress_current: None,
            progress_total: None,
            queue_position: None,
        })
    }

    #[test]
    fn shows_every_running_job_then_the_three_newest_failures() {
        use GenerationStatus::*;
        let rows = [
            row("f1", Failed),
            row("r1", Processing),
            row("c1", Completed),
            row("f2", Failed),
            row("r2", Pending),
            row("f3", Failed),
            row("f4", Failed),
        ];
        let jobs = Jobs::of(&rows);
        let order: Vec<&str> = jobs.shown.iter().map(|job| job.id.as_str()).collect();
        assert_eq!(order, ["r1", "r2", "f1", "f2", "f3"]);
        assert_eq!((jobs.running, jobs.failed), (2, 4));
        assert!(jobs.is_same(&Jobs::of(&rows)));
    }
}
