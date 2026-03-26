use std::collections::HashSet;
use std::convert::TryFrom;
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::{self, Command, Stdio};
use std::str::FromStr;
use std::sync::Mutex;
use std::thread;

use zellij_client::os_input_output::{get_cli_client_os_input, ClientOsApi};
use zellij_utils::{
    cli::{CliArgs, Command as CliCommand},
    consts::{ZELLIJ_CONFIG_DIR_ENV, ZELLIJ_CONFIG_FILE_ENV},
    data::{LayoutInfo, PaneId},
    envs,
    input::actions::Action,
    input::{cli_assets::CliAssets, config::Config},
    ipc::{ClientToServerMsg, ExitReason, ServerToClientMsg},
    pane_size::Size,
    sessions::validate_session_name,
    shared::set_permissions,
};

static OUTPUT_LOCK: Mutex<()> = Mutex::new(());

struct Args {
    session: String,
    pane_ids: Vec<String>,
    socket_dir: Option<String>,
    scrollback: Option<usize>,
    ansi: bool,
    zellij_version: Option<String>,
}

struct BootstrapArgs {
    session: String,
    zellij_binary: String,
    socket_dir: Option<String>,
    default_shell: String,
    cwd: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum BridgeCommand {
    WriteChars {
        pane_id: Option<String>,
        chars: String,
    },
    WriteBytes {
        pane_id: Option<String>,
        bytes: Vec<u8>,
    },
    Resize {
        cols: usize,
        rows: usize,
    },
}

fn main() {
    if let Err(error) = run() {
        emit_error_event(&error.to_string());
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let raw_args = env::args().skip(1).collect::<Vec<_>>();
    if raw_args
        .first()
        .is_some_and(|arg| arg == "bootstrap-session")
    {
        return run_bootstrap_session(&raw_args[1..]);
    }

    let args = parse_args(&raw_args)?;
    let os_input = get_cli_client_os_input()?;
    let mut sock_dir = resolve_socket_dir(args.socket_dir.as_deref());
    fs::create_dir_all(&sock_dir)?;
    set_permissions(&sock_dir, 0o700)?;
    sock_dir.push(&args.session);
    debug_log(&format!("connecting to {}", sock_dir.display()));
    os_input.connect_to_server(&sock_dir);
    debug_log("connected");

    let pane_ids = parse_pane_ids(&args.pane_ids)?;
    let default_command_pane_id = match pane_ids.as_slice() {
        [pane_id] => Some(pane_id.clone()),
        _ => None,
    };
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

    spawn_stdin_command_loop(os_input.box_clone(), default_command_pane_id);

    let cursor_querier = CursorQuerier::new(args.session.clone(), args.socket_dir.clone());

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
                let cursor = cursor_querier.query(&pane_id.to_string());
                let mut event = serde_json::json!({
                    "type": "pane_render",
                    "paneId": pane_id.to_string(),
                    "viewport": viewport,
                    "scrollback": scrollback,
                    "isInitial": is_initial,
                });
                if let Some(cursor) = cursor {
                    event["cursor"] = serde_json::json!({
                        "row": cursor.row,
                        "col": cursor.col,
                    });
                }
                emit_json(event)?;
            }
            Some((ServerToClientMsg::SubscribedPaneClosed { pane_id }, _)) => {
                remaining_panes.remove(&pane_id);
                emit_json(serde_json::json!({
                    "type": "pane_closed",
                    "paneId": pane_id.to_string(),
                }))?;
                if remaining_panes.is_empty() {
                    break;
                }
            }
            Some((ServerToClientMsg::RenamedSession { name }, _)) => {
                emit_json(serde_json::json!({
                    "type": "session_renamed",
                    "name": name,
                }))?;
            }
            Some((ServerToClientMsg::SwitchSession { connect_to_session }, _)) => {
                emit_json(serde_json::json!({
                    "type": "session_switch",
                    "session": connect_to_session.name,
                }))?;
            }
            Some((ServerToClientMsg::LogError { lines }, _)) => {
                return Err(lines.join("\n").into());
            }
            Some((ServerToClientMsg::Log { lines }, _)) => {
                if !lines.is_empty() {
                    eprintln!("{}", lines.join("\n"));
                }
            }
            Some((ServerToClientMsg::Exit { exit_reason }, _)) => match exit_reason {
                ExitReason::Error(message) => return Err(message.into()),
                _ => break,
            },
            None => break,
            _ => {}
        }
    }

    os_input.send_to_server(ClientToServerMsg::ClientExited);
    Ok(())
}

fn run_bootstrap_session(raw_args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_bootstrap_args(raw_args)?;
    validate_session_name(&args.session)
        .map_err(|error| format!("invalid session name '{}': {error}", args.session))?;

    if let Some(socket_dir) = args.socket_dir.as_ref() {
        env::set_var(envs::SOCKET_DIR_ENV_KEY, socket_dir);
    }
    envs::set_zellij("0".to_owned());
    envs::set_session_name(args.session.clone());

    let mut cli_args = CliArgs::default();
    apply_cli_env_overrides(&mut cli_args);
    let config = Config::try_from(&cli_args)
        .or_else(|_| Config::from_default_assets())
        .unwrap_or_default();
    config.env.set_vars();

    let mut config_options = config.options.clone();
    config_options.default_shell = Some(PathBuf::from(&args.default_shell));
    config_options.show_startup_tips = Some(false);
    config_options.show_release_notes = Some(false);
    if let Some(cwd) = args.cwd.as_ref() {
        config_options.default_cwd = Some(PathBuf::from(cwd));
    }
    cli_args.session = Some(args.session.clone());
    cli_args.command = Some(CliCommand::Options(config_options.clone()));

    let mut ipc_pipe = resolve_socket_dir(args.socket_dir.as_deref());
    fs::create_dir_all(&ipc_pipe)?;
    set_permissions(&ipc_pipe, 0o700)?;
    ipc_pipe.push(&args.session);

    spawn_zellij_server(&args.zellij_binary, &ipc_pipe, cli_args.debug)?;

    let layout = cli_args
        .layout
        .as_ref()
        .and_then(|layout| {
            LayoutInfo::from_cli(
                &config_options.layout_dir,
                &Some(layout.clone()),
                env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            )
        })
        .or_else(|| {
            LayoutInfo::from_config(&config_options.layout_dir, &config_options.default_layout)
        });

    let mut os_input = get_cli_client_os_input()?;
    os_input.update_session_name(args.session.clone());
    os_input.connect_to_server(&ipc_pipe);
    os_input.send_to_server(ClientToServerMsg::FirstClientConnected {
        cli_assets: CliAssets {
            config_file_path: Config::config_file_path(&cli_args),
            config_dir: cli_args.config_dir.clone(),
            should_ignore_config: cli_args.is_setup_clean(),
            configuration_options: cli_args.options(),
            layout,
            terminal_window_size: Size { cols: 50, rows: 50 },
            data_dir: cli_args.data_dir.clone(),
            is_debug: cli_args.debug,
            max_panes: cli_args.max_panes,
            force_run_layout_commands: false,
            cwd: args.cwd.map(PathBuf::from),
        },
        is_web_client: false,
    });

    Ok(())
}

fn spawn_zellij_server(
    zellij_binary: &str,
    socket_path: &std::path::Path,
    debug: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut command = Command::new(zellij_binary);
    command
        .arg("--server")
        .arg(socket_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if debug {
        command.arg("--debug");
    }

    let output = command.output()?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let message = if stderr.is_empty() {
            match output.status.code() {
                Some(code) => format!("zellij server exited with status {code}"),
                None => "zellij server terminated by signal".to_owned(),
            }
        } else {
            stderr
        };
        Err(message.into())
    }
}

fn apply_cli_env_overrides(cli_args: &mut CliArgs) {
    if cli_args.config.is_none() {
        if let Some(config_path) = env::var_os(ZELLIJ_CONFIG_FILE_ENV) {
            cli_args.config = Some(PathBuf::from(config_path));
        }
    }
    if cli_args.config_dir.is_none() {
        if let Some(config_dir) = env::var_os(ZELLIJ_CONFIG_DIR_ENV) {
            cli_args.config_dir = Some(PathBuf::from(config_dir));
        }
    }
}

fn spawn_stdin_command_loop(os_input: Box<dyn ClientOsApi>, default_pane_id: Option<PaneId>) {
    thread::spawn(move || {
        let mut stdin = os_input.get_stdin_reader();
        let mut line = String::new();

        loop {
            line.clear();
            match stdin.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    let result = parse_bridge_command_line(trimmed).and_then(|command| {
                        dispatch_bridge_command(&*os_input, command, default_pane_id.as_ref())
                    });
                    if let Err(error) = result {
                        emit_error_event(&error);
                    }
                }
                Err(error) => {
                    emit_error_event(&format!("bridge stdin read failed: {error}"));
                    break;
                }
            }
        }
    });
}

fn dispatch_bridge_command(
    os_input: &dyn ClientOsApi,
    command: BridgeCommand,
    default_pane_id: Option<&PaneId>,
) -> Result<(), String> {
    match command {
        BridgeCommand::WriteChars { pane_id, chars } => {
            if chars.is_empty() {
                return Ok(());
            }
            let pane_id = resolve_command_pane_id(pane_id.as_deref(), default_pane_id)?;
            os_input.send_to_server(ClientToServerMsg::Action {
                action: Action::WriteCharsToPaneId { chars, pane_id },
                terminal_id: None,
                client_id: None,
                is_cli_client: true,
            });
            Ok(())
        }
        BridgeCommand::WriteBytes { pane_id, bytes } => {
            if bytes.is_empty() {
                return Ok(());
            }
            let pane_id = resolve_command_pane_id(pane_id.as_deref(), default_pane_id)?;
            os_input.send_to_server(ClientToServerMsg::Action {
                action: Action::WriteToPaneId { bytes, pane_id },
                terminal_id: None,
                client_id: None,
                is_cli_client: true,
            });
            Ok(())
        }
        BridgeCommand::Resize { cols, rows } => {
            if cols == 0 || rows == 0 {
                return Err("bridge resize requires positive cols and rows".to_owned());
            }
            os_input.send_to_server(ClientToServerMsg::TerminalResize {
                new_size: Size { cols, rows },
            });
            Ok(())
        }
    }
}

fn resolve_command_pane_id(
    pane_id: Option<&str>,
    default_pane_id: Option<&PaneId>,
) -> Result<PaneId, String> {
    match pane_id {
        Some(pane_id) => PaneId::from_str(pane_id)
            .map_err(|error| format!("invalid command paneId '{pane_id}': {error}")),
        None => default_pane_id.cloned().ok_or_else(|| {
            "bridge command missing paneId and no default pane is available".to_owned()
        }),
    }
}

fn parse_bridge_command_line(line: &str) -> Result<BridgeCommand, String> {
    let value = serde_json::from_str::<serde_json::Value>(line)
        .map_err(|error| format!("invalid bridge command JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "bridge command must be a JSON object".to_owned())?;
    let command_type = object
        .get("type")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "bridge command missing string field 'type'".to_owned())?;

    match command_type {
        "write" | "write_chars" => {
            let chars = object
                .get("chars")
                .or_else(|| object.get("text"))
                .and_then(|value| value.as_str())
                .ok_or_else(|| "bridge write command missing string field 'chars'".to_owned())?;
            Ok(BridgeCommand::WriteChars {
                pane_id: object
                    .get("paneId")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned),
                chars: chars.to_owned(),
            })
        }
        "write_bytes" => {
            let bytes_value = object.get("bytes").ok_or_else(|| {
                "bridge write_bytes command missing array field 'bytes'".to_owned()
            })?;
            let bytes = bytes_value
                .as_array()
                .ok_or_else(|| {
                    "bridge write_bytes command field 'bytes' must be an array".to_owned()
                })?
                .iter()
                .map(|value| {
                    let number = value.as_u64().ok_or_else(|| {
                        "bridge write_bytes values must be integers in 0..=255".to_owned()
                    })?;
                    u8::try_from(number).map_err(|_| {
                        "bridge write_bytes values must be integers in 0..=255".to_owned()
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(BridgeCommand::WriteBytes {
                pane_id: object
                    .get("paneId")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned),
                bytes,
            })
        }
        "resize" | "terminal_resize" => {
            let cols = parse_positive_usize_field(object, "cols")?;
            let rows = parse_positive_usize_field(object, "rows")?;
            Ok(BridgeCommand::Resize { cols, rows })
        }
        other => Err(format!("unknown bridge command type: {other}")),
    }
}

fn parse_positive_usize_field(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<usize, String> {
    let value = object
        .get(field)
        .and_then(|value| value.as_u64())
        .ok_or_else(|| format!("bridge command missing positive integer field '{field}'"))?;
    if value == 0 {
        return Err(format!(
            "bridge command field '{field}' must be greater than zero"
        ));
    }
    usize::try_from(value).map_err(|_| format!("bridge command field '{field}' is too large"))
}

/// Cursor position for a terminal pane.
#[derive(Debug, Clone)]
struct CursorPosition {
    row: usize,
    col: usize,
}

/// Queries cursor position from `zellij list-panes --json --all` subprocess.
/// Caches the last-known cursor per pane to reduce subprocess calls.
struct CursorQuerier {
    session: String,
    socket_dir: Option<String>,
    cache: Mutex<std::collections::HashMap<String, CursorPosition>>,
}

impl CursorQuerier {
    fn new(session: String, socket_dir: Option<String>) -> Self {
        Self {
            session,
            socket_dir,
            cache: Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn query(&self, pane_id: &str) -> Option<CursorPosition> {
        let mut cmd = Command::new("zellij");
        cmd.args(["--session", &self.session, "action", "list-panes", "--json", "--all"]);
        if let Some(ref socket_dir) = self.socket_dir {
            cmd.env("ZELLIJ_SOCKET_DIR", socket_dir);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::null());

        let output = match cmd.output() {
            Ok(output) if output.status.success() => output,
            _ => {
                // Fallback to cached cursor on failure
                return self.cache.lock().ok()?.get(pane_id).cloned();
            }
        };

        let json_str = String::from_utf8_lossy(&output.stdout);
        let cursor = self.parse_cursor_from_list_panes(&json_str, pane_id);

        if let Some(ref cursor) = cursor {
            if let Ok(mut cache) = self.cache.lock() {
                cache.insert(pane_id.to_owned(), cursor.clone());
            }
        }

        cursor.or_else(|| self.cache.lock().ok()?.get(pane_id).cloned())
    }

    fn parse_cursor_from_list_panes(&self, json_str: &str, target_pane_id: &str) -> Option<CursorPosition> {
        // Extract numeric ID from "terminal_N" format
        let target_id: u32 = target_pane_id
            .strip_prefix("terminal_")
            .or(Some(target_pane_id))
            .and_then(|s| s.parse().ok())?;

        // Parse the JSON output: array of tab objects containing panes
        let tabs: Vec<serde_json::Value> = serde_json::from_str(json_str).ok()?;
        for tab in &tabs {
            let panes = tab.get("panes")?.as_array()?;
            for pane in panes {
                let id = pane.get("id")?.as_u64()?;
                if id == target_id as u64 {
                    let coords = pane.get("cursor_coordinates_in_pane")?.as_str()?;
                    return parse_cursor_coordinates(coords);
                }
            }
        }
        None
    }
}

fn parse_cursor_coordinates(coords: &str) -> Option<CursorPosition> {
    // Format: "row,col" (0-based) → convert to 1-based
    let (row_str, col_str) = coords.split_once(',')?;
    let row: usize = row_str.trim().parse().ok()?;
    let col: usize = col_str.trim().parse().ok()?;
    Some(CursorPosition {
        row: row + 1,
        col: col + 1,
    })
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

fn parse_args(raw_args: &[String]) -> Result<Args, String> {
    let mut session = None;
    let mut pane_ids = Vec::new();
    let mut socket_dir = None;
    let mut scrollback = None;
    let mut ansi = false;
    let mut zellij_version = None;

    let mut args = raw_args.iter().cloned();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--session" => {
                session = Some(next_value(&mut args, "--session")?);
            }
            "--pane-id" => {
                pane_ids.push(next_value(&mut args, "--pane-id")?);
            }
            "--socket-dir" => {
                socket_dir = Some(next_value(&mut args, "--socket-dir")?);
            }
            "--scrollback" => {
                let value = next_value(&mut args, "--scrollback")?;
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| format!("invalid --scrollback value: {value}"))?;
                scrollback = Some(parsed);
            }
            "--ansi" => {
                ansi = true;
            }
            "--zellij-version" => {
                zellij_version = Some(next_value(&mut args, "--zellij-version")?);
            }
            "--help" | "-h" => {
                print_help();
                process::exit(0);
            }
            other => {
                return Err(format!("unknown argument: {other}"));
            }
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

fn parse_bootstrap_args(raw_args: &[String]) -> Result<BootstrapArgs, String> {
    let mut session = None;
    let mut zellij_binary = "zellij".to_owned();
    let mut socket_dir = None;
    let mut default_shell = None;
    let mut cwd = None;

    let mut args = raw_args.iter().cloned();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--session" => {
                session = Some(next_value(&mut args, "--session")?);
            }
            "--zellij-binary" => {
                zellij_binary = next_value(&mut args, "--zellij-binary")?;
            }
            "--socket-dir" => {
                socket_dir = Some(next_value(&mut args, "--socket-dir")?);
            }
            "--default-shell" => {
                default_shell = Some(next_value(&mut args, "--default-shell")?);
            }
            "--cwd" => {
                cwd = Some(next_value(&mut args, "--cwd")?);
            }
            "--help" | "-h" => {
                print_bootstrap_help();
                process::exit(0);
            }
            other => {
                return Err(format!("unknown bootstrap argument: {other}"));
            }
        }
    }

    Ok(BootstrapArgs {
        session: session.ok_or_else(|| "missing required --session".to_owned())?,
        zellij_binary,
        socket_dir,
        default_shell: default_shell
            .ok_or_else(|| "missing required --default-shell".to_owned())?,
        cwd,
    })
}

fn parse_pane_ids(raw_ids: &[String]) -> Result<Vec<PaneId>, Box<dyn std::error::Error>> {
    raw_ids
        .iter()
        .map(|pane_id| PaneId::from_str(pane_id))
        .collect()
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn emit_json(value: serde_json::Value) -> io::Result<()> {
    let _guard = OUTPUT_LOCK.lock().unwrap();
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

fn print_bootstrap_help() {
    println!("Usage: zellij-bridge bootstrap-session --session NAME --default-shell PATH [--zellij-binary PATH] [--socket-dir DIR] [--cwd PATH]");
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
    use super::{
        dispatch_bridge_command, parse_bootstrap_args, parse_bridge_command_line,
        resolve_socket_dir, BridgeCommand,
    };
    use anyhow::Result;
    use std::path::Path;
    use std::str::FromStr;
    use std::sync::{Arc, Mutex};
    use zellij_client::os_input_output::ClientOsApi;
    use zellij_utils::{
        data::{Palette, PaneId},
        input::actions::Action,
        ipc::{ClientToServerMsg, ServerToClientMsg},
        pane_size::Size,
        shared::default_palette,
    };

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

    #[test]
    fn parses_write_commands() {
        assert_eq!(
            parse_bridge_command_line(
                r#"{"type":"write","chars":"echo hi","paneId":"terminal_7"}"#
            )
            .unwrap(),
            BridgeCommand::WriteChars {
                pane_id: Some("terminal_7".to_owned()),
                chars: "echo hi".to_owned(),
            }
        );

        assert_eq!(
            parse_bridge_command_line(r#"{"type":"write_chars","chars":"pwd"}"#).unwrap(),
            BridgeCommand::WriteChars {
                pane_id: None,
                chars: "pwd".to_owned(),
            }
        );

        assert_eq!(
            parse_bridge_command_line(r#"{"type":"write_chars","text":"legacy"}"#).unwrap(),
            BridgeCommand::WriteChars {
                pane_id: None,
                chars: "legacy".to_owned(),
            }
        );
    }

    #[test]
    fn parses_bootstrap_session_arguments() {
        let args = parse_bootstrap_args(&[
            "--session".to_owned(),
            "smoke".to_owned(),
            "--default-shell".to_owned(),
            "/tmp/remux-shell.sh".to_owned(),
            "--socket-dir".to_owned(),
            "/tmp/remux-zellij".to_owned(),
            "--cwd".to_owned(),
            "/tmp/work".to_owned(),
        ])
        .unwrap();

        assert_eq!(args.session, "smoke");
        assert_eq!(args.default_shell, "/tmp/remux-shell.sh");
        assert_eq!(args.socket_dir.as_deref(), Some("/tmp/remux-zellij"));
        assert_eq!(args.cwd.as_deref(), Some("/tmp/work"));
        assert_eq!(args.zellij_binary, "zellij");
    }

    #[test]
    fn bootstrap_session_arguments_require_session_and_shell() {
        assert!(parse_bootstrap_args(&[
            "--default-shell".to_owned(),
            "/tmp/remux-shell.sh".to_owned()
        ])
        .is_err());
        assert!(parse_bootstrap_args(&["--session".to_owned(), "smoke".to_owned()]).is_err());
    }

    #[test]
    fn parses_write_bytes_and_resize_commands() {
        assert_eq!(
            parse_bridge_command_line(
                r#"{"type":"write_bytes","bytes":[13,27],"paneId":"terminal_3"}"#
            )
            .unwrap(),
            BridgeCommand::WriteBytes {
                pane_id: Some("terminal_3".to_owned()),
                bytes: vec![13, 27],
            }
        );

        assert_eq!(
            parse_bridge_command_line(r#"{"type":"terminal_resize","cols":120,"rows":40}"#)
                .unwrap(),
            BridgeCommand::Resize {
                cols: 120,
                rows: 40
            }
        );

        assert_eq!(
            parse_bridge_command_line(r#"{"type":"resize","cols":90,"rows":30}"#).unwrap(),
            BridgeCommand::Resize { cols: 90, rows: 30 }
        );
    }

    #[test]
    fn rejects_malformed_bridge_commands() {
        assert!(parse_bridge_command_line("nope").is_err());
        assert!(parse_bridge_command_line(r#"{"type":"write"}"#).is_err());
        assert!(parse_bridge_command_line(r#"{"type":"write_bytes","bytes":["13"]}"#).is_err());
        assert!(parse_bridge_command_line(r#"{"type":"resize","cols":0,"rows":40}"#).is_err());
        assert!(parse_bridge_command_line(r#"{"type":"mystery"}"#).is_err());
    }

    #[test]
    fn dispatches_write_and_resize_commands_to_zellij_ipc() {
        let fake_os_input = FakeClientOsApi::default();

        dispatch_bridge_command(
            &fake_os_input,
            BridgeCommand::WriteChars {
                pane_id: None,
                chars: "ls".to_owned(),
            },
            Some(&PaneId::from_str("terminal_1").unwrap()),
        )
        .unwrap();

        dispatch_bridge_command(
            &fake_os_input,
            BridgeCommand::WriteBytes {
                pane_id: Some("terminal_2".to_owned()),
                bytes: vec![13],
            },
            None,
        )
        .unwrap();

        dispatch_bridge_command(
            &fake_os_input,
            BridgeCommand::Resize { cols: 90, rows: 30 },
            None,
        )
        .unwrap();

        assert_eq!(
            fake_os_input.take_messages(),
            vec![
                ClientToServerMsg::Action {
                    action: Action::WriteCharsToPaneId {
                        chars: "ls".to_owned(),
                        pane_id: PaneId::from_str("terminal_1").unwrap(),
                    },
                    terminal_id: None,
                    client_id: None,
                    is_cli_client: true,
                },
                ClientToServerMsg::Action {
                    action: Action::WriteToPaneId {
                        bytes: vec![13],
                        pane_id: PaneId::from_str("terminal_2").unwrap(),
                    },
                    terminal_id: None,
                    client_id: None,
                    is_cli_client: true,
                },
                ClientToServerMsg::TerminalResize {
                    new_size: Size { cols: 90, rows: 30 },
                },
            ]
        );
    }

    #[test]
    fn write_commands_require_explicit_or_default_pane_id() {
        let fake_os_input = FakeClientOsApi::default();
        let error = dispatch_bridge_command(
            &fake_os_input,
            BridgeCommand::WriteChars {
                pane_id: None,
                chars: "pwd".to_owned(),
            },
            None,
        )
        .unwrap_err();

        assert!(error.contains("paneId"));
        assert!(fake_os_input.take_messages().is_empty());
    }

    #[derive(Debug, Default, Clone)]
    struct FakeClientOsApi {
        messages: Arc<Mutex<Vec<ClientToServerMsg>>>,
    }

    impl FakeClientOsApi {
        fn take_messages(&self) -> Vec<ClientToServerMsg> {
            self.messages.lock().unwrap().clone()
        }
    }

    impl ClientOsApi for FakeClientOsApi {
        fn get_terminal_size(&self) -> Size {
            Size { cols: 80, rows: 24 }
        }

        fn set_raw_mode(&mut self) {}

        fn unset_raw_mode(&self) -> Result<(), std::io::Error> {
            Ok(())
        }

        fn get_stdout_writer(&self) -> Box<dyn std::io::Write> {
            Box::new(Vec::<u8>::new())
        }

        fn get_stdin_reader(&self) -> Box<dyn std::io::BufRead> {
            Box::new(std::io::Cursor::new(Vec::<u8>::new()))
        }

        fn update_session_name(&mut self, _new_session_name: String) {}

        fn read_from_stdin(&mut self) -> Result<Vec<u8>, &'static str> {
            Ok(Vec::new())
        }

        fn box_clone(&self) -> Box<dyn ClientOsApi> {
            Box::new(self.clone())
        }

        fn send_to_server(&self, msg: ClientToServerMsg) {
            self.messages.lock().unwrap().push(msg);
        }

        fn recv_from_server(
            &self,
        ) -> Option<(ServerToClientMsg, zellij_utils::errors::ErrorContext)> {
            None
        }

        fn handle_signals(
            &self,
            _sigwinch_cb: Box<dyn Fn()>,
            _quit_cb: Box<dyn Fn()>,
            _resize_receiver: Option<std::sync::mpsc::Receiver<()>>,
        ) {
        }

        fn connect_to_server(&self, _path: &Path) {}

        fn load_palette(&self) -> Palette {
            default_palette()
        }

        fn enable_mouse(&self) -> Result<()> {
            Ok(())
        }

        fn disable_mouse(&self) -> Result<()> {
            Ok(())
        }

        fn env_variable(&self, _name: &str) -> Option<String> {
            None
        }
    }
}
