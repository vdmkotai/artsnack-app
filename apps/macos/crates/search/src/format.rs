//! Counts as the web writes them (`toLocaleString` in English): `12,345`.

pub fn thousands(count: usize) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// "1 generation" / "3 generations".
pub fn plural(count: usize, one: &str, many: &str) -> String {
    format!(
        "{} {}",
        thousands(count),
        if count == 1 { one } else { many }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_thousands() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(1_234_567), "1,234,567");
        assert_eq!(plural(1, "generation", "generations"), "1 generation");
        assert_eq!(plural(20_000, "result", "results"), "20,000 results");
    }
}
