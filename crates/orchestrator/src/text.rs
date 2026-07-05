use serde_json::Value;

pub(crate) fn summarize_text(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max_chars) {
        out.push(ch);
    }
    if text.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

pub(crate) fn compact_json(value: &Value, max_chars: usize) -> String {
    let rendered = serde_json::to_string(value).unwrap_or_else(|_| "<invalid-json>".into());
    summarize_text(&rendered, max_chars)
}

pub(crate) fn truncate_for_log(text: &str, max_chars: usize) -> String {
    summarize_text(&text.replace('\n', " "), max_chars)
}

pub(crate) fn limit_chars(text: &str, max_chars: usize) -> String {
    summarize_text(text.trim(), max_chars)
}
