//! Typed declarations of the Convex functions the app calls, one module per
//! Convex module (`packages/backend/convex/<module>.ts`). Argument shapes
//! follow each function's validator; result shapes follow its source, since
//! the backend declares no `returns:` validators.

pub mod atlas;
pub mod comfy_video;
pub mod comfy_video_jobs;
pub mod enhance_recipes;
pub mod enhancements;
pub mod favorites;
pub mod feature_flags;
pub mod generations;
pub mod grok_auth;
pub mod grok_generations;
pub mod grok_processor;
pub mod higgsfield;
pub mod image_to_prompt;
pub mod pod_catalog;
pub mod pod_downloads;
pub mod pod_launch_models;
pub mod pod_submit;
pub mod progress;
pub mod prompt_enhance;
pub mod prompt_studio;
pub mod runpod_backend_actions;
pub mod runpod_backend_store;
pub mod runpod_backends;
pub mod saved_prompts;
pub mod saved_searches;
pub mod search_catalog;
pub mod self_hosted_selection;
pub mod vast_backends;
