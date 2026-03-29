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

    pub fn recover_from_poison(&mut self) {
        eprintln!(
            "[remux-terminal] terminal mutex was poisoned; resetting terminal state at {}x{}",
            self.size.cols, self.size.rows
        );
        self.parser = vt100::Parser::new(self.size.rows, self.size.cols, self.scrollback_len);
        self.precision = InspectPrecision::Partial;
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
                replay_formatted: build_replay_formatted(screen, size.cols),
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
    screen: &vt100::Screen,
    width: u16,
) -> Vec<u8> {
    let replay_rows = collect_replay_rows(screen, width);
    let mut replay = Vec::new();

    for (index, row) in replay_rows.iter().enumerate() {
        replay.extend_from_slice(row.text.as_bytes());
        if !row.wrapped && index + 1 < replay_rows.len() {
            replay.extend_from_slice(b"\r\n");
        }
    }

    replay.extend_from_slice(&screen.state_formatted());
    replay
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReplayRow {
    text: String,
    wrapped: bool,
}

fn collect_replay_rows(screen: &vt100::Screen, width: u16) -> Vec<ReplayRow> {
    let mut history = screen.clone();
    history.set_scrollback(usize::MAX);
    let total_scrollback = history.scrollback();
    let mut rows = Vec::with_capacity(total_scrollback + usize::from(screen.size().0));

    for offset in (1..=total_scrollback).rev() {
        history.set_scrollback(offset);
        rows.push(ReplayRow {
            text: history.rows(0, width).next().unwrap_or_default(),
            wrapped: history.row_wrapped(0),
        });
    }

    let visible_rows = screen.rows(0, width).collect::<Vec<_>>();
    let (cursor_row, _) = screen.cursor_position();
    let visible_limit = visible_rows
        .iter()
        .rposition(|row| !row.is_empty())
        .map_or(usize::from(cursor_row), |index| index.max(usize::from(cursor_row)));

    for (index, text) in visible_rows.into_iter().enumerate().take(visible_limit + 1) {
        rows.push(ReplayRow {
            text,
            wrapped: screen.row_wrapped(index as u16),
        });
    }

    rows
}

#[cfg(test)]
mod tests {
    use remux_core::{InspectPrecision, TerminalSize};

    use super::*;

    fn collect_all_rows(snapshot: &TerminalSnapshot) -> Vec<String> {
        snapshot
            .scrollback_rows
            .iter()
            .chain(snapshot.visible_rows.iter())
            .filter_map(|row| {
                let trimmed = row.trim_end().to_owned();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            })
            .collect()
    }

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
    fn replay_formatted_reconstructs_full_scrollback_without_dropping_middle_rows() {
        let size = TerminalSize::new(80, 30);
        let mut terminal = TerminalState::new(size, 200);
        let content = (1..=120)
            .map(|line| format!("{line}\r\n"))
            .collect::<String>();
        terminal.ingest(content.as_bytes());

        let snapshot = terminal.snapshot();
        let original_rows = collect_all_rows(&snapshot);
        let expected_rows = (1..=120).map(|line| line.to_string()).collect::<Vec<_>>();
        assert_eq!(original_rows, expected_rows);

        let mut replayed = TerminalState::new(size, 200);
        replayed.ingest(&snapshot.replay_formatted);
        let replay_snapshot = replayed.snapshot();

        assert_eq!(collect_all_rows(&replay_snapshot), expected_rows);
    }

    #[test]
    fn replay_formatted_keeps_the_latest_visible_tail_when_a_prompt_returns() {
        let size = TerminalSize::new(80, 30);
        let mut terminal = TerminalState::new(size, 200);
        let content = (1..=120)
            .map(|line| format!("MARK-{line:03}\r\n"))
            .collect::<String>();
        terminal.ingest(content.as_bytes());
        terminal.ingest(b"prompt % ");

        let snapshot = terminal.snapshot();
        let mut replayed = TerminalState::new(size, 200);
        replayed.ingest(&snapshot.replay_formatted);
        let replay_snapshot = replayed.snapshot();
        let replay_rows = collect_all_rows(&replay_snapshot);

        for expected in ["MARK-110", "MARK-111", "MARK-119", "MARK-120", "prompt %"] {
            assert!(
                replay_rows.iter().any(|row| row.contains(expected)),
                "expected replay rows to contain {expected}, got {replay_rows:?}",
            );
        }
    }

    #[test]
    fn snapshot_keeps_lf_only_output_that_returns_to_a_prompt() {
        let size = TerminalSize::new(120, 40);
        let mut terminal = TerminalState::new(size, 400);
        let content = (1..=120)
            .map(|line| format!("LF-{line:03}\n"))
            .collect::<String>();
        terminal.ingest(content.as_bytes());
        terminal.ingest(b"prompt % ");

        let snapshot = terminal.snapshot();
        let rows = collect_all_rows(&snapshot);

        for expected in ["LF-110", "LF-111", "LF-119", "LF-120", "prompt %"] {
          assert!(
              rows.iter().any(|row| row.contains(expected)),
              "expected snapshot rows to contain {expected}, got {rows:?}",
            );
        }
    }

    #[test]
    fn replay_formatted_preserves_visible_cell_colors_across_snapshot_restore() {
        let size = TerminalSize::new(32, 4);
        let mut terminal = TerminalState::new(size, 100);
        terminal.ingest(b"\x1b[31mRED\x1b[0m default\r\n\x1b[32mGREEN\x1b[0m prompt % ");

        let snapshot = terminal.snapshot();
        let original_screen = terminal.parser.screen().clone();

        let mut replayed = TerminalState::new(size, 100);
        replayed.ingest(&snapshot.replay_formatted);
        let replayed_screen = replayed.parser.screen();

        assert_eq!(
            original_screen.cell(0, 0).map(vt100::Cell::fgcolor),
            Some(vt100::Color::Idx(1)),
        );
        assert_eq!(
            replayed_screen.cell(0, 0).map(vt100::Cell::fgcolor),
            Some(vt100::Color::Idx(1)),
        );
        assert_eq!(
            original_screen.cell(1, 0).map(vt100::Cell::fgcolor),
            Some(vt100::Color::Idx(2)),
        );
        assert_eq!(
            replayed_screen.cell(1, 0).map(vt100::Cell::fgcolor),
            Some(vt100::Color::Idx(2)),
        );
    }

    #[test]
    #[ignore = "diagnostic"]
    fn debug_realistic_dual_command_prompt_tail_across_geometries() {
        let prompt = "wangyaoshen@wangyaoshendeMac-mini ~ % ";
        let mark_command = format!(
            "{prompt}for i in $(seq 1 120); do printf \"MARK-%03d\\n\" \"$i\"; sleep 0.02; done\r\n"
        );
        let probe_command = format!(
            "{prompt}for i in $(seq 1 120); do printf \"PROBE-%03d\\n\" \"$i\"; sleep 0.02; done\r\n"
        );
        let mark_output = (1..=120)
            .map(|line| format!("MARK-{line:03}\r\n"))
            .collect::<String>();
        let probe_output = (1..=120)
            .map(|line| format!("PROBE-{line:03}\r\n"))
            .collect::<String>();

        for row_count in 20..=40 {
            let size = TerminalSize::new(177, row_count);
            let mut terminal = TerminalState::new(size, 1_000);
            terminal.ingest(mark_command.as_bytes());
            terminal.ingest(mark_output.as_bytes());
            terminal.ingest(prompt.as_bytes());
            terminal.ingest(probe_command.as_bytes());
            terminal.ingest(probe_output.as_bytes());
            terminal.ingest(prompt.as_bytes());

            let snapshot = terminal.snapshot();
            let collected_rows = collect_all_rows(&snapshot);
            let mark_rows = collected_rows
                .iter()
                .filter(|row| row.contains("MARK-"))
                .cloned()
                .collect::<Vec<_>>();
            let probe_rows = collected_rows
                .iter()
                .filter(|row| row.contains("PROBE-"))
                .cloned()
                .collect::<Vec<_>>();
            let mut replayed = TerminalState::new(size, 1_000);
            replayed.ingest(&snapshot.replay_formatted);
            let replay_snapshot = replayed.snapshot();
            let replay_rows = collect_all_rows(&replay_snapshot);
            let replay_mark_rows = replay_rows
                .iter()
                .filter(|row| row.contains("MARK-"))
                .cloned()
                .collect::<Vec<_>>();
            let replay_probe_rows = replay_rows
                .iter()
                .filter(|row| row.contains("PROBE-"))
                .cloned()
                .collect::<Vec<_>>();

            eprintln!(
                "rows={} snapshot mark_tail={:?} probe_tail={:?} replay mark_tail={:?} probe_tail={:?}",
                row_count,
                mark_rows.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
                probe_rows.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
                replay_mark_rows.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
                replay_probe_rows.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
            );
        }
    }

    #[test]
    #[ignore = "diagnostic"]
    fn debug_resize_after_large_history_and_prompt() {
        let size = TerminalSize::new(177, 31);
        let prompt = "wangyaoshen@wangyaoshendeMac-mini ~ % ";
        let command = format!(
            "{prompt}for i in $(seq 1 120); do printf \"RESIZE-%03d\\n\" \"$i\"; sleep 0.02; done\r\n"
        );
        let output = (1..=120)
            .map(|line| format!("RESIZE-{line:03}\r\n"))
            .collect::<String>();

        let build_rows = |terminal: &mut TerminalState| {
            let snapshot = terminal.snapshot();
            collect_all_rows(&snapshot)
                .into_iter()
                .filter(|row| row.contains("RESIZE-"))
                .collect::<Vec<_>>()
        };

        let mut terminal = TerminalState::new(size, 1_000);
        terminal.ingest(command.as_bytes());
        terminal.ingest(output.as_bytes());
        terminal.ingest(prompt.as_bytes());

        let before = build_rows(&mut terminal);
        terminal.resize(size);
        let same_size = build_rows(&mut terminal);
        terminal.resize(TerminalSize::new(160, 31));
        terminal.resize(size);
        let resized_back = build_rows(&mut terminal);

        eprintln!(
            "before_count={} before_tail={:?} same_size_count={} same_size_tail={:?} resized_back_count={} resized_back_tail={:?}",
            before.len(),
            before
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
            same_size.len(),
            same_size
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
            resized_back.len(),
            resized_back
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
        );
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
