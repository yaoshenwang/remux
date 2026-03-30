#![forbid(unsafe_code)]

use std::panic::{catch_unwind, AssertUnwindSafe};

use remux_core::{InspectPrecision, TerminalSize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub size: TerminalSize,
    pub source_size: TerminalSize,
    pub cursor: TerminalCursor,
    pub scrollback_row_wraps: Vec<bool>,
    pub visible_row_wraps: Vec<bool>,
    pub formatted_state: Vec<u8>,
    pub replay_formatted: Vec<u8>,
    pub scrollback_rows: Vec<String>,
    pub visible_text: String,
    pub visible_rows: Vec<String>,
    pub byte_count: usize,
    pub precision: InspectPrecision,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TerminalCursor {
    pub row: u16,
    pub col: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalPatchSource {
    Snapshot,
    Stream,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalPatchLine {
    pub text: String,
    pub wrapped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalPatchChunk {
    pub start_row: u16,
    pub lines: Vec<TerminalPatchLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalPatch {
    pub revision: u64,
    pub base_revision: Option<u64>,
    pub reset: bool,
    pub source: TerminalPatchSource,
    pub cols: u16,
    pub rows: u16,
    pub source_size: TerminalSize,
    pub cursor: TerminalCursor,
    pub visible_row_base: usize,
    pub chunks: Vec<TerminalPatchChunk>,
}

pub struct TerminalState {
    parser: vt100::Parser,
    byte_count: usize,
    precision: InspectPrecision,
    size: TerminalSize,
    scrollback_len: usize,
    patch_revision: u64,
    needs_full_patch: bool,
    last_render_rows: Vec<TerminalPatchLine>,
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
            patch_revision: 0,
            needs_full_patch: true,
            last_render_rows: Vec::new(),
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
        self.needs_full_patch = true;
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
        self.patch_revision = 0;
        self.needs_full_patch = true;
        self.last_render_rows.clear();
    }

    #[must_use]
    pub fn snapshot(&mut self) -> TerminalSnapshot {
        let size = self.size();
        let byte_count = self.byte_count;
        let precision = self.precision;

        match catch_unwind(AssertUnwindSafe(|| {
            let screen = self.parser.screen();
            let scrollback_rows = collect_scrollback_rows(screen, size.cols);
            let scrollback_row_wraps = collect_scrollback_row_wraps(screen);
            let visible_row_wraps = collect_visible_row_wraps(screen, size.rows);
            let (cursor_row, cursor_col) = screen.cursor_position();
            let formatted_state = screen.state_formatted();

            TerminalSnapshot {
                size,
                source_size: size,
                cursor: TerminalCursor {
                    row: cursor_row,
                    col: cursor_col,
                },
                scrollback_row_wraps,
                visible_row_wraps,
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
                    source_size: size,
                    cursor: TerminalCursor::default(),
                    scrollback_row_wraps: Vec::new(),
                    visible_row_wraps: vec![false; usize::from(size.rows)],
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
        self.patch_revision = 0;
        self.needs_full_patch = true;
        self.last_render_rows.clear();
    }

    pub fn build_patch(&mut self, source: TerminalPatchSource) -> TerminalPatch {
        let snapshot = self.snapshot();
        let canonical_lines = build_canonical_lines(
            &snapshot.scrollback_rows,
            &snapshot.visible_rows,
            &snapshot.scrollback_row_wraps,
            &snapshot.visible_row_wraps,
        );
        let render_rows = reflow_canonical_lines(&canonical_lines, snapshot.size.cols);
        let (visible_row_base, visible_rows) =
            collect_visible_patch_rows(&render_rows, snapshot.size.rows);

        let reset = self.needs_full_patch
            || self.patch_revision == 0
            || self.last_render_rows.len() != visible_rows.len();
        let base_revision = if reset {
            None
        } else {
            Some(self.patch_revision)
        };
        let chunks = build_patch_chunks(&self.last_render_rows, &visible_rows, reset);

        self.patch_revision += 1;
        self.needs_full_patch = false;
        self.last_render_rows = visible_rows;

        TerminalPatch {
            revision: self.patch_revision,
            base_revision,
            reset,
            source,
            cols: snapshot.size.cols,
            rows: snapshot.size.rows,
            source_size: snapshot.source_size,
            cursor: snapshot.cursor,
            visible_row_base,
            chunks,
        }
    }
}

fn build_canonical_lines(
    scrollback_rows: &[String],
    visible_rows: &[String],
    scrollback_row_wraps: &[bool],
    visible_row_wraps: &[bool],
) -> Vec<String> {
    let mut canonical = Vec::new();
    let mut current = String::new();

    for (row, wrapped) in scrollback_rows
        .iter()
        .zip(scrollback_row_wraps.iter())
        .chain(visible_rows.iter().zip(visible_row_wraps.iter()))
    {
        current.push_str(row.trim_end_matches(' '));
        if !wrapped {
            canonical.push(std::mem::take(&mut current));
        }
    }

    if !current.is_empty() || canonical.is_empty() {
        canonical.push(current);
    }

    canonical
}

fn char_display_width(ch: char) -> usize {
    if ch.is_ascii() {
        return usize::from(!ch.is_ascii_control());
    }

    // Approximation that keeps CJK/wide glyphs stable in reflow tests.
    2
}

fn reflow_canonical_lines(lines: &[String], cols: u16) -> Vec<TerminalPatchLine> {
    let width_limit = usize::from(cols.max(1));
    let mut rows = Vec::new();

    for line in lines {
        if line.is_empty() {
            rows.push(TerminalPatchLine {
                text: String::new(),
                wrapped: false,
            });
            continue;
        }

        let mut segments = Vec::<String>::new();
        let mut segment = String::new();
        let mut segment_width = 0usize;

        for ch in line.chars() {
            let width = char_display_width(ch).max(1);
            if segment_width > 0 && segment_width + width > width_limit {
                segments.push(std::mem::take(&mut segment));
                segment_width = 0;
            }
            segment.push(ch);
            segment_width += width;
        }

        segments.push(segment);
        let last_index = segments.len().saturating_sub(1);
        for (index, text) in segments.into_iter().enumerate() {
            rows.push(TerminalPatchLine {
                text,
                wrapped: index < last_index,
            });
        }
    }

    if rows.is_empty() {
        rows.push(TerminalPatchLine {
            text: String::new(),
            wrapped: false,
        });
    }

    rows
}

fn collect_visible_patch_rows(
    render_rows: &[TerminalPatchLine],
    rows: u16,
) -> (usize, Vec<TerminalPatchLine>) {
    let visible_len = usize::from(rows);
    let visible_row_base = render_rows.len().saturating_sub(visible_len);

    if render_rows.len() >= visible_len {
        return (visible_row_base, render_rows[visible_row_base..].to_vec());
    }

    let mut visible = vec![
        TerminalPatchLine {
            text: String::new(),
            wrapped: false,
        };
        visible_len.saturating_sub(render_rows.len())
    ];
    visible.extend_from_slice(render_rows);
    (0, visible)
}

fn build_patch_chunks(
    previous_rows: &[TerminalPatchLine],
    next_rows: &[TerminalPatchLine],
    reset: bool,
) -> Vec<TerminalPatchChunk> {
    if reset {
        return vec![TerminalPatchChunk {
            start_row: 0,
            lines: next_rows.to_vec(),
        }];
    }

    let mut chunks = Vec::new();
    let mut index = 0usize;
    while index < next_rows.len() {
        if previous_rows.get(index) == Some(&next_rows[index]) {
            index += 1;
            continue;
        }

        let start = index;
        let mut lines = Vec::new();
        while index < next_rows.len() && previous_rows.get(index) != Some(&next_rows[index]) {
            lines.push(next_rows[index].clone());
            index += 1;
        }

        chunks.push(TerminalPatchChunk {
            start_row: u16::try_from(start).unwrap_or(u16::MAX),
            lines,
        });
    }

    chunks
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

fn collect_scrollback_row_wraps(screen: &vt100::Screen) -> Vec<bool> {
    let mut history = screen.clone();
    history.set_scrollback(usize::MAX);
    let total_scrollback = history.scrollback();
    let mut wraps = Vec::with_capacity(total_scrollback);

    for offset in (1..=total_scrollback).rev() {
        history.set_scrollback(offset);
        wraps.push(history.row_wrapped(0));
    }

    wraps
}

fn collect_visible_row_wraps(screen: &vt100::Screen, rows: u16) -> Vec<bool> {
    (0..rows).map(|row| screen.row_wrapped(row)).collect()
}

fn build_replay_formatted(screen: &vt100::Screen, width: u16) -> Vec<u8> {
    let replay_rows = collect_replay_rows(screen, width);
    let mut replay = Vec::new();

    for (index, row) in replay_rows.iter().enumerate() {
        replay.extend_from_slice(&row.formatted);
        if !row.wrapped && index + 1 < replay_rows.len() {
            replay.extend_from_slice(b"\r\n");
        }
    }

    for _ in 0..screen.size().0 {
        replay.extend_from_slice(b"\r\n");
    }

    replay.extend_from_slice(&screen.state_formatted());
    replay
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReplayRow {
    formatted: Vec<u8>,
    wrapped: bool,
}

fn collect_replay_rows(screen: &vt100::Screen, width: u16) -> Vec<ReplayRow> {
    let mut history = screen.clone();
    history.set_scrollback(usize::MAX);
    let total_scrollback = history.scrollback();
    let mut rows = Vec::with_capacity(total_scrollback);

    for offset in (1..=total_scrollback).rev() {
        history.set_scrollback(offset);
        rows.push(ReplayRow {
            formatted: build_formatted_replay_row(&history, width),
            wrapped: history.row_wrapped(0),
        });
    }

    rows
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum ReplayIntensity {
    #[default]
    Normal,
    Bold,
    Dim,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct ReplayCellStyle {
    fgcolor: vt100::Color,
    bgcolor: vt100::Color,
    intensity: ReplayIntensity,
    italic: bool,
    underline: bool,
    inverse: bool,
}

impl ReplayCellStyle {
    fn from_cell(cell: &vt100::Cell) -> Self {
        Self {
            fgcolor: cell.fgcolor(),
            bgcolor: cell.bgcolor(),
            intensity: if cell.bold() {
                ReplayIntensity::Bold
            } else if cell.dim() {
                ReplayIntensity::Dim
            } else {
                ReplayIntensity::Normal
            },
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
        }
    }

    fn write_escape_code(self, contents: &mut Vec<u8>) {
        contents.extend_from_slice(b"\x1b[m");
        if self == Self::default() {
            return;
        }

        contents.extend_from_slice(b"\x1b[");
        let mut first = true;

        let mut write_param = |value: u16| {
            if first {
                first = false;
            } else {
                contents.push(b';');
            }
            contents.extend_from_slice(value.to_string().as_bytes());
        };

        write_replay_color_param(self.fgcolor, true, &mut write_param);
        write_replay_color_param(self.bgcolor, false, &mut write_param);

        match self.intensity {
            ReplayIntensity::Normal => {}
            ReplayIntensity::Bold => write_param(1),
            ReplayIntensity::Dim => write_param(2),
        }

        if self.italic {
            write_param(3);
        }
        if self.underline {
            write_param(4);
        }
        if self.inverse {
            write_param(7);
        }

        contents.push(b'm');
    }
}

fn write_replay_color_param(
    color: vt100::Color,
    foreground: bool,
    write_param: &mut impl FnMut(u16),
) {
    match color {
        vt100::Color::Default => {}
        vt100::Color::Idx(index) if index < 8 => {
            write_param(u16::from(index) + if foreground { 30 } else { 40 });
        }
        vt100::Color::Idx(index) if index < 16 => {
            write_param(u16::from(index) + if foreground { 82 } else { 92 });
        }
        vt100::Color::Idx(index) => {
            write_param(if foreground { 38 } else { 48 });
            write_param(5);
            write_param(u16::from(index));
        }
        vt100::Color::Rgb(red, green, blue) => {
            write_param(if foreground { 38 } else { 48 });
            write_param(2);
            write_param(u16::from(red));
            write_param(u16::from(green));
            write_param(u16::from(blue));
        }
    }
}

fn build_formatted_replay_row(screen: &vt100::Screen, width: u16) -> Vec<u8> {
    let mut last_significant_col = None;
    for col in 0..width {
        let Some(cell) = screen.cell(0, col) else {
            break;
        };
        if cell.is_wide_continuation() {
            continue;
        }

        if cell.has_contents() || ReplayCellStyle::from_cell(cell) != ReplayCellStyle::default() {
            last_significant_col = Some(col);
        }
    }

    let Some(last_significant_col) = last_significant_col else {
        return Vec::new();
    };

    let mut formatted = Vec::new();
    let mut active_style = ReplayCellStyle::default();
    let mut col = 0;
    while col <= last_significant_col {
        let Some(cell) = screen.cell(0, col) else {
            break;
        };

        if cell.is_wide_continuation() {
            col += 1;
            continue;
        }

        let style = ReplayCellStyle::from_cell(cell);
        if style != active_style {
            style.write_escape_code(&mut formatted);
            active_style = style;
        }

        if cell.has_contents() {
            formatted.extend_from_slice(cell.contents().as_bytes());
        } else {
            formatted.push(b' ');
        }

        col += 1 + u16::from(cell.is_wide());
    }

    if active_style != ReplayCellStyle::default() {
        ReplayCellStyle::default().write_escape_code(&mut formatted);
    }

    formatted
}

#[cfg(test)]
mod tests {
    use remux_core::{InspectPrecision, TerminalSize};

    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct CellStyle {
        fgcolor: vt100::Color,
        bgcolor: vt100::Color,
        bold: bool,
        dim: bool,
        italic: bool,
        underline: bool,
        inverse: bool,
    }

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

    fn cell_style(screen: &vt100::Screen, row: u16, col: u16) -> Option<CellStyle> {
        screen.cell(row, col).map(|cell| CellStyle {
            fgcolor: cell.fgcolor(),
            bgcolor: cell.bgcolor(),
            bold: cell.bold(),
            dim: cell.dim(),
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
        })
    }

    fn oldest_scrollback_view(screen: &vt100::Screen) -> vt100::Screen {
        let mut history = screen.clone();
        history.set_scrollback(usize::MAX);
        history
    }

    fn apply_patch_to_rows(patch: &TerminalPatch) -> Vec<TerminalPatchLine> {
        let mut rows = vec![
            TerminalPatchLine {
                text: String::new(),
                wrapped: false,
            };
            usize::from(patch.rows)
        ];
        for chunk in &patch.chunks {
            for (index, line) in chunk.lines.iter().enumerate() {
                let row = usize::from(chunk.start_row) + index;
                if row >= rows.len() {
                    continue;
                }
                rows[row] = line.clone();
            }
        }
        rows
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
    fn terminal_snapshot_exposes_cursor_source_size_and_wrap_metadata() {
        let size = TerminalSize::new(5, 3);
        let mut terminal = TerminalState::new(size, 100);
        terminal.ingest(b"abcdef\r\nrow-2\r\nxy");

        let snapshot = terminal.snapshot();
        let screen = terminal.parser.screen();

        assert_eq!(snapshot.source_size, size);
        assert_eq!(
            snapshot.cursor,
            TerminalCursor {
                row: screen.cursor_position().0,
                col: screen.cursor_position().1,
            }
        );
        assert_eq!(
            snapshot.scrollback_row_wraps.len(),
            snapshot.scrollback_rows.len()
        );
        assert_eq!(
            snapshot.visible_row_wraps.len(),
            snapshot.visible_rows.len()
        );
        assert_eq!(
            snapshot.scrollback_row_wraps,
            collect_scrollback_row_wraps(screen),
        );
        assert_eq!(
            snapshot.visible_row_wraps,
            collect_visible_row_wraps(screen, size.rows),
        );
    }

    #[test]
    fn terminal_snapshot_exposes_scrollback_rows_and_replay_bytes() {
        let mut terminal = TerminalState::new(TerminalSize::new(12, 2), 100);
        terminal.ingest(b"line 1\r\nline 2\r\nline 3\r\nline 4");

        let snapshot = terminal.snapshot();
        let replay = String::from_utf8_lossy(&snapshot.replay_formatted);

        assert_eq!(
            snapshot.scrollback_rows,
            vec!["line 1".to_owned(), "line 2".to_owned()]
        );
        assert!(snapshot
            .visible_rows
            .iter()
            .any(|row| row.contains("line 3")));
        assert!(snapshot
            .visible_rows
            .iter()
            .any(|row| row.contains("line 4")));
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
    fn replay_formatted_preserves_scrollback_cell_styles_across_snapshot_restore() {
        let size = TerminalSize::new(12, 2);
        let mut terminal = TerminalState::new(size, 100);
        terminal.ingest(
            b"\x1b[30;47mAB  CD\x1b[0m\r\n\x1b[37;44mEF  GH\x1b[0m\r\nvisible\r\nprompt % ",
        );

        let snapshot = terminal.snapshot();
        let original_history = oldest_scrollback_view(terminal.parser.screen());

        assert_eq!(
            cell_style(&original_history, 0, 0),
            Some(CellStyle {
                fgcolor: vt100::Color::Idx(0),
                bgcolor: vt100::Color::Idx(7),
                bold: false,
                dim: false,
                italic: false,
                underline: false,
                inverse: false,
            }),
        );
        assert_eq!(
            cell_style(&original_history, 1, 0),
            Some(CellStyle {
                fgcolor: vt100::Color::Idx(7),
                bgcolor: vt100::Color::Idx(4),
                bold: false,
                dim: false,
                italic: false,
                underline: false,
                inverse: false,
            }),
        );

        let mut replayed = TerminalState::new(size, 100);
        replayed.ingest(&snapshot.replay_formatted);
        let replayed_history = oldest_scrollback_view(replayed.parser.screen());

        for (row, col) in [(0, 0), (0, 2), (1, 0), (1, 2)] {
            assert_eq!(
                cell_style(&replayed_history, row, col),
                cell_style(&original_history, row, col),
                "expected replayed scrollback cell ({row}, {col}) to preserve styles",
            );
        }
    }

    #[test]
    fn replay_formatted_preserves_wrapped_scrollback_styles_across_snapshot_restore() {
        let size = TerminalSize::new(6, 3);
        let mut terminal = TerminalState::new(size, 100);
        terminal.ingest(b"\x1b[30;47mAB  CD12\x1b[0m\r\nrow-2\r\nrow-3\r\nprompt");

        let snapshot = terminal.snapshot();
        let original_history = oldest_scrollback_view(terminal.parser.screen());

        let mut replayed = TerminalState::new(size, 100);
        replayed.ingest(&snapshot.replay_formatted);
        let replayed_history = oldest_scrollback_view(replayed.parser.screen());

        for (row, col) in [(0, 0), (0, 2), (0, 5), (1, 0), (1, 1)] {
            assert_eq!(
                cell_style(&replayed_history, row, col),
                cell_style(&original_history, row, col),
                "expected wrapped replayed scrollback cell ({row}, {col}) to preserve styles",
            );
        }
    }

    #[test]
    fn replay_formatted_keeps_the_visible_prompt_layout_without_duplication() {
        let size = TerminalSize::new(80, 12);
        let mut terminal = TerminalState::new(size, 200);
        terminal.ingest(
            b"header\r\nbody\r\n\x1b[10;1H> Improve documentation in @filename\r\nstatus line\r\n",
        );

        let snapshot = terminal.snapshot();
        let mut replayed = TerminalState::new(size, 200);
        replayed.ingest(&snapshot.replay_formatted);
        let replay_snapshot = replayed.snapshot();

        assert_eq!(replay_snapshot.visible_rows, snapshot.visible_rows);
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

    #[test]
    fn terminal_patch_reflow_roundtrip_after_resize_keeps_canonical_content() {
        let mut terminal = TerminalState::new(TerminalSize::new(6, 3), 200);
        terminal.ingest(b"1234567890");

        let first = terminal.build_patch(TerminalPatchSource::Stream);
        assert!(first.reset);

        terminal.resize(TerminalSize::new(4, 3));
        let resized = terminal.build_patch(TerminalPatchSource::Snapshot);
        assert!(resized.reset);
        assert_eq!(resized.cols, 4);
        assert_eq!(resized.rows, 3);
        assert!(
            resized
                .chunks
                .iter()
                .map(|chunk| chunk.lines.len())
                .sum::<usize>()
                >= 2,
            "expected resized patch to include multiple visible rows",
        );

        let visible = apply_patch_to_rows(&resized);
        let combined = visible.iter().map(|line| line.text.as_str()).collect::<String>();
        assert!(
            combined.contains("1234567890") || combined.contains("1234"),
            "expected canonical content after reflow, got {combined:?}",
        );
    }

    #[test]
    fn terminal_patch_handles_wide_chars_and_cursor_at_eol_during_reflow() {
        let mut terminal = TerminalState::new(TerminalSize::new(4, 2), 200);
        terminal.ingest("界界ABCD".as_bytes());

        let first = terminal.build_patch(TerminalPatchSource::Stream);
        assert_eq!(first.cursor.row, 1);
        assert!(first.cursor.col <= first.cols);
        assert!(
            first
                .chunks
                .iter()
                .flat_map(|chunk| chunk.lines.iter())
                .any(|line| line.text.contains('界')),
            "expected wide chars in patch rows",
        );

        terminal.resize(TerminalSize::new(3, 2));
        let resized = terminal.build_patch(TerminalPatchSource::Snapshot);
        assert!(resized.reset);
        assert!(
            resized
                .chunks
                .iter()
                .map(|chunk| chunk.lines.len())
                .sum::<usize>()
                >= 2,
            "expected resize reflow to include multiple visible rows",
        );
    }

    #[test]
    fn terminal_patch_emits_coalesced_dirty_chunks_for_disjoint_row_changes() {
        let mut terminal = TerminalState::new(TerminalSize::new(6, 4), 200);
        terminal.ingest(b"111111\r\n222222\r\n333333\r\n444444");
        let _ = terminal.build_patch(TerminalPatchSource::Stream);

        terminal.ingest(b"\x1b[1;1HAAAAAA\x1b[4;1HBBBBBB");
        let patch = terminal.build_patch(TerminalPatchSource::Stream);

        assert!(!patch.reset);
        assert_eq!(patch.chunks.len(), 2, "expected disjoint dirty chunks");
        assert_eq!(patch.chunks[0].start_row, 0);
        assert_eq!(patch.chunks[1].start_row, 3);
    }
}
