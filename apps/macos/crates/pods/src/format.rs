//! Money and size as the backend panels show them, matching the web's
//! formatting so the same pod reads the same in both apps.

/// `$0.437` below a dollar, `$2.69` above.
pub(crate) fn usd(value: f64) -> String {
    if value < 1.0 {
        format!("${value:.3}")
    } else {
        format!("${value:.2}")
    }
}

/// A whole number with thousands separators: `16,896`.
pub(crate) fn grouped(value: f64) -> String {
    let rounded = value.round();
    let digits = format!("{}", rounded.abs() as u64);
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if rounded < 0.0 {
        out.push('-');
    }
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A disk speed: `2,140 MB/s`.
pub(crate) fn mb_per_second(value: f64) -> String {
    format!("{} MB/s", grouped(value))
}

/// A whole number for a form field, or a short decimal when it has one.
pub(crate) fn plain_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        let text = format!("{value:.2}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_keep_a_tenth_of_a_cent_below_a_dollar() {
        assert_eq!(usd(0.4371), "$0.437");
        assert_eq!(usd(2.694), "$2.69");
        assert_eq!(usd(10.0), "$10.00");
    }

    #[test]
    fn groups_thousands() {
        assert_eq!(grouped(16896.0), "16,896");
        assert_eq!(grouped(999.4), "999");
        assert_eq!(grouped(1_000_000.0), "1,000,000");
        assert_eq!(mb_per_second(2140.2), "2,140 MB/s");
    }

    #[test]
    fn plain_numbers_drop_trailing_zeros() {
        assert_eq!(plain_number(300.0), "300");
        assert_eq!(plain_number(9.5), "9.5");
        assert_eq!(plain_number(10.25), "10.25");
    }
}
