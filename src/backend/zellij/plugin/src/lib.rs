use std::collections::BTreeMap;
use zellij_tile::prelude::*;

/// Minimal Zellij plugin that receives pipe messages to focus a specific
/// terminal pane by ID. This works around the Zellij CLI lacking a
/// "focus-pane-by-id" action.
///
/// Usage from CLI:
///   zellij pipe --plugin file:remux-focus.wasm --name focus -- "3"
///   # Focuses terminal_3
///
/// The payload should be the numeric pane ID (e.g. "3" for terminal_3).
#[derive(Default)]
struct RemuxFocus;

register_plugin!(RemuxFocus);

impl ZellijPlugin for RemuxFocus {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        request_permission(&[
            PermissionType::ChangeApplicationState,
            PermissionType::ReadCliPipes,
        ]);
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        if let Some(payload) = &pipe_message.payload {
            if let Ok(pane_id) = payload.trim().parse::<u32>() {
                focus_terminal_pane(pane_id, false);
            }
        }
        // Unblock so the CLI pipe command returns immediately
        unblock_cli_pipe_input(&pipe_message.name);
        false
    }
}
