use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process;
use std::str::FromStr;

use zellij_client::os_input_output::{get_cli_client_os_input, ClientOsApi};
use zellij_utils::{
    data::PaneId,
    ipc::{ClientToServerMsg, ExitReason, ServerToClientMsg},
    shared::set_permissions,
};

struct Args {
    session: String,
    pane_ids: Vec<String>,
    socket_dir: Option<String>,
    scrollback: Option<usize>,
    ansi: bool,
    zellij_version: Option<String>,
}

fn main() {
    if let Err(error) = run() {
        emit_error_event(&error.to_string());
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args()?;
    let os_input = get_cli_client_os_input()?;
    let mut sock_dir = resolve_socket_dir(args.socket_dir.as_deref());
    fs::create_dir_all(&sock_dir)?;
    set_permissions(&sock_dir, 0o700)?;
    sock_dir.push(&args.session);
    debug_log(&format!("connecting to {}", sock_dir.display()));
    os_input.connect_to_server(&sock_dir);
    debug_log("connected");

    let pane_ids = parse_pane_ids(&args.pane_ids)?;
    debug_log(&format!("subscribing to panes {:?}", args.pane_ids));
    emit_json(serde_json::json!({
        "type": "hello",
        "version": env!("CARGO_PKG_VERSION"),
        "zellijVersion": args.zellij_version
    }))?;
    debug_log("hello emitted");

    os_input.send_to_server(ClientToServerMsg::SubscribeToPaneRenders {
        pane_ids: pane_ids.clone(),
        scrollback: args.scrollback,
        ansi: args.ansi,
    });
    debug_log("subscribe sent");

    let mut remaining_panes: HashSet<PaneId> = pane_ids.into_iter().collect();
    loop {
        match os_input.recv_from_server() {
            Some((
                ServerToClientMsg::PaneRenderUpdate {
                    pane_id,
                    viewport,
                    scrollback,
                    is_initial,
                },
                _,
            )) => {
                emit_json(serde_json::json!({
                    "type": "pane_render",
                    "paneId": pane_id.to_string(),
                    "viewport": viewport,
                    "scrollback": scrollback,
                    "isInitial": is_initial,
                }))?;
            },
            Some((ServerToClientMsg::SubscribedPaneClosed { pane_id }, _)) => {
                remaining_panes.remove(&pane_id);
                emit_json(serde_json::json!({
                    "type": "pane_closed",
                    "paneId": pane_id.to_string(),
                }))?;
                if remaining_panes.is_empty() {
                    break;
                }
            },
            Some((ServerToClientMsg::LogError { lines }, _)) => {
                return Err(lines.join("\n").into());
            },
            Some((ServerToClientMsg::Log { lines }, _)) => {
                if !lines.is_empty() {
                    eprintln!("{}", lines.join("\n"));
                }
            },
            Some((ServerToClientMsg::Exit { exit_reason }, _)) => match exit_reason {
                ExitReason::Error(message) => return Err(message.into()),
                _ => break,
            },
            None => break,
            _ => {},
        }
    }

    os_input.send_to_server(ClientToServerMsg::ClientExited);
    Ok(())
}

fn resolve_socket_dir(explicit_socket_dir: Option<&str>) -> PathBuf {
    if let Some(socket_dir) = explicit_socket_dir {
        let socket_dir = PathBuf::from(socket_dir);
        if socket_dir
            .file_name()
            .is_some_and(|name| name == zellij_utils::consts::CLIENT_SERVER_CONTRACT_DIR.as_str())
        {
            socket_dir
        } else {
            socket_dir.join(zellij_utils::consts::CLIENT_SERVER_CONTRACT_DIR.as_str())
        }
    } else {
        zellij_utils::consts::ZELLIJ_SOCK_DIR.clone()
    }
}

fn parse_args() -> Result<Args, String> {
    let mut session = None;
    let mut pane_ids = Vec::new();
    let mut socket_dir = None;
    let mut scrollback = None;
    let mut ansi = false;
    let mut zellij_version = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--session" => {
                session = Some(next_value(&mut args, "--session")?);
            },
            "--pane-id" => {
                pane_ids.push(next_value(&mut args, "--pane-id")?);
            },
            "--socket-dir" => {
                socket_dir = Some(next_value(&mut args, "--socket-dir")?);
            },
            "--scrollback" => {
                let value = next_value(&mut args, "--scrollback")?;
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| format!("invalid --scrollback value: {value}"))?;
                scrollback = Some(parsed);
            },
            "--ansi" => {
                ansi = true;
            },
            "--zellij-version" => {
                zellij_version = Some(next_value(&mut args, "--zellij-version")?);
            },
            "--help" | "-h" => {
                print_help();
                process::exit(0);
            },
            other => {
                return Err(format!("unknown argument: {other}"));
            },
        }
    }

    let session = session.ok_or_else(|| "missing required --session".to_owned())?;
    if pane_ids.is_empty() {
        return Err("missing required --pane-id".to_owned());
    }

    Ok(Args {
        session,
        pane_ids,
        socket_dir,
        scrollback,
        ansi,
        zellij_version,
    })
}

fn parse_pane_ids(raw_ids: &[String]) -> Result<Vec<PaneId>, Box<dyn std::error::Error>> {
    raw_ids
        .iter()
        .map(|pane_id| PaneId::from_str(pane_id))
        .collect()
}

fn next_value(
    args: &mut impl Iterator<Item = String>,
    flag: &str,
) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn emit_json(value: serde_json::Value) -> io::Result<()> {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    serde_json::to_writer(&mut stdout, &value)?;
    writeln!(stdout)?;
    stdout.flush()
}

fn emit_error_event(message: &str) {
    let _ = emit_json(serde_json::json!({
        "type": "error",
        "message": message,
    }));
}

fn print_help() {
    println!("Usage: zellij-bridge --session NAME --pane-id terminal_0 [--pane-id terminal_1] [--socket-dir DIR] [--scrollback N] [--ansi] [--zellij-version VERSION]");
}

fn debug_log(message: &str) {
    if bridge_debug_enabled() {
        eprintln!("[zellij-bridge-debug] {message}");
    }
}

fn bridge_debug_enabled() -> bool {
    env::var("REMUX_ZELLIJ_BRIDGE_DEBUG")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::resolve_socket_dir;

    #[test]
    fn resolve_socket_dir_appends_contract_version_to_base_socket_dir() {
        let path = resolve_socket_dir(Some("/tmp/remux-zellij"));
        assert_eq!(
            path.to_string_lossy(),
            "/tmp/remux-zellij/contract_version_1"
        );
    }

    #[test]
    fn resolve_socket_dir_keeps_explicit_contract_directory() {
        let path = resolve_socket_dir(Some("/tmp/remux-zellij/contract_version_1"));
        assert_eq!(
            path.to_string_lossy(),
            "/tmp/remux-zellij/contract_version_1"
        );
    }
}
