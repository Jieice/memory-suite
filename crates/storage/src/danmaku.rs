use anyhow::{Context, Result};
use api_types::{
    DanmakuBootstrapRecord, DanmakuConnectionStateRecord, DanmakuHostRecord,
    DanmakuSourceConfigRecord,
};
use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::Storage;
use crate::util::{parse_datetime, parse_optional_datetime};

#[derive(Debug, Clone)]
pub struct NewDanmakuSourceConfigRecord {
    pub room_id: String,
    pub uid: u64,
    pub buvid: String,
    pub cookie: Option<String>,
    pub signature_mode: String,
}

#[derive(Debug, Clone)]
pub struct DanmakuSourceSecretRecord {
    pub room_id: String,
    pub uid: u64,
    pub buvid: String,
    pub cookie: Option<String>,
    pub signature_mode: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewDanmakuConnectionStateRecord {
    pub status: String,
    pub attempt_count: u32,
    pub consecutive_failures: u32,
    pub retry_delay_ms: u32,
    pub session_id: Option<String>,
    pub current_upstream_host: Option<String>,
    pub last_connect_attempt_at: Option<DateTime<Utc>>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub last_close_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewDanmakuBootstrapRecord {
    pub requested_room_id: String,
    pub resolved_room_id: String,
    pub live_status: u32,
    pub token: String,
    pub upstream_hosts: Vec<DanmakuHostRecord>,
    pub selected_upstream_host: Option<String>,
}

impl Storage {
    pub async fn upsert_danmaku_source_config(
        &self,
        source: NewDanmakuSourceConfigRecord,
    ) -> Result<DanmakuSourceConfigRecord> {
        let record = DanmakuSourceConfigRecord {
            room_id: source.room_id,
            uid: source.uid,
            buvid: source.buvid,
            has_cookie: source
                .cookie
                .as_deref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
            signature_mode: source.signature_mode,
            updated_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO danmaku_source_config (
                id, room_id, uid, buvid, cookie, signature_mode, updated_at
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                room_id = excluded.room_id,
                uid = excluded.uid,
                buvid = excluded.buvid,
                cookie = excluded.cookie,
                signature_mode = excluded.signature_mode,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.room_id)
        .bind(record.uid as i64)
        .bind(&record.buvid)
        .bind(source.cookie)
        .bind(&record.signature_mode)
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert danmaku source config")?;

        Ok(record)
    }

    pub async fn get_danmaku_source_config(&self) -> Result<DanmakuSourceConfigRecord> {
        let row = sqlx::query(
            r#"
            SELECT room_id, uid, buvid, cookie, signature_mode, updated_at
            FROM danmaku_source_config
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load danmaku source config")?;

        match row {
            Some(row) => Ok(DanmakuSourceConfigRecord {
                room_id: row.get::<String, _>("room_id"),
                uid: row.get::<i64, _>("uid").max(0) as u64,
                buvid: row.get::<String, _>("buvid"),
                has_cookie: row
                    .get::<Option<String>, _>("cookie")
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false),
                signature_mode: row.get::<String, _>("signature_mode"),
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                self.upsert_danmaku_source_config(NewDanmakuSourceConfigRecord {
                    room_id: String::new(),
                    uid: 0,
                    buvid: String::new(),
                    cookie: None,
                    signature_mode: "cookie".into(),
                })
                .await
            }
        }
    }

    pub async fn get_danmaku_source_secret(&self) -> Result<DanmakuSourceSecretRecord> {
        let row = sqlx::query(
            r#"
            SELECT room_id, uid, buvid, cookie, signature_mode, updated_at
            FROM danmaku_source_config
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load danmaku source secret config")?;

        match row {
            Some(row) => Ok(DanmakuSourceSecretRecord {
                room_id: row.get::<String, _>("room_id"),
                uid: row.get::<i64, _>("uid").max(0) as u64,
                buvid: row.get::<String, _>("buvid"),
                cookie: row.get::<Option<String>, _>("cookie"),
                signature_mode: row.get::<String, _>("signature_mode"),
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                self.upsert_danmaku_source_config(NewDanmakuSourceConfigRecord {
                    room_id: String::new(),
                    uid: 0,
                    buvid: String::new(),
                    cookie: None,
                    signature_mode: "cookie".into(),
                })
                .await?;
                Ok(DanmakuSourceSecretRecord {
                    room_id: String::new(),
                    uid: 0,
                    buvid: String::new(),
                    cookie: None,
                    signature_mode: "cookie".into(),
                    updated_at: Utc::now(),
                })
            }
        }
    }

    pub async fn upsert_danmaku_connection_state(
        &self,
        state: NewDanmakuConnectionStateRecord,
    ) -> Result<DanmakuConnectionStateRecord> {
        let record = DanmakuConnectionStateRecord {
            status: state.status,
            attempt_count: state.attempt_count,
            consecutive_failures: state.consecutive_failures,
            retry_delay_ms: state.retry_delay_ms,
            session_id: state.session_id,
            current_upstream_host: state.current_upstream_host,
            last_connect_attempt_at: state.last_connect_attempt_at,
            last_heartbeat_at: state.last_heartbeat_at,
            next_retry_at: state.next_retry_at,
            last_error: state.last_error,
            last_close_reason: state.last_close_reason,
            updated_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO danmaku_connection_state (
                id, status, attempt_count, session_id, current_upstream_host, last_connect_attempt_at,
                last_heartbeat_at, next_retry_at, last_error, last_close_reason,
                consecutive_failures, retry_delay_ms, updated_at
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                attempt_count = excluded.attempt_count,
                session_id = excluded.session_id,
                current_upstream_host = excluded.current_upstream_host,
                last_connect_attempt_at = excluded.last_connect_attempt_at,
                last_heartbeat_at = excluded.last_heartbeat_at,
                next_retry_at = excluded.next_retry_at,
                last_error = excluded.last_error,
                last_close_reason = excluded.last_close_reason,
                consecutive_failures = excluded.consecutive_failures,
                retry_delay_ms = excluded.retry_delay_ms,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.status)
        .bind(record.attempt_count as i64)
        .bind(&record.session_id)
        .bind(&record.current_upstream_host)
        .bind(record.last_connect_attempt_at.map(|value| value.to_rfc3339()))
        .bind(record.last_heartbeat_at.map(|value| value.to_rfc3339()))
        .bind(record.next_retry_at.map(|value| value.to_rfc3339()))
        .bind(&record.last_error)
        .bind(&record.last_close_reason)
        .bind(record.consecutive_failures as i64)
        .bind(record.retry_delay_ms as i64)
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert danmaku connection state")?;

        Ok(record)
    }

    pub async fn get_danmaku_connection_state(&self) -> Result<DanmakuConnectionStateRecord> {
        let row = sqlx::query(
            r#"
            SELECT
                status,
                attempt_count,
                consecutive_failures,
                retry_delay_ms,
                session_id,
                current_upstream_host,
                last_connect_attempt_at,
                last_heartbeat_at,
                next_retry_at,
                last_error,
                last_close_reason,
                updated_at
            FROM danmaku_connection_state
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load danmaku connection state")?;

        match row {
            Some(row) => Ok(DanmakuConnectionStateRecord {
                status: row.get::<String, _>("status"),
                attempt_count: row.get::<i64, _>("attempt_count").max(0) as u32,
                consecutive_failures: row.get::<i64, _>("consecutive_failures").max(0) as u32,
                retry_delay_ms: row.get::<i64, _>("retry_delay_ms").max(0) as u32,
                session_id: row.get::<Option<String>, _>("session_id"),
                current_upstream_host: row.get::<Option<String>, _>("current_upstream_host"),
                last_connect_attempt_at: parse_optional_datetime(&row, "last_connect_attempt_at")?,
                last_heartbeat_at: parse_optional_datetime(&row, "last_heartbeat_at")?,
                next_retry_at: parse_optional_datetime(&row, "next_retry_at")?,
                last_error: row.get::<Option<String>, _>("last_error"),
                last_close_reason: row.get::<Option<String>, _>("last_close_reason"),
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                self.upsert_danmaku_connection_state(NewDanmakuConnectionStateRecord {
                    status: "disconnected".into(),
                    attempt_count: 0,
                    consecutive_failures: 0,
                    retry_delay_ms: 0,
                    session_id: None,
                    current_upstream_host: None,
                    last_connect_attempt_at: None,
                    last_heartbeat_at: None,
                    next_retry_at: None,
                    last_error: None,
                    last_close_reason: None,
                })
                .await
            }
        }
    }

    pub async fn upsert_danmaku_bootstrap(
        &self,
        bootstrap: NewDanmakuBootstrapRecord,
    ) -> Result<DanmakuBootstrapRecord> {
        let record = DanmakuBootstrapRecord {
            requested_room_id: bootstrap.requested_room_id,
            resolved_room_id: bootstrap.resolved_room_id,
            live_status: bootstrap.live_status,
            token_ready: !bootstrap.token.trim().is_empty(),
            token: bootstrap.token.clone(),
            selected_upstream_host: bootstrap.selected_upstream_host,
            upstream_hosts: bootstrap.upstream_hosts,
            fetched_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO danmaku_bootstrap_snapshot (
                id, requested_room_id, resolved_room_id, live_status, token, upstream_hosts,
                selected_upstream_host, fetched_at
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                requested_room_id = excluded.requested_room_id,
                resolved_room_id = excluded.resolved_room_id,
                live_status = excluded.live_status,
                token = excluded.token,
                upstream_hosts = excluded.upstream_hosts,
                selected_upstream_host = excluded.selected_upstream_host,
                fetched_at = excluded.fetched_at
            "#,
        )
        .bind(&record.requested_room_id)
        .bind(&record.resolved_room_id)
        .bind(record.live_status as i64)
        .bind(&bootstrap.token)
        .bind(serde_json::to_string(&record.upstream_hosts).context("serialize danmaku hosts")?)
        .bind(&record.selected_upstream_host)
        .bind(record.fetched_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert danmaku bootstrap snapshot")?;

        Ok(record)
    }

    pub async fn get_danmaku_bootstrap(&self) -> Result<Option<DanmakuBootstrapRecord>> {
        let row = sqlx::query(
            r#"
            SELECT
                requested_room_id,
                resolved_room_id,
                live_status,
                token,
                upstream_hosts,
                selected_upstream_host,
                fetched_at
            FROM danmaku_bootstrap_snapshot
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load danmaku bootstrap snapshot")?;

        row.map(|row| {
            Ok(DanmakuBootstrapRecord {
                requested_room_id: row.get::<String, _>("requested_room_id"),
                resolved_room_id: row.get::<String, _>("resolved_room_id"),
                live_status: row.get::<i64, _>("live_status").max(0) as u32,
                token_ready: !row.get::<String, _>("token").trim().is_empty(),
                token: row.get::<String, _>("token"),
                upstream_hosts: serde_json::from_str(&row.get::<String, _>("upstream_hosts"))
                    .context("parse danmaku upstream hosts")?,
                selected_upstream_host: row.get::<Option<String>, _>("selected_upstream_host"),
                fetched_at: parse_datetime(&row, "fetched_at")?,
            })
        })
        .transpose()
    }
}
