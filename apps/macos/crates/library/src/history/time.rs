//! A card's timestamp in the local time zone: "Oct 23, 2026 at 3:07 PM", the
//! web's date-fns `MMM d, yyyy 'at' h:mm a`.
//!
//! The local offset comes from the C library (`localtime_r`), the one source
//! of the system time zone available without a date crate. Replace this with
//! `jiff` or `chrono` once the crate takes one.

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A wall-clock time, broken down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LocalTime {
    year: i32,
    /// 0 = January.
    month: usize,
    day: u32,
    hour: u32,
    minute: u32,
}

/// `millis` since the epoch, as local time; `None` where the platform has no
/// time zone to ask.
pub(crate) fn format_timestamp(millis: f64) -> Option<String> {
    local_time(millis).map(format)
}

fn format(time: LocalTime) -> String {
    let (hour, period) = match time.hour {
        0 => (12, "AM"),
        hour @ 1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        hour => (hour - 12, "PM"),
    };
    format!(
        "{} {}, {} at {}:{:02} {}",
        MONTHS[time.month.min(11)],
        time.day,
        time.year,
        hour,
        time.minute,
        period
    )
}

#[cfg(unix)]
fn local_time(millis: f64) -> Option<LocalTime> {
    use std::ffi::{c_char, c_int, c_long};

    /// `struct tm`; the same layout on macOS and glibc.
    #[repr(C)]
    struct Tm {
        _sec: c_int,
        min: c_int,
        hour: c_int,
        mday: c_int,
        mon: c_int,
        year: c_int,
        _wday: c_int,
        _yday: c_int,
        _isdst: c_int,
        _gmtoff: c_long,
        _zone: *const c_char,
    }

    unsafe extern "C" {
        /// `time_t` is a `long` on every 64-bit Unix the app builds for.
        fn localtime_r(clock: *const c_long, result: *mut Tm) -> *mut Tm;
    }

    if !millis.is_finite() {
        return None;
    }
    let seconds = (millis / 1000.0).floor() as c_long;
    let mut tm = Tm {
        _sec: 0,
        min: 0,
        hour: 0,
        mday: 0,
        mon: 0,
        year: 0,
        _wday: 0,
        _yday: 0,
        _isdst: 0,
        _gmtoff: 0,
        _zone: std::ptr::null(),
    };
    // SAFETY: both pointers are valid for the duration of the call, and
    // `localtime_r` writes only into `tm` (it is the reentrant variant).
    let result = unsafe { localtime_r(&seconds, &mut tm) };
    if result.is_null() {
        return None;
    }
    Some(LocalTime {
        year: tm.year + 1900,
        month: usize::try_from(tm.mon).ok()?,
        day: u32::try_from(tm.mday).ok()?,
        hour: u32::try_from(tm.hour).ok()?,
        minute: u32::try_from(tm.min).ok()?,
    })
}

#[cfg(not(unix))]
fn local_time(_millis: f64) -> Option<LocalTime> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(hour: u32, minute: u32) -> LocalTime {
        LocalTime {
            year: 2026,
            month: 9,
            day: 3,
            hour,
            minute,
        }
    }

    #[test]
    fn formats_like_the_web_card() {
        assert_eq!(format(at(15, 7)), "Oct 3, 2026 at 3:07 PM");
        assert_eq!(format(at(0, 0)), "Oct 3, 2026 at 12:00 AM");
        assert_eq!(format(at(12, 30)), "Oct 3, 2026 at 12:30 PM");
        assert_eq!(format(at(11, 59)), "Oct 3, 2026 at 11:59 AM");
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_local_time_zone() {
        // 2026-09-21 in UTC: September 2026 in every time zone.
        let time = local_time(1_790_000_000_000.0).expect("a local time");
        assert_eq!(time.year, 2026);
        assert!(time.month < 12 && (1..=31).contains(&time.day));
    }
}
