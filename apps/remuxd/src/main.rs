use std::error::Error;
use std::str::FromStr;

use clap::Parser;
use remux_observe::{init_tracing, LogFormat};
use remux_server::{serve, ServerConfig, ServerConfigOverrides};

#[derive(Debug, Parser)]
#[command(name = "remuxd", about = "Remux Runtime V2 development server")]
struct Cli {
    #[arg(long, env = "REMUXD_HOST")]
    host: Option<String>,
    #[arg(long, env = "REMUXD_PORT")]
    port: Option<u16>,
    #[arg(long, env = "REMUXD_PUBLIC_BASE_URL")]
    public_base_url: Option<String>,
    #[arg(long, env = "REMUXD_LOG_FORMAT", default_value = "json")]
    log_format: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let log_format = LogFormat::from_str(&cli.log_format)?;
    init_tracing("remuxd", log_format)?;

    let config = ServerConfig::from_process_env(ServerConfigOverrides {
        host: cli.host,
        port: cli.port,
        public_base_url: cli.public_base_url,
    })?;

    tracing::info!(?config, "starting remuxd");
    serve(config).await?;
    Ok(())
}
