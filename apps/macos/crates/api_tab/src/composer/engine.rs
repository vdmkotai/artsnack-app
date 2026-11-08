//! The contract with `crates/rules/js/composer.ts`: what the rules say about
//! the form, as Rust types. The form itself stays a JSON object — its shape is
//! the shared code's (`ApiFormState`), and the native side only ever reads a
//! few fields of it and hands it back.

use std::sync::Arc;

use gpui_kit::App;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A selected reference, as the rules need to know it.
#[derive(Clone, Debug, Serialize)]
pub struct RefInfo {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub aspect: f32,
    pub bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContext {
    pub refs: Vec<RefInfo>,
    pub quotes: serde_json::Map<String, Value>,
    pub hidden_providers: Vec<String>,
    pub favorites: Vec<String>,
}

/// One change to the form (`Edit` in composer.ts).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Edit {
    Field {
        field: String,
        value: Value,
    },
    Provider {
        provider: String,
    },
    Model {
        id: String,
    },
    AtlasModel {
        id: String,
    },
    AtlasParam {
        name: String,
        value: Value,
    },
    AtlasDimensions {
        name: String,
        width: u32,
        height: u32,
    },
    TencentLongEdge {
        pixels: u32,
    },
    RecordField {
        param: String,
        index: usize,
        field: String,
        value: Value,
    },
    RecordAdd {
        param: String,
    },
    RecordRemove {
        param: String,
        index: usize,
    },
    Voice {
        voice: String,
    },
    References {
        previous: Vec<String>,
        next: Vec<String>,
    },
    /// Grok 1.5: what the selected image at `index` does in the clip.
    GrokRole {
        index: usize,
        role: String,
    },
    /// Grok 1.5: a keyframe's time, in seconds.
    GrokKeyframeTime {
        index: usize,
        at: f64,
    },
    /// Grok Edit/Extend's source clip, or `None` to clear it.
    GrokSource {
        source: Option<GrokSource>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
    },
    Normalize,
}

/// `GrokSourceVideo` in packages/shared/grok-imagine.ts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GrokSource {
    pub key: String,
    pub seconds: f64,
    /// "480p" | "720p".
    pub resolution: String,
}

impl Edit {
    pub fn field(field: &str, value: impl Into<Value>) -> Self {
        Self::Field {
            field: field.to_string(),
            value: value.into(),
        }
    }

    /// The value a setter replaces, so that a run of setters of one value
    /// (a slider dragged, a number typed) is one edit: only the last counts.
    /// `None` for an edit that does something each time — a toggle, a
    /// switch of provider or model, a row added.
    pub fn target(&self) -> Option<String> {
        match self {
            Self::Field { field, .. } => Some(format!("field:{field}")),
            Self::AtlasParam { name, .. } | Self::AtlasDimensions { name, .. } => {
                Some(format!("atlas:{name}"))
            }
            Self::RecordField {
                param,
                index,
                field,
                ..
            } => Some(format!("record:{param}:{index}:{field}")),
            Self::TencentLongEdge { .. } => Some("tencent".into()),
            Self::GrokKeyframeTime { index, .. } => Some(format!("grok-keyframe:{index}")),
            Self::Provider { .. }
            | Self::Model { .. }
            | Self::AtlasModel { .. }
            | Self::RecordAdd { .. }
            | Self::RecordRemove { .. }
            | Self::Voice { .. }
            | Self::References { .. }
            | Self::GrokRole { .. }
            | Self::GrokSource { .. }
            | Self::Normalize => None,
        }
    }
}

/// Where a control's edits go.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Field {
        field: String,
    },
    AtlasParam {
        name: String,
    },
    RecordField {
        param: String,
        index: usize,
        field: String,
    },
    Voice,
}

impl Target {
    /// The edit that sets this control to `value`.
    pub fn edit(&self, value: Value) -> Edit {
        match self {
            Self::Field { field } => Edit::Field {
                field: field.clone(),
                value,
            },
            Self::AtlasParam { name } => Edit::AtlasParam {
                name: name.clone(),
                value,
            },
            Self::RecordField {
                param,
                index,
                field,
            } => Edit::RecordField {
                param: param.clone(),
                index: *index,
                field: field.clone(),
                value,
            },
            Self::Voice => Edit::Voice {
                voice: value.as_str().unwrap_or_default().to_string(),
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChoiceOption {
    pub value: Value,
    pub label: String,
    pub price: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    pub tooltip: Option<String>,
    /// Width ÷ height for a ratio tile; `None` draws a shapeless tile.
    pub aspect: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Common {
    pub key: String,
    pub label: String,
    pub hint: Option<String>,
    #[serde(default)]
    pub required: bool,
    /// Spans both columns of the field grid.
    pub wide: bool,
    /// Control under the label instead of beside it.
    pub stacked: bool,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChoiceStyle {
    Buttons,
    Select,
    Tiles,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionTier {
    pub value: String,
    pub presets: Vec<DimensionPreset>,
    /// The 1:1 size at this tier, seeding Custom when there is no size yet.
    pub seed: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DimensionPreset {
    pub value: String,
    pub ratio: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Matched {
    pub ratio: String,
    pub tier: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SizeLabel {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SizeGroup {
    pub ratio: String,
    pub aspect: f32,
    pub options: Vec<SizeOption>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SizeOption {
    pub value: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRow {
    pub title: String,
    pub removable: bool,
    pub fields: Vec<Field>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TencentView {
    pub long_edge: Option<u32>,
    pub multiplier: bool,
    pub percent: f64,
    pub safe: bool,
    pub legacy_note: Option<String>,
    pub locked_text: String,
    pub source: Option<Size>,
    pub output: Option<Size>,
    pub megapixels: Option<String>,
    pub scale: Option<f64>,
    #[serde(rename = "type")]
    pub engine: String,
    pub format: String,
    pub quality: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    Muted,
    Danger,
    Warning,
}

/// One control (`Field` in composer.ts).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Field {
    Choice {
        #[serde(flatten)]
        common: Common,
        style: ChoiceStyle,
        options: Vec<ChoiceOption>,
        value: Value,
        target: Target,
        #[serde(default)]
        uppercase: bool,
        #[serde(default)]
        capitalize: bool,
    },
    Multi {
        #[serde(flatten)]
        common: Common,
        options: Vec<ChoiceOption>,
        values: Vec<String>,
        max: usize,
        target: Target,
    },
    Switch {
        #[serde(flatten)]
        common: Common,
        checked: bool,
        on: Value,
        off: Value,
        target: Target,
    },
    #[serde(rename_all = "camelCase")]
    Number {
        #[serde(flatten)]
        common: Common,
        /// A number, or "" for unset.
        value: Value,
        min: Option<f64>,
        max: Option<f64>,
        integer: bool,
        slider: bool,
        unsettable: bool,
        target: Target,
    },
    Text {
        #[serde(flatten)]
        common: Common,
        value: String,
        multiline: bool,
        url: bool,
        target: Target,
    },
    List {
        #[serde(flatten)]
        common: Common,
        value: Vec<String>,
        url: bool,
        target: Target,
    },
    #[serde(rename_all = "camelCase")]
    Dimensions {
        #[serde(flatten)]
        common: Common,
        name: String,
        value: String,
        allow_auto: bool,
        specials: Vec<SizeLabel>,
        tiers: Vec<DimensionTier>,
        matched: Option<Matched>,
        size: Option<Size>,
        note: Option<String>,
        limits: String,
    },
    Sizes {
        #[serde(flatten)]
        common: Common,
        name: String,
        value: String,
        specials: Vec<String>,
        groups: Vec<SizeGroup>,
    },
    #[serde(rename_all = "camelCase")]
    Records {
        #[serde(flatten)]
        common: Common,
        param: String,
        attached: bool,
        rows: Vec<RecordRow>,
        can_add: bool,
        add_label: String,
    },
    Tencent {
        #[serde(flatten)]
        common: Common,
        tencent: TencentView,
    },
    /// Grok Edit/Extend's source clip.
    GrokSource {
        #[serde(flatten)]
        common: Common,
        source: Option<GrokSourceView>,
        /// "up to 8.7 s", "2–15 s".
        limit: String,
    },
    Note {
        key: String,
        text: String,
        tone: Tone,
    },
    Unsupported {
        key: String,
        names: String,
        hint: String,
    },
}

impl Field {
    pub fn key(&self) -> &str {
        match self {
            Self::Choice { common, .. }
            | Self::Multi { common, .. }
            | Self::Switch { common, .. }
            | Self::Number { common, .. }
            | Self::Text { common, .. }
            | Self::List { common, .. }
            | Self::Dimensions { common, .. }
            | Self::Sizes { common, .. }
            | Self::Records { common, .. }
            | Self::Tencent { common, .. }
            | Self::GrokSource { common, .. } => &common.key,
            Self::Note { key, .. } | Self::Unsupported { key, .. } => key,
        }
    }

    /// Whether the control spans both columns of the field grid.
    pub fn is_wide(&self) -> bool {
        match self {
            Self::Choice { common, .. }
            | Self::Multi { common, .. }
            | Self::Switch { common, .. }
            | Self::Number { common, .. }
            | Self::Text { common, .. }
            | Self::List { common, .. }
            | Self::Dimensions { common, .. }
            | Self::Sizes { common, .. }
            | Self::Records { common, .. }
            | Self::Tencent { common, .. }
            | Self::GrokSource { common, .. } => common.wide,
            Self::Note { .. } | Self::Unsupported { .. } => true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GrokSourceView {
    pub key: String,
    pub seconds: f64,
    pub resolution: String,
    /// Outside the mode's length limit: drawn as an error.
    pub outside: bool,
}

/// One selected image's role menu on Grok 1.5.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GrokRoleView {
    pub value: String,
    pub options: Vec<ChoiceOption>,
    pub keyframe: Option<KeyframeView>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct KeyframeView {
    pub at: f64,
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ProviderEntry {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RegistryModel {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasSummary {
    pub id: String,
    pub label: String,
    pub rate: String,
    pub rate_tooltip: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRow {
    pub key: String,
    pub id: String,
    pub label: String,
    pub variants: Vec<String>,
    pub vendor: String,
    pub price_text: String,
    pub price_unit: String,
    pub input_label: String,
    pub family: String,
    /// The image picker's tabs this row is on (`atlasImageModes`): "text",
    /// "image", "tool"; a model can be on two. Empty for video.
    #[serde(default)]
    pub modes: Vec<String>,
}

/// One of the image picker's tabs (`ATLAS_IMAGE_MODES`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ImageMode {
    pub id: String,
    pub label: String,
    /// The count line under the list: "64 text-to-image models".
    pub noun: String,
    pub hint: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Vendor {
    pub name: String,
    pub count: usize,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Catalog {
    pub rows: Vec<CatalogRow>,
    pub vendors: Vec<Vendor>,
    /// The image picker's tabs; none for video.
    #[serde(default)]
    pub modes: Vec<ImageMode>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModelRow {
    Registry {
        models: Vec<RegistryModel>,
        selected: String,
    },
    Video {
        label: String,
    },
    Atlas {
        model: AtlasSummary,
        starred: Vec<CatalogRow>,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PromptView {
    pub placeholder: String,
    /// Whether `@imageN` tags mean something to this model.
    pub tagging: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputMode {
    pub frames_id: String,
    pub references_id: String,
    /// "frames" | "references" | null.
    pub current: Option<String>,
    pub frames_label: String,
    pub description: String,
    pub frames_available: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ReferenceIssue {
    pub index: usize,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferencesView {
    pub heading: String,
    pub hint: String,
    /// Upload and Gallery tiles show while fewer than this are attached.
    pub attach_limit: usize,
    /// The badge of each selected reference, in selection order.
    pub slots: Vec<Option<String>>,
    pub frames: bool,
    pub input_mode: Option<InputMode>,
    pub issues: Vec<ReferenceIssue>,
    pub over_capacity: Option<String>,
    /// Grok 1.5: each selected image's role menu, in selection order.
    #[serde(default)]
    pub roles: Option<Vec<GrokRoleView>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PriceText {
    pub text: String,
    /// A Higgsfield quote is still on its way.
    pub pending: bool,
    pub tooltip: Option<String>,
    /// Covered by the SuperGrok subscription.
    pub included: bool,
}

/// Everything the composer draws (`view` in composer.ts).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerView {
    pub provider: String,
    pub media_type: String,
    /// The model the controls are drawn for: an edit made on them is dropped
    /// if it reaches a form showing another.
    pub identity: String,
    pub providers: Vec<ProviderEntry>,
    pub model_row: Option<ModelRow>,
    pub prompt: PromptView,
    pub references: Option<ReferencesView>,
    /// What a hand-off may fill (the web's `maxReferencesFor`).
    pub add_limit: usize,
    pub fields: Vec<Field>,
    pub price: PriceText,
    pub button_label: String,
    pub retired: bool,
    /// `EnhanceContext` for the prompt enhancer.
    pub enhance: Value,
    /// `StudioContext` for Prompt Studio.
    #[serde(default)]
    pub studio: Value,
    pub downsize_for_grok: bool,
}

impl ComposerView {
    pub fn is_video(&self) -> bool {
        self.media_type == "video"
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Step {
    pub form: Value,
    pub view: ComposerView,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Plan {
    pub error: Option<String>,
    /// "atlas" | "image" | "video".
    pub kind: Option<String>,
    pub args: Option<Value>,
    pub creating: Option<String>,
    /// Grok Edit/Extend send no images: the attached ones are not uploaded.
    #[serde(default, rename = "skipReferences")]
    pub skip_references: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Notice {
    /// "success" | "warning".
    pub tone: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Recreated {
    pub form: Value,
    pub notice: Notice,
}

#[derive(Clone, Debug, Deserialize)]
pub struct QuoteRequest {
    pub signature: String,
    pub args: Value,
}

/// `higgsfieldProcessor:estimateCost`'s answer. `credits` is null when
/// Higgsfield could not price the configuration (and nothing was cached).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Estimate {
    pub credits: Option<f64>,
}

/// A value shared with the worker without copying it here; it is encoded
/// there (serde's own `Arc` support is behind a feature this workspace does
/// not turn on).
pub struct Shared<T>(pub Arc<T>);

impl<T: Serialize> Serialize for Shared<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// Calls into composer.ts on its worker thread. The arguments are moved there
/// and encoded on the worker, not here.
pub fn call<A: Serialize + Send + 'static, T: serde::de::DeserializeOwned + Send + 'static>(
    cx: &App,
    function: &str,
    args: A,
) -> futures::future::BoxFuture<'static, anyhow::Result<T>> {
    artsnack_rules::composer(cx).call_owned(&format!("composer.{function}"), args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_field_and_routes_its_edit() {
        let field: Field = serde_json::from_value(serde_json::json!({
            "kind": "choice", "key": "duration", "label": "Duration", "wide": true,
            "stacked": true, "style": "buttons",
            "options": [{ "value": 5, "label": "5s", "price": "$0.40" }],
            "value": 5, "target": { "kind": "field", "field": "duration" }
        }))
        .unwrap();
        let Field::Choice {
            target, options, ..
        } = field
        else {
            panic!("not a choice")
        };
        assert_eq!(options[0].price.as_deref(), Some("$0.40"));
        let edit = serde_json::to_value(target.edit(Value::from(10))).unwrap();
        assert_eq!(
            edit,
            serde_json::json!({ "kind": "field", "field": "duration", "value": 10 })
        );
    }

    #[test]
    fn setters_of_one_value_share_a_target() {
        let param = |name: &str| Edit::AtlasParam {
            name: name.into(),
            value: Value::from(1),
        };
        let dimensions = Edit::AtlasDimensions {
            name: "size".into(),
            width: 1024,
            height: 768,
        };
        assert_eq!(param("size").target(), dimensions.target());
        assert_ne!(param("size").target(), param("seed").target());
        assert_eq!(
            Edit::Voice {
                voice: "Ara".into()
            }
            .target(),
            None
        );
        assert_eq!(Edit::Normalize.target(), None);
    }
}
