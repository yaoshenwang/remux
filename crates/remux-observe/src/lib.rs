#![forbid(unsafe_code)]

use std::str::FromStr;

use thiserror::Error;
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Json,
    Pretty,
}

impl FromStr for LogFormat {
    type Err = ObserveError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "json" => Ok(Self::Json),
            "pretty" => Ok(Self::Pretty),
            _ => Err(ObserveError::UnsupportedLogFormat(value.to_owned())),
        }
    }
}

#[derive(Debug, Error)]
pub enum ObserveError {
    #[error("unsupported log format: {0}")]
    UnsupportedLogFormat(String),
    #[error("failed to initialize tracing: {0}")]
    Init(String),
}

pub fn init_tracing(service_name: &str, format: LogFormat) -> Result<(), ObserveError> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    match format {
        LogFormat::Json => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .with_current_span(false)
            .with_span_list(false)
            .with_target(true)
            .with_span_events(FmtSpan::CLOSE)
            .with_file(true)
            .with_line_number(true)
            .with_thread_ids(true)
            .with_thread_names(true)
            .flatten_event(true)
            .try_init()
            .map_err(|error| ObserveError::Init(error.to_string()))?,
        LogFormat::Pretty => tracing_subscriber::fmt()
            .compact()
            .with_env_filter(filter)
            .with_target(true)
            .with_span_events(FmtSpan::CLOSE)
            .try_init()
            .map_err(|error| ObserveError::Init(error.to_string()))?,
    };

    tracing::info!(service = service_name, "tracing initialized");
    Ok(())
}
