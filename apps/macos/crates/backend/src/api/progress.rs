//! What a running job is doing, in the one wording every client uses for
//! hosted, self-hosted and video cards (`packages/shared/generation-progress.ts`).

/// The progress fields a row carries, whichever table it is from.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProgressFields<'a> {
    /// `status == "pending"`.
    pub pending: bool,
    pub video: bool,
    /// The row was handed to a worker (`dispatchedAt` is set). Self-hosted
    /// image rows never have it: they only wait for the pod's queue.
    pub dispatched: bool,
    pub stage: Option<&'a str>,
    pub message: Option<&'a str>,
    pub current: Option<f64>,
    pub total: Option<f64>,
    pub queue_position: Option<f64>,
}

/// Provider text is useful status, but untrusted: one line, at most 160 chars.
pub fn sanitize_progress_message(message: &str) -> Option<String> {
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    (!compact.is_empty()).then(|| compact.chars().take(160).collect())
}

impl ProgressFields<'_> {
    /// 0–100 when the backend reports steps, else `None` (indeterminate).
    pub fn percent(&self) -> Option<f32> {
        let (current, total) = (self.current?, self.total?);
        (current.is_finite() && total.is_finite() && total > 0.0)
            .then(|| (current / total * 100.0).clamp(0.0, 100.0) as f32)
    }

    pub fn label(&self) -> String {
        let message = self.message.and_then(sanitize_progress_message);
        let media = if self.video { "video" } else { "image" };
        let waiting = || {
            if self.dispatched {
                "Queued…".to_string()
            } else {
                "Waiting for a worker slot…".to_string()
            }
        };
        let Some(stage) = self.stage else {
            // No stage yet: the provider's text is not shown, as on the web.
            return if self.pending {
                waiting()
            } else {
                format!("Generating {media}…")
            };
        };
        if let Some(message) = message {
            return message;
        }
        match stage {
            "queued" => waiting(),
            "preparing" => "Preparing request…".into(),
            "preparing-inputs" if self.video => "Preparing source media…".into(),
            "preparing-inputs" => "Preparing reference images…".into(),
            "submitting" => "Sending to provider…".into(),
            "provider-queued" => match self.queue_position {
                None => "Waiting in provider queue…".into(),
                Some(position) if position <= 0.0 => "Next in provider queue…".into(),
                Some(1.0) => "1 job ahead…".into(),
                Some(position) => format!("{position} jobs ahead…"),
            },
            "generating" => format!("Generating {media}…"),
            "saving-output" => "Saving result to media storage…".into(),
            "downloading-output" => "Downloading generated media…".into(),
            "uploading-output" => "Uploading result to media storage…".into(),
            "finalizing" => "Finalizing result…".into(),
            _ if self.pending => waiting(),
            _ => format!("Generating {media}…"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged(stage: &str) -> ProgressFields<'_> {
        ProgressFields {
            stage: Some(stage),
            ..ProgressFields::default()
        }
    }

    #[test]
    fn reports_only_determinate_progress_with_a_valid_total() {
        let mut fields = staged("generating");
        (fields.current, fields.total) = (Some(6.0), Some(24.0));
        assert_eq!(fields.percent(), Some(25.0));
        (fields.current, fields.total) = (Some(30.0), Some(24.0));
        assert_eq!(fields.percent(), Some(100.0));
        (fields.current, fields.total) = (Some(1.0), Some(0.0));
        assert_eq!(fields.percent(), None);
    }

    #[test]
    fn uses_the_queue_position_and_provider_messages() {
        let mut fields = staged("provider-queued");
        fields.queue_position = Some(2.0);
        assert_eq!(fields.label(), "2 jobs ahead…");
        fields.queue_position = Some(0.0);
        assert_eq!(fields.label(), "Next in provider queue…");
        fields.message = Some("  Loading   model weights...\n");
        assert_eq!(fields.label(), "Loading model weights...");
    }

    #[test]
    fn tells_a_waiting_job_from_a_queued_one() {
        let mut fields = ProgressFields {
            pending: true,
            message: Some("ignored without a stage"),
            ..ProgressFields::default()
        };
        assert_eq!(fields.label(), "Waiting for a worker slot…");
        fields.dispatched = true;
        assert_eq!(fields.label(), "Queued…");
        fields.pending = false;
        fields.video = true;
        assert_eq!(fields.label(), "Generating video…");
    }

    #[test]
    fn bounds_provider_text() {
        assert_eq!(
            sanitize_progress_message(" a\n\n b ").as_deref(),
            Some("a b")
        );
        assert_eq!(
            sanitize_progress_message(&"x".repeat(200)).map(|text| text.len()),
            Some(160)
        );
        assert_eq!(sanitize_progress_message("  \n"), None);
    }
}
