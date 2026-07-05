use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

pub(crate) fn parse_uuid(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Uuid> {
    let raw = row.get::<String, _>(column);
    Uuid::parse_str(&raw).with_context(|| format!("invalid uuid in column {column}: {raw}"))
}

pub(crate) fn parse_datetime(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<DateTime<Utc>> {
    let raw = row.get::<String, _>(column);
    DateTime::parse_from_rfc3339(&raw)
        .map(|value| value.with_timezone(&Utc))
        .with_context(|| format!("invalid timestamp in column {column}: {raw}"))
}

pub(crate) fn parse_optional_datetime(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<Option<DateTime<Utc>>> {
    match row.get::<Option<String>, _>(column) {
        Some(raw) => DateTime::parse_from_rfc3339(&raw)
            .map(|value| Some(value.with_timezone(&Utc)))
            .with_context(|| format!("invalid timestamp in column {column}: {raw}")),
        None => Ok(None),
    }
}

pub(crate) fn parse_json(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Value> {
    let raw = row.get::<String, _>(column);
    serde_json::from_str(&raw).with_context(|| format!("invalid json payload in column {column}"))
}
