//! What RunPod's catalogue offers: which GPUs can be rented, in which cloud,
//! at what total price, and which one the form starts on.

use artsnack_backend::api::{
    runpod_backend_actions::{CloudAvailability, GpuType},
    runpod_backend_store::CloudType,
};
use gpui_kit::SharedString;

use crate::format::{grouped, plain_number, usd};

const IMAGE_GPU_PREFERENCE: &[&str] = &["NVIDIA H100 80GB HBM3"];
/// Measured 2026-10-12: the RTX PRO 6000 renders a warm 5 s 768p H3 clip in
/// 56 s against the H100's 71 s, at $2.49/h against $3.99/h.
const VIDEO_GPU_PREFERENCE: &[&str] = &[
    "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
    "NVIDIA H100 80GB HBM3",
];

pub(super) fn is_offered(availability: &CloudAvailability) -> bool {
    availability.hourly_usd.unwrap_or(0.0) > 0.0
}

/// RunPod lists every GPU type, including ones no host is selling right now
/// (no price, `UNKNOWN` stock); those can be shown but not rented.
pub(super) fn is_rentable(gpu: &GpuType) -> bool {
    is_offered(&gpu.secure) || is_offered(&gpu.community)
}

/// Whether `count` GPUs can be had; an empty list means RunPod did not say.
pub(super) fn offers_count(availability: &CloudAvailability, count: u32) -> bool {
    availability.available_gpu_counts.is_empty()
        || availability
            .available_gpu_counts
            .iter()
            .any(|available| available.round() as u32 == count)
}

pub(super) fn total_hourly_usd(availability: &CloudAvailability, count: u32) -> f64 {
    availability
        .total_hourly_usd_by_gpu_count
        .iter()
        .find(|price| price.gpu_count.round() as u32 == count)
        .map(|price| price.hourly_usd)
        .unwrap_or_else(|| availability.hourly_usd.unwrap_or(0.0) * count as f64)
}

/// "80 GB VRAM · 16,896 CUDA cores · Secure from $2.69/hr · 1×, 2× · High stock".
pub(super) fn gpu_description(gpu: &GpuType) -> String {
    let mut parts = vec![format!("{} GB VRAM", plain_number(gpu.memory_in_gb))];
    if gpu.cuda_cores > 0.0 {
        parts.push(format!("{} CUDA cores", grouped(gpu.cuda_cores)));
    }
    for cloud in [CloudType::Secure, CloudType::Community] {
        let availability = gpu.availability(cloud);
        if is_offered(availability) {
            let counts: Vec<String> = availability
                .available_gpu_counts
                .iter()
                .map(|count| format!("{}\u{d7}", count.round() as u32))
                .collect();
            parts.push(format!(
                "{} from {}/hr \u{b7} {} \u{b7} {} stock",
                cloud.label(),
                usd(availability.hourly_usd.unwrap_or(0.0)),
                counts.join(", "),
                availability.stock_status
            ));
        }
    }
    if !is_rentable(gpu) {
        parts.push("not available right now".into());
    }
    parts.join(" \u{b7} ")
}

/// Keep the chosen GPU if the fresh catalogue still lists it. Otherwise the
/// preferred one, but only when it can be rented: out-of-stock types are
/// listed with no price, and defaulting to one turned the first launch into
/// "no capacity".
pub(super) fn default_gpu_id(
    types: &[GpuType],
    current: Option<&str>,
    video: bool,
) -> Option<SharedString> {
    if let Some(current) = current
        && types.iter().any(|gpu| gpu.id == current)
    {
        return Some(current.to_string().into());
    }
    let preferred = if video {
        VIDEO_GPU_PREFERENCE
    } else {
        IMAGE_GPU_PREFERENCE
    };
    preferred
        .iter()
        .find(|id| types.iter().any(|gpu| gpu.id == **id && is_rentable(gpu)))
        .map(|id| SharedString::from(*id))
        .or_else(|| types.first().map(|gpu| gpu.id.clone().into()))
}

#[cfg(test)]
mod tests {
    use artsnack_backend::api::runpod_backend_actions::GpuCountPrice;

    use super::*;

    fn cloud(price: Option<f64>, counts: &[f64]) -> CloudAvailability {
        CloudAvailability {
            hourly_usd: price,
            stock_status: if price.is_some() { "High" } else { "UNKNOWN" }.into(),
            available_gpu_counts: counts.to_vec(),
            total_hourly_usd_by_gpu_count: counts
                .iter()
                .filter_map(|count| {
                    price.map(|price| GpuCountPrice {
                        gpu_count: *count,
                        hourly_usd: price * count,
                    })
                })
                .collect(),
        }
    }

    fn gpu(id: &str, secure: Option<f64>, community: Option<f64>) -> GpuType {
        GpuType {
            id: id.into(),
            display_name: id.into(),
            memory_in_gb: 80.0,
            cuda_cores: 16896.0,
            secure: cloud(secure, &[1.0, 2.0]),
            community: cloud(community, &[1.0]),
        }
    }

    #[test]
    fn prefers_a_rentable_preferred_gpu_and_keeps_the_current_one() {
        let types = vec![
            gpu("NVIDIA A40", Some(0.4), None),
            gpu("NVIDIA H100 80GB HBM3", None, None),
        ];
        // The H100 is preferred but sold nowhere: fall back to the first.
        assert_eq!(
            default_gpu_id(&types, None, false).as_deref(),
            Some("NVIDIA A40")
        );
        let types = vec![
            gpu("NVIDIA A40", Some(0.4), None),
            gpu("NVIDIA H100 80GB HBM3", Some(2.69), None),
        ];
        assert_eq!(
            default_gpu_id(&types, None, false).as_deref(),
            Some("NVIDIA H100 80GB HBM3")
        );
        assert_eq!(
            default_gpu_id(&types, Some("NVIDIA A40"), false).as_deref(),
            Some("NVIDIA A40")
        );
        assert_eq!(
            default_gpu_id(&types, Some("gone"), true).as_deref(),
            Some("NVIDIA H100 80GB HBM3")
        );
    }

    #[test]
    fn prices_the_chosen_count() {
        let availability = cloud(Some(2.5), &[1.0, 2.0]);
        assert_eq!(total_hourly_usd(&availability, 2), 5.0);
        // A count without its own price falls back to per-GPU × count.
        assert_eq!(total_hourly_usd(&availability, 4), 10.0);
        assert!(offers_count(&availability, 2));
        assert!(!offers_count(&availability, 8));
        assert!(offers_count(&cloud(Some(1.0), &[]), 8));
    }

    #[test]
    fn describes_what_each_cloud_sells() {
        let description = gpu_description(&gpu("H100", Some(2.69), None));
        assert_eq!(
            description,
            "80 GB VRAM \u{b7} 16,896 CUDA cores \u{b7} Secure from $2.69/hr \u{b7} 1\u{d7}, 2\u{d7} \u{b7} High stock"
        );
        assert!(gpu_description(&gpu("H100", None, None)).ends_with("not available right now"));
    }
}
