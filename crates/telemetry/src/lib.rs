use std::sync::Once;

use anyhow::{Result, anyhow};
use tracing_subscriber::{EnvFilter, fmt};

static TELEMETRY: Once = Once::new();

pub fn init() -> Result<()> {
    let mut init_result = Ok(());
    TELEMETRY.call_once(|| {
        init_result = fmt()
            .with_env_filter(EnvFilter::from_default_env())
            .with_target(false)
            .compact()
            .try_init()
            .map_err(|error| anyhow!(error.to_string()));
    });
    init_result
}
