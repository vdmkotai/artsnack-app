//! Local calendar days and times: the date filters' From and To, and a
//! result's date in the viewer.
//!
//! The local time zone comes from the C library (`localtime_r`, `mktime`), as
//! in History's timestamps, since the workspace takes no date crate yet.

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A wall-clock time, broken down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LocalTime {
    year: i32,
    /// 1 = January.
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
}

/// `"2026-10-23"` → the first millisecond of that local day, or with `end` its
/// last (`23:59:59.999`), as the web's From and To inputs mean them.
pub fn day_bound(text: &str, end: bool) -> Option<f64> {
    let (year, month, day) = parse_day(text)?;
    let start = local_midnight(year, month, day)?;
    Some(if end {
        // The next midnight, not 24 hours on: a daylight-saving day is 23 or
        // 25 hours long.
        let (next_year, next_month, next_day) = next_day(year, month, day);
        local_midnight(next_year, next_month, next_day)? - 1.0
    } else {
        start
    })
}

/// The local day `millis` falls on, as `"YYYY-MM-DD"`.
pub fn day_text(millis: f64) -> Option<String> {
    let time = local_time(millis)?;
    Some(format!(
        "{:04}-{:02}-{:02}",
        time.year, time.month, time.day
    ))
}

/// "Oct 23, 2026 at 3:07 PM".
pub fn format_timestamp(millis: f64) -> Option<String> {
    let time = local_time(millis)?;
    let (hour, period) = match time.hour {
        0 => (12, "AM"),
        hour @ 1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        hour => (hour - 12, "PM"),
    };
    Some(format!(
        "{} {}, {} at {}:{:02} {}",
        MONTHS[(time.month.clamp(1, 12) - 1) as usize],
        time.day,
        time.year,
        hour,
        time.minute,
        period
    ))
}

fn parse_day(text: &str) -> Option<(i32, u32, u32)> {
    let mut parts = text.trim().split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) {
        return None;
    }
    (1..=days_in_month(year, month))
        .contains(&day)
        .then_some((year, month, day))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn next_day(year: i32, month: u32, day: u32) -> (i32, u32, u32) {
    if day < days_in_month(year, month) {
        (year, month, day + 1)
    } else if month < 12 {
        (year, month + 1, 1)
    } else {
        (year + 1, 1, 1)
    }
}

#[cfg(unix)]
mod ffi {
    use std::ffi::{c_char, c_int, c_long};

    /// `struct tm`; the same layout on macOS and glibc.
    #[repr(C)]
    pub struct Tm {
        pub sec: c_int,
        pub min: c_int,
        pub hour: c_int,
        pub mday: c_int,
        pub mon: c_int,
        pub year: c_int,
        pub wday: c_int,
        pub yday: c_int,
        pub isdst: c_int,
        pub gmtoff: c_long,
        pub zone: *const c_char,
    }

    impl Tm {
        pub fn zeroed() -> Self {
            Self {
                sec: 0,
                min: 0,
                hour: 0,
                mday: 0,
                mon: 0,
                year: 0,
                wday: 0,
                yday: 0,
                isdst: 0,
                gmtoff: 0,
                zone: std::ptr::null(),
            }
        }
    }

    unsafe extern "C" {
        /// `time_t` is a `long` on every 64-bit Unix the app builds for.
        pub fn localtime_r(clock: *const c_long, result: *mut Tm) -> *mut Tm;
        pub fn mktime(time: *mut Tm) -> c_long;
    }
}

#[cfg(unix)]
fn local_time(millis: f64) -> Option<LocalTime> {
    if !millis.is_finite() {
        return None;
    }
    let seconds = (millis / 1000.0).floor() as std::ffi::c_long;
    let mut tm = ffi::Tm::zeroed();
    // SAFETY: both pointers are valid for the duration of the call, and
    // `localtime_r` writes only into `tm` (it is the reentrant variant).
    let result = unsafe { ffi::localtime_r(&seconds, &mut tm) };
    if result.is_null() {
        return None;
    }
    Some(LocalTime {
        year: tm.year + 1900,
        month: u32::try_from(tm.mon + 1).ok()?,
        day: u32::try_from(tm.mday).ok()?,
        hour: u32::try_from(tm.hour).ok()?,
        minute: u32::try_from(tm.min).ok()?,
    })
}

/// Milliseconds since the epoch of local midnight on that day.
#[cfg(unix)]
fn local_midnight(year: i32, month: u32, day: u32) -> Option<f64> {
    let mut tm = ffi::Tm::zeroed();
    tm.year = year - 1900;
    tm.mon = i32::try_from(month).ok()? - 1;
    tm.mday = i32::try_from(day).ok()?;
    // Let the C library decide whether daylight saving applies that day.
    tm.isdst = -1;
    // SAFETY: `tm` is a valid, initialised `struct tm` that `mktime` may
    // normalise in place.
    let seconds = unsafe { ffi::mktime(&mut tm) };
    (seconds != -1).then_some(seconds as f64 * 1000.0)
}

#[cfg(not(unix))]
fn local_time(_millis: f64) -> Option<LocalTime> {
    None
}

#[cfg(not(unix))]
fn local_midnight(_year: i32, _month: u32, _day: u32) -> Option<f64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_real_days() {
        assert_eq!(parse_day("2026-10-23"), Some((2026, 10, 23)));
        assert_eq!(parse_day("2024-02-29"), Some((2024, 2, 29)));
        assert_eq!(parse_day("2026-02-29"), None);
        assert_eq!(parse_day("2026-13-01"), None);
        assert_eq!(parse_day("23.10.2026"), None);
        assert_eq!(parse_day(""), None);
    }

    #[test]
    fn steps_over_month_and_year_ends() {
        assert_eq!(next_day(2026, 1, 31), (2026, 2, 1));
        assert_eq!(next_day(2026, 12, 31), (2027, 1, 1));
    }

    #[cfg(unix)]
    #[test]
    fn a_day_runs_from_local_midnight_to_its_last_millisecond() {
        let start = day_bound("2026-10-23", false).expect("a local midnight");
        let end = day_bound("2026-10-23", true).expect("a local day end");
        assert!(end > start);
        assert_eq!(day_text(start).as_deref(), Some("2026-10-23"));
        assert_eq!(day_text(end).as_deref(), Some("2026-10-23"));
        assert_eq!(day_text(end + 1.0).as_deref(), Some("2026-10-24"));
    }
}
