#![forbid(unsafe_code)]

use remux_core::{InspectPrecision, TerminalSize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub size: TerminalSize,
    pub formatted_state: Vec<u8>,
    pub visible_text: String,
    pub visible_rows: Vec<String>,
    pub byte_count: usize,
    pub precision: InspectPrecision,
}

pub struct TerminalState {
    parser: vt100::Parser,
    byte_count: usize,
    precision: InspectPrecision,
}

impl TerminalState {
    #[must_use]
    pub fn new(size: TerminalSize, scrollback_len: usize) -> Self {
        Self {
            parser: vt100::Parser::new(size.rows, size.cols, scrollback_len),
            byte_count: 0,
            precision: InspectPrecision::Precise,
        }
    }

    pub fn ingest(&mut self, bytes: &[u8]) {
        self.byte_count += bytes.len();
        self.parser.process(bytes);
    }

    pub fn resize(&mut self, size: TerminalSize) {
        self.parser.screen_mut().set_size(size.rows, size.cols);
    }

    #[must_use]
    pub fn size(&self) -> TerminalSize {
        let (rows, cols) = self.parser.screen().size();
        TerminalSize { cols, rows }
    }

    #[must_use]
    pub fn byte_count(&self) -> usize {
        self.byte_count
    }

    #[must_use]
    pub fn precision(&self) -> InspectPrecision {
        self.precision
    }

    pub fn set_precision(&mut self, precision: InspectPrecision) {
        self.precision = precision;
    }

    #[must_use]
    pub fn snapshot(&self) -> TerminalSnapshot {
        let size = self.size();
        TerminalSnapshot {
            size,
            formatted_state: self.parser.screen().state_formatted(),
            visible_text: self.parser.screen().contents(),
            visible_rows: self.parser.screen().rows(0, size.cols).collect(),
            byte_count: self.byte_count,
            precision: self.precision,
        }
    }
}

#[cfg(test)]
mod tests {
    use remux_core::{InspectPrecision, TerminalSize};

    use super::*;

    #[test]
    fn terminal_state_tracks_bytes_and_plain_text_snapshot() {
        let mut terminal = TerminalState::new(TerminalSize::new(10, 4), 100);

        terminal.ingest(b"hello");
        terminal.ingest(b"\r\nworld");

        let snapshot = terminal.snapshot();
        assert_eq!(snapshot.byte_count, 12);
        assert!(snapshot.visible_text.contains("hello"));
        assert!(snapshot.visible_text.contains("world"));
        assert!(String::from_utf8_lossy(&snapshot.formatted_state).contains("hello"));
        assert_eq!(snapshot.precision, InspectPrecision::Precise);
    }

    #[test]
    fn terminal_state_resizes_and_exposes_visible_rows() {
        let mut terminal = TerminalState::new(TerminalSize::new(5, 2), 100);
        terminal.ingest(b"abcde\r\nxyz");
        terminal.resize(TerminalSize::new(8, 3));
        terminal.set_precision(InspectPrecision::Partial);

        let snapshot = terminal.snapshot();
        assert_eq!(snapshot.size, TerminalSize::new(8, 3));
        assert_eq!(snapshot.visible_rows.len(), 3);
        assert!(snapshot
            .visible_rows
            .iter()
            .any(|row| row.contains("abcde")));
        assert_eq!(snapshot.precision, InspectPrecision::Partial);
    }
}
