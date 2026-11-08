//! What the grid shows of the loaded rows under the current filters, worked
//! out once per change rather than per frame: the tiles in order (running,
//! then failed, then every output of each finished row), the rows a selection
//! can reach, the spend and the model chips.
//!
//! Filters are client-side over the loaded rows only, as on the web: they live
//! in the view, not in the query.

use std::{collections::HashMap, sync::Arc};

use artsnack_backend::api::{
    generations::GenerationStatus,
    grok_generations::{ApiGeneration, ApiProvider, MediaType},
};
use gpui_kit::SharedString;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum MediaFilter {
    #[default]
    All,
    Images,
    Videos,
}

/// The model chips. Atlas is one chip rather than four hundred: its models are
/// picked from a search dialog, and a row that could grow to the size of the
/// catalogue is not a filter row.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum ModelFilter {
    #[default]
    All,
    /// A registry model (Grok, fal, Higgsfield), by id.
    Model(String),
    Atlas,
    SelfHostedVideo,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Filters {
    pub media: MediaFilter,
    pub model: ModelFilter,
    /// Only liked outputs. Per output, not per row: one hearted image of a
    /// batch of four shows that one image.
    pub liked: bool,
}

impl Filters {
    pub fn is_active(&self) -> bool {
        self.liked || self.media != MediaFilter::All || self.model != ModelFilter::All
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ItemKind {
    /// Still running: a progress tile.
    Pending,
    Failed,
    /// One output of a finished row.
    Output {
        b2_key: String,
    },
}

/// One tile.
#[derive(Clone, Debug)]
pub(crate) struct Item {
    /// Stable identity for the tile, the viewer and the masonry.
    pub key: SharedString,
    pub row: Arc<ApiGeneration>,
    pub kind: ItemKind,
}

impl Item {
    pub fn b2_key(&self) -> Option<&str> {
        match &self.kind {
            ItemKind::Output { b2_key } => Some(b2_key),
            _ => None,
        }
    }
}

/// Spend of the rows on screen. Dollars and credits stay apart: Grok runs on a
/// subscription and Higgsfield on plan credits, and one figure would need an
/// exchange rate nobody publishes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Totals {
    /// fal and Atlas, finished and failed rows.
    pub spent_usd: f64,
    /// Higgsfield, finished and failed rows.
    pub spent_credits: f64,
    /// What the running rows will cost, reported apart so the same money is
    /// never counted twice.
    pub pending_usd: f64,
    pub pending_credits: f64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Content {
    pub items: Vec<Item>,
    /// Each item's place in `items`, by key.
    index: HashMap<SharedString, usize>,
    /// The rows with a tile, in display order: what Shift-click ranges and
    /// Select all walk. Selection is per row, so picking one image of a batch
    /// marks the whole row — the grid shows what a delete will take.
    pub rows: Vec<Arc<ApiGeneration>>,
    pub pending: usize,
    /// Every loaded failure, shown or not ("Remove all failed" acts on all).
    pub failed_loaded: usize,
    pub totals: Totals,
    /// A failure because the fal balance ran out: it blocks every later fal
    /// request, so the grid says so above the tiles.
    pub billing_failure: bool,
    /// Registry models present in the loaded rows, in no particular order.
    pub models_present: Vec<String>,
    pub has_atlas: bool,
    pub has_self_hosted_video: bool,
}

impl Content {
    /// The same tiles in the same places: the grid's layout, the viewer's
    /// sequence and what a selection can reach are unchanged.
    pub fn same_items(&self, other: &Self) -> bool {
        self.items.len() == other.items.len()
            && self
                .items
                .iter()
                .zip(&other.items)
                .all(|(a, b)| a.key == b.key)
    }

    pub fn row_ids(&self) -> impl Iterator<Item = &str> + Clone {
        self.rows.iter().map(|row| row.id.as_str())
    }

    pub fn item(&self, key: &str) -> Option<&Item> {
        self.items.get(*self.index.get(key)?)
    }

    /// Swaps in the new values of rows whose tiles stay where they are (see
    /// [`same_shape`]), and the totals they add up to.
    pub fn refresh(&mut self, changed: &HashMap<&str, &Arc<ApiGeneration>>, totals: Totals) {
        if !changed.is_empty() {
            for item in &mut self.items {
                if let Some(row) = changed.get(item.row.id.as_str()) {
                    item.row = Arc::clone(row);
                }
            }
            for row in &mut self.rows {
                if let Some(next) = changed.get(row.id.as_str()) {
                    *row = Arc::clone(next);
                }
            }
        }
        self.totals = totals;
    }

    /// The outputs, in grid order: the viewer's sequence (images and clips
    /// together, so the arrows walk the whole result set).
    pub fn outputs(&self) -> impl Iterator<Item = &Item> {
        self.items
            .iter()
            .filter(|item| matches!(item.kind, ItemKind::Output { .. }))
    }
}

/// A self-hosted clip from the video pod: no API composer, no per-clip price.
pub(crate) fn is_self_hosted_video(row: &ApiGeneration) -> bool {
    row.provider == Some(ApiProvider::Comfy)
}

/// The registry id a row was made with; rows from before the model switcher,
/// and Atlas rows (whose `apiModel` is a vendor slug), read as Grok.
pub(crate) fn model_id_of<'a>(row: &'a ApiGeneration, registry: &[String]) -> &'a str {
    match row.api_model.as_deref() {
        Some(model) if registry.iter().any(|id| id == model) => model,
        _ => "grok",
    }
}

fn matches(row: &ApiGeneration, filters: &Filters, registry: &[String]) -> bool {
    let media = match filters.media {
        MediaFilter::All => true,
        MediaFilter::Images => row.media_type == MediaType::Image,
        MediaFilter::Videos => row.media_type == MediaType::Video,
    };
    let provider = row.provider();
    let model = match &filters.model {
        ModelFilter::All => true,
        ModelFilter::SelfHostedVideo => is_self_hosted_video(row),
        // By provider: the chip stands for the whole catalogue, and
        // `model_id_of` would file every Atlas row under Grok.
        ModelFilter::Atlas => provider == ApiProvider::Atlas,
        ModelFilter::Model(id) => {
            provider != ApiProvider::Atlas
                && !is_self_hosted_video(row)
                && model_id_of(row, registry) == id
        }
    };
    media && model
}

pub(crate) fn pending_key(row: &ApiGeneration) -> SharedString {
    format!("pending:{}", row.id).into()
}

pub(crate) fn failed_key(row: &ApiGeneration) -> SharedString {
    format!("failed:{}", row.id).into()
}

pub(crate) fn output_key(row: &ApiGeneration, b2_key: &str) -> SharedString {
    format!("{}:{b2_key}", row.id).into()
}

/// Whether `next` holds the same rows as `previous` in the same order, each
/// in the same state with the same outputs — everything the tiles, their
/// order and the filters are derived from — so that only values a tile reads
/// as it draws (progress, a queue position, a cost) can differ. A running row
/// rewritten every second is such a change; it moves no tile.
pub(crate) fn same_shape(previous: &[Arc<ApiGeneration>], next: &[Arc<ApiGeneration>]) -> bool {
    previous.len() == next.len()
        && previous.iter().zip(next).all(|(a, b)| {
            Arc::ptr_eq(a, b)
                || (a.id == b.id
                    && a.status == b.status
                    && a.media_type == b.media_type
                    && a.provider == b.provider
                    && a.api_model == b.api_model
                    && a.error_kind == b.error_kind
                    && a.aspect_ratio == b.aspect_ratio
                    && a.b2_keys == b.b2_keys
                    && a.b2_key == b.b2_key)
        })
}

/// What the rows the filters let through cost: settled rows as spent,
/// running ones apart.
pub(crate) fn totals(
    rows: &[Arc<ApiGeneration>],
    filters: &Filters,
    registry: &[String],
    is_liked: impl Fn(&str) -> bool,
    cost_usd: impl Fn(&ApiGeneration) -> Option<f64>,
) -> Totals {
    let usd = |row: &ApiGeneration| match row.provider() {
        ApiProvider::Fal | ApiProvider::Atlas if !is_self_hosted_video(row) => {
            cost_usd(row).unwrap_or(0.0)
        }
        _ => 0.0,
    };
    let credits = |row: &ApiGeneration| match row.provider() {
        ApiProvider::Higgsfield => row.credits_used.unwrap_or(0.0),
        _ => 0.0,
    };
    let mut totals = Totals::default();
    for row in rows {
        if !matches(row, filters, registry) {
            continue;
        }
        match row.status {
            GenerationStatus::Pending | GenerationStatus::Processing if !filters.liked => {
                totals.pending_usd += usd(row);
                totals.pending_credits += credits(row);
            }
            GenerationStatus::Failed if !filters.liked => {
                totals.spent_usd += usd(row);
                totals.spent_credits += credits(row);
            }
            GenerationStatus::Completed => {
                // Under Liked, a row counts only through an output it shows.
                if filters.liked && !row.outputs().into_iter().any(&is_liked) {
                    continue;
                }
                totals.spent_usd += usd(row);
                totals.spent_credits += credits(row);
            }
            _ => {}
        }
    }
    totals
}

/// Derives the grid from `rows`. `registry` is the registry's model ids,
/// `is_liked` reads the hearts, and `cost_usd` a row's dollar cost (an Atlas
/// estimate re-priced by the current formula).
pub(crate) fn derive(
    rows: &[Arc<ApiGeneration>],
    filters: &Filters,
    registry: &[String],
    is_liked: impl Fn(&str) -> bool,
    cost_usd: impl Fn(&ApiGeneration) -> Option<f64>,
) -> Content {
    let mut pending = Vec::new();
    let mut failed = Vec::new();
    let mut finished = Vec::new();
    let mut content = Content::default();

    for row in rows {
        let provider = row.provider();
        if is_self_hosted_video(row) {
            content.has_self_hosted_video = true;
        } else if provider == ApiProvider::Atlas {
            content.has_atlas = true;
        } else {
            let model = model_id_of(row, registry);
            if !content
                .models_present
                .iter()
                .any(|present| present == model)
            {
                content.models_present.push(model.to_string());
            }
        }
        if row.is_failed() {
            content.failed_loaded += 1;
            content.billing_failure |= row.error_kind.as_deref() == Some("billing");
        }
        if !matches(row, filters, registry) {
            continue;
        }
        match row.status {
            GenerationStatus::Pending | GenerationStatus::Processing if !filters.liked => {
                pending.push(row.clone())
            }
            GenerationStatus::Failed if !filters.liked => failed.push(row.clone()),
            GenerationStatus::Completed => finished.push(row.clone()),
            _ => {}
        }
    }

    content.totals = totals(rows, filters, registry, &is_liked, cost_usd);
    for row in &pending {
        content.items.push(Item {
            key: pending_key(row),
            row: row.clone(),
            kind: ItemKind::Pending,
        });
        content.rows.push(row.clone());
    }
    for row in &failed {
        content.items.push(Item {
            key: failed_key(row),
            row: row.clone(),
            kind: ItemKind::Failed,
        });
        content.rows.push(row.clone());
    }
    for row in &finished {
        let outputs: Vec<&str> = row
            .outputs()
            .into_iter()
            .filter(|b2_key| !filters.liked || is_liked(b2_key))
            .collect();
        if outputs.is_empty() {
            continue;
        }
        for b2_key in outputs {
            content.items.push(Item {
                key: output_key(row, b2_key),
                row: row.clone(),
                kind: ItemKind::Output {
                    b2_key: b2_key.to_string(),
                },
            });
        }
        content.rows.push(row.clone());
    }
    content.pending = pending.len();
    content.index = content
        .items
        .iter()
        .enumerate()
        .map(|(ix, item)| (item.key.clone(), ix))
        .collect();
    content
}

/// `"16:9"` → 1.777…; anything else (`"auto"`, missing) is square.
pub(crate) fn parse_aspect(ratio: Option<&str>) -> f32 {
    let parsed = ratio.and_then(|ratio| {
        let (width, height) = ratio.split_once(':')?;
        let width: f32 = width.trim().parse().ok()?;
        let height: f32 = height.trim().parse().ok()?;
        (width > 0.0 && height > 0.0).then_some(width / height)
    });
    parsed.unwrap_or(1.0)
}

/// The page size the grid starts with, and the least a later page asks for.
pub(crate) const FIRST_PAGE_ROWS: usize = 30;
/// The most one page asks for. Convex splits any page longer than twice the
/// first one in the background (the rows stay on screen while it does, at the
/// cost of reading them again), so this is kept to what a dense grid needs.
pub(crate) const MAX_PAGE_ROWS: usize = 400;

/// Rows to ask for so the next page fills about two screens (`pageRowsFor`).
///
/// A fixed 30 rows is two screens at 100 % preview size and a sliver at 25 %,
/// where a dozen narrow columns swallow a page in a few hundred pixels. Sized
/// from what the loaded rows actually laid out to — pixels of grid per row —
/// so tile shape, batch size and filters all count. Before anything is laid
/// out, the column count stands in, assuming square tiles.
pub(crate) fn page_rows_for(
    columns: usize,
    column_width: f32,
    layout_height: f32,
    loaded_rows: usize,
    screen_height: f32,
) -> usize {
    if screen_height <= 0.0 || columns == 0 {
        return FIRST_PAGE_ROWS;
    }
    let rows = if layout_height > 0.0 && loaded_rows > 0 {
        2.0 * screen_height * loaded_rows as f32 / layout_height
    } else if column_width > 0.0 {
        2.0 * columns as f32 * (screen_height / column_width).ceil()
    } else {
        return FIRST_PAGE_ROWS;
    };
    if !rows.is_finite() {
        return FIRST_PAGE_ROWS;
    }
    (rows.ceil() as usize).clamp(FIRST_PAGE_ROWS, MAX_PAGE_ROWS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, status: &str, media: &str, provider: &str, model: &str) -> Arc<ApiGeneration> {
        Arc::new(
            serde_json::from_value(serde_json::json!({
                "_id": id,
                "createdAt": 1.0,
                "prompt": "p",
                "mediaType": media,
                "status": status,
                "b2Keys": if status == "completed" { vec![format!("{id}-a.png"), format!("{id}-b.png")] } else { vec![] },
                "provider": provider,
                "apiModel": model,
                "costUsd": 0.5,
                "creditsUsed": 2.5,
                "errorKind": if status == "failed" { "billing" } else { "server" },
            }))
            .unwrap(),
        )
    }

    fn registry() -> Vec<String> {
        vec![
            "grok".into(),
            "seedream-4.5".into(),
            "hf-seedream-4.5".into(),
        ]
    }

    #[test]
    fn orders_running_then_failed_then_each_output() {
        let rows = [
            row("c1", "completed", "image", "fal", "seedream-4.5"),
            row("p1", "processing", "image", "grok", "grok"),
            row("f1", "failed", "video", "atlas", "vendor/model"),
        ];
        let content = derive(
            &rows,
            &Filters::default(),
            &registry(),
            |_| false,
            |row| row.cost_usd,
        );
        let keys: Vec<&str> = content.items.iter().map(|item| &*item.key).collect();
        assert_eq!(
            keys,
            ["pending:p1", "failed:f1", "c1:c1-a.png", "c1:c1-b.png"]
        );
        let ids: Vec<&str> = content.row_ids().collect();
        assert_eq!(ids, ["p1", "f1", "c1"]);
        assert!(content.billing_failure && content.has_atlas);
        // fal and Atlas in dollars, settled rows only; nothing pending is billed.
        assert_eq!(content.totals.spent_usd, 1.0);
        assert_eq!(content.totals.pending_usd, 0.0);
    }

    #[test]
    fn filters_by_model_media_and_liked_outputs() {
        let rows = [
            row("c1", "completed", "image", "fal", "seedream-4.5"),
            row("c2", "completed", "video", "higgsfield", "hf-seedream-4.5"),
            row("a1", "completed", "image", "atlas", "seedream-4.5"),
            row("p1", "pending", "image", "fal", "seedream-4.5"),
        ];
        let by_model = Filters {
            model: ModelFilter::Model("seedream-4.5".into()),
            ..Filters::default()
        };
        let content = derive(&rows, &by_model, &registry(), |_| false, |_| None);
        let ids: Vec<&str> = content.row_ids().collect();
        // An Atlas row whose slug happens to match a registry id is not that model.
        assert_eq!(ids, ["p1", "c1"]);

        let liked = Filters {
            liked: true,
            ..Filters::default()
        };
        let content = derive(
            &rows,
            &liked,
            &registry(),
            |key| key == "c2-b.png",
            |_| None,
        );
        let keys: Vec<&str> = content.items.iter().map(|item| &*item.key).collect();
        assert_eq!(keys, ["c2:c2-b.png"]);
        assert_eq!(content.totals.spent_credits, 2.5);

        let videos = Filters {
            media: MediaFilter::Videos,
            ..Filters::default()
        };
        assert_eq!(
            derive(&rows, &videos, &registry(), |_| false, |_| None)
                .rows
                .len(),
            1
        );
    }

    #[test]
    fn a_progress_tick_keeps_the_shape_and_a_finished_job_does_not() {
        let running = row("p1", "processing", "image", "fal", "seedream-4.5");
        let ticked = row("p1", "processing", "image", "fal", "seedream-4.5");
        let finished = row("p1", "completed", "image", "fal", "seedream-4.5");
        assert!(same_shape(
            std::slice::from_ref(&running),
            std::slice::from_ref(&ticked)
        ));
        assert!(!same_shape(
            std::slice::from_ref(&running),
            std::slice::from_ref(&finished)
        ));

        let mut content = derive(
            std::slice::from_ref(&running),
            &Filters::default(),
            &registry(),
            |_| false,
            |row| row.cost_usd,
        );
        let changed: HashMap<&str, &Arc<ApiGeneration>> = [("p1", &ticked)].into();
        content.refresh(&changed, Totals::default());
        assert!(Arc::ptr_eq(
            &content.item("pending:p1").unwrap().row,
            &ticked
        ));
        assert!(Arc::ptr_eq(&content.rows[0], &ticked));
    }

    #[test]
    fn parses_aspect_ratios() {
        assert_eq!(parse_aspect(Some("2:1")), 2.0);
        assert_eq!(parse_aspect(Some("auto")), 1.0);
        assert_eq!(parse_aspect(None), 1.0);
    }

    #[test]
    fn sizes_pages_to_about_two_screens() {
        // 30 rows filled 1000 px: two 900 px screens need 54.
        assert_eq!(page_rows_for(4, 200.0, 1000.0, 30, 900.0), 54);
        assert_eq!(page_rows_for(4, 200.0, 10.0, 30, 900.0), MAX_PAGE_ROWS);
        // Nothing laid out yet: columns × screens of square tiles.
        assert_eq!(page_rows_for(4, 200.0, 0.0, 0, 900.0), 40);
        assert_eq!(page_rows_for(0, 0.0, 0.0, 0, 900.0), FIRST_PAGE_ROWS);
    }
}
