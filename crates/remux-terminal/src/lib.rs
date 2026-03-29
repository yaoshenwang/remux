#![forbid(unsafe_code)]

use std::panic::{catch_unwind, AssertUnwindSafe};

use remux_core::{InspectPrecision, TerminalSize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub size: TerminalSize,
    pub formatted_state: Vec<u8>,
    pub replay_formatted: Vec<u8>,
    pub scrollback_rows: Vec<String>,
    pub visible_text: String,
    pub visible_rows: Vec<String>,
    pub byte_count: usize,
    pub precision: InspectPrecision,
}

pub struct TerminalState {
    parser: vt100::Parser,
    byte_count: usize,
    precision: InspectPrecision,
    size: TerminalSize,
    scrollback_len: usize,
}

impl TerminalState {
    #[must_use]
    pub fn new(size: TerminalSize, scrollback_len: usize) -> Self {
        Self {
            parser: vt100::Parser::new(size.rows, size.cols, scrollback_len),
            byte_count: 0,
            precision: InspectPrecision::Precise,
            size,
            scrollback_len,
        }
    }

    pub fn ingest(&mut self, bytes: &[u8]) {
        self.byte_count += bytes.len();
        if catch_unwind(AssertUnwindSafe(|| self.parser.process(bytes))).is_err() {
            self.recover_from_parser_panic("ingest");
        }
    }

    pub fn resize(&mut self, size: TerminalSize) {
        self.size = size;
        if catch_unwind(AssertUnwindSafe(|| {
            self.parser.screen_mut().set_size(size.rows, size.cols);
        }))
        .is_err()
        {
            self.recover_from_parser_panic("resize");
        }
    }

    #[must_use]
    pub fn size(&self) -> TerminalSize {
        self.size
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
    pub fn snapshot(&mut self) -> TerminalSnapshot {
        let size = self.size();
        let byte_count = self.byte_count;
        let precision = self.precision;

        match catch_unwind(AssertUnwindSafe(|| {
            let screen = self.parser.screen();
            let scrollback_rows = collect_scrollback_rows(screen, size.cols);
            let formatted_state = screen.state_formatted();

            TerminalSnapshot {
                size,
                replay_formatted: build_replay_formatted(&scrollback_rows, &formatted_state),
                formatted_state,
                scrollback_rows,
                visible_text: screen.contents(),
                visible_rows: screen.rows(0, size.cols).collect(),
                byte_count,
                precision,
            }
        })) {
            Ok(snapshot) => snapshot,
            Err(_) => {
                self.recover_from_parser_panic("snapshot");
                TerminalSnapshot {
                    size,
                    formatted_state: Vec::new(),
                    replay_formatted: Vec::new(),
                    scrollback_rows: Vec::new(),
                    visible_text: String::new(),
                    visible_rows: vec![String::new(); usize::from(size.rows)],
                    byte_count,
                    precision: self.precision,
                }
            }
        }
    }

    fn recover_from_parser_panic(&mut self, operation: &str) {
        eprintln!(
            "[remux-terminal] vt100 parser panicked during {operation}; resetting terminal state at {}x{}",
            self.size.cols, self.size.rows
        );
        self.parser = vt100::Parser::new(self.size.rows, self.size.cols, self.scrollback_len);
        self.precision = InspectPrecision::Partial;
    }
}

fn collect_scrollback_rows(screen: &vt100::Screen, width: u16) -> Vec<String> {
    let mut history = screen.clone();
    history.set_scrollback(usize::MAX);
    let total_scrollback = history.scrollback();
    let mut rows = Vec::with_capacity(total_scrollback);

    for offset in (1..=total_scrollback).rev() {
        history.set_scrollback(offset);
        rows.push(history.rows(0, width).next().unwrap_or_default());
    }

    rows
}

fn build_replay_formatted(
    scrollback_rows: &[String],
    formatted_state: &[u8],
) -> Vec<u8> {
    if scrollback_rows.is_empty() {
        return formatted_state.to_vec();
    }

    let mut replay = Vec::new();
    for row in scrollback_rows {
        replay.extend_from_slice(row.as_bytes());
        replay.extend_from_slice(b"\r\n");
    }
    replay.extend_from_slice(formatted_state);
    replay
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

    #[test]
    fn terminal_snapshot_exposes_scrollback_rows_and_replay_bytes() {
        let mut terminal = TerminalState::new(TerminalSize::new(12, 2), 100);
        terminal.ingest(b"line 1\r\nline 2\r\nline 3\r\nline 4");

        let snapshot = terminal.snapshot();
        let replay = String::from_utf8_lossy(&snapshot.replay_formatted);

        assert_eq!(snapshot.scrollback_rows, vec!["line 1".to_owned(), "line 2".to_owned()]);
        assert!(snapshot.visible_rows.iter().any(|row| row.contains("line 3")));
        assert!(snapshot.visible_rows.iter().any(|row| row.contains("line 4")));
        assert!(replay.contains("line 1"));
        assert!(replay.contains("line 2"));
        assert!(replay.contains("line 3"));
        assert!(replay.contains("line 4"));
    }

    #[test]
    fn terminal_state_recovers_from_vt100_panics_without_poisoning_runtime_state() {
        let mut terminal = TerminalState::new(TerminalSize::new(2, 1), 100);

        terminal.ingest("界界\r\n".as_bytes());
        terminal.resize(TerminalSize::new(12, 3));
        terminal.ingest(b"ok\r\nready");

        let snapshot = terminal.snapshot();
        assert_eq!(snapshot.precision, InspectPrecision::Partial);
        assert!(snapshot.visible_text.contains("ok"));
        assert!(snapshot.visible_text.contains("ready"));
        assert_eq!(snapshot.byte_count, "界界\r\nok\r\nready".len());
    }
}
