#![forbid(unsafe_code)]

use remux_core::{InspectPrecision, TerminalSize};
use remux_terminal::TerminalState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneInspectView {
    pub precision: InspectPrecision,
    pub summary: String,
    pub preview_text: String,
    #[serde(alias = "scrollback_rows")]
    pub inspect_rows: Vec<String>,
    pub visible_rows: Vec<String>,
    pub byte_count: usize,
    pub size: TerminalSize,
}

#[must_use]
pub fn build_pane_inspect_view(terminal: &mut TerminalState) -> PaneInspectView {
    let snapshot = terminal.snapshot();
    PaneInspectView {
        precision: snapshot.precision,
        summary: format!(
            "terminal snapshot with {} bytes across {}x{}",
            snapshot.byte_count, snapshot.size.cols, snapshot.size.rows
        ),
        preview_text: snapshot.visible_text,
        inspect_rows: snapshot.scrollback_rows,
        visible_rows: snapshot.visible_rows,
        byte_count: snapshot.byte_count,
        size: snapshot.size,
    }
}

#[cfg(test)]
mod tests {
    use remux_core::{InspectPrecision, TerminalSize};
    use remux_terminal::TerminalState;

    use super::*;

    #[test]
    fn inspect_view_exposes_preview_rows_and_precision() {
        let mut terminal = TerminalState::new(TerminalSize::new(12, 3), 100);
        terminal.ingest(b"line 1\r\nbuild ok\r\nnext line\r\nlast line");
        terminal.set_precision(InspectPrecision::Partial);

        let inspect = build_pane_inspect_view(&mut terminal);
        assert_eq!(inspect.precision, InspectPrecision::Partial);
        assert!(inspect.preview_text.contains("build ok"));
        assert_eq!(inspect.inspect_rows, vec!["line 1".to_owned()]);
        assert!(inspect
            .visible_rows
            .iter()
            .any(|row| row.contains("next line")));
        assert_eq!(inspect.size, TerminalSize::new(12, 3));
        assert!(inspect.summary.contains("bytes"));
    }
}
