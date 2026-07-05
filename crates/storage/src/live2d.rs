use anyhow::{Context, Result};
use api_types::{Live2dConfigRecord, Live2dStateRecord};
use chrono::Utc;
use sqlx::Row;

use crate::Storage;
use crate::util::parse_datetime;

#[derive(Debug, Clone)]
pub struct NewLive2dStateRecord {
    pub subtitle: String,
    pub subtitle_duration_ms: u64,
    pub emotion: String,
}

#[derive(Debug, Clone)]
pub struct NewLive2dConfigRecord {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

impl Storage {
    pub async fn upsert_live2d_config(
        &self,
        config: NewLive2dConfigRecord,
    ) -> Result<Live2dConfigRecord> {
        let record = Live2dConfigRecord {
            scale: config.scale,
            x: config.x,
            y: config.y,
            updated_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO live2d_config (id, scale, x, y, updated_at)
            VALUES (1, ?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                scale = excluded.scale,
                x = excluded.x,
                y = excluded.y,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(record.scale)
        .bind(record.x)
        .bind(record.y)
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert live2d config")?;

        Ok(record)
    }

    pub async fn upsert_live2d_state(
        &self,
        state: NewLive2dStateRecord,
    ) -> Result<Live2dStateRecord> {
        let config = self.get_live2d_config().await?;
        let record = Live2dStateRecord {
            subtitle: state.subtitle,
            subtitle_duration_ms: state.subtitle_duration_ms,
            emotion: state.emotion,
            config,
            updated_at: Utc::now(),
        };

        sqlx::query(
            r#"
            INSERT INTO live2d_state (id, subtitle, subtitle_duration_ms, emotion, updated_at)
            VALUES (1, ?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                subtitle = excluded.subtitle,
                subtitle_duration_ms = excluded.subtitle_duration_ms,
                emotion = excluded.emotion,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.subtitle)
        .bind(record.subtitle_duration_ms as i64)
        .bind(&record.emotion)
        .bind(record.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("failed to upsert live2d state")?;

        Ok(record)
    }

    pub async fn get_live2d_config(&self) -> Result<Live2dConfigRecord> {
        let row = sqlx::query(
            r#"
            SELECT scale, x, y, updated_at
            FROM live2d_config
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load live2d config")?;

        match row {
            Some(row) => Ok(Live2dConfigRecord {
                scale: row.get::<f64, _>("scale"),
                x: row.get::<f64, _>("x"),
                y: row.get::<f64, _>("y"),
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                self.upsert_live2d_config(NewLive2dConfigRecord {
                    scale: 0.25,
                    x: 0.3,
                    y: 0.5,
                })
                .await
            }
        }
    }

    pub async fn get_live2d_state(&self) -> Result<Live2dStateRecord> {
        let config = self.get_live2d_config().await?;
        let row = sqlx::query(
            r#"
            SELECT subtitle, subtitle_duration_ms, emotion, updated_at
            FROM live2d_state
            WHERE id = 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load live2d state")?;

        match row {
            Some(row) => Ok(Live2dStateRecord {
                subtitle: row.get::<String, _>("subtitle"),
                subtitle_duration_ms: row.get::<i64, _>("subtitle_duration_ms").max(0) as u64,
                emotion: row.get::<String, _>("emotion"),
                config,
                updated_at: parse_datetime(&row, "updated_at")?,
            }),
            None => {
                let state = self
                    .upsert_live2d_state(NewLive2dStateRecord {
                        subtitle: String::new(),
                        subtitle_duration_ms: 0,
                        emotion: "normal".into(),
                    })
                    .await?;
                Ok(Live2dStateRecord { config, ..state })
            }
        }
    }
}
