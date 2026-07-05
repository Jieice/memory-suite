use anyhow::{Context, Result};
use sqlx::SqlitePool;

use crate::Storage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeCounts {
    pub messages: i64,
    pub user_profiles: i64,
    pub memory_entries: i64,
    pub config_artifacts: i64,
}

impl Storage {
    pub async fn runtime_counts(&self) -> Result<RuntimeCounts> {
        Ok(RuntimeCounts {
            messages: count_table(&self.pool, "messages").await?,
            user_profiles: count_table(&self.pool, "user_profiles").await?,
            memory_entries: count_table(&self.pool, "memory_entries").await?,
            config_artifacts: count_table(&self.pool, "config_artifacts").await?,
        })
    }
}

pub(super) async fn count_table(pool: &SqlitePool, table: &str) -> Result<i64> {
    let sql = format!("SELECT COUNT(*) as count FROM {table}");
    sqlx::query_scalar::<_, i64>(&sql)
        .fetch_one(pool)
        .await
        .with_context(|| format!("failed to count rows in {table}"))
}
