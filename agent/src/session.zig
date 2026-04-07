// Adapted from yaoshenwang/remux remuxd/src/session.zig
const builtin = @import("builtin");
const std = @import("std");
const posix = std.posix;
const Allocator = std.mem.Allocator;
const proto = @import("protocol.zig");

const c = @cImport({
    if (builtin.os.tag == .linux) {
        @cInclude("pty.h");
    } else {
        @cInclude("util.h");
    }
    @cInclude("sys/ioctl.h");
    @cInclude("signal.h");
    @cInclude("sys/wait.h");
    @cInclude("stdlib.h");
    @cInclude("unistd.h");
});

/// Ring buffer for recent PTY output (scrollback snapshot on reattach).
const scrollback_capacity = 256 * 1024; // 256KB

pub const Session = struct {
    id: [36]u8, // UUID string
    pty_fd: c_int,
    pid: c_int,
    cols: u16,
    rows: u16,
    alive: std.atomic.Value(bool),
    reader_thread: ?std.Thread = null,
    alloc: Allocator,

    // Scrollback ring buffer for snapshot on reattach
    scrollback: [scrollback_capacity]u8 = undefined,
    scroll_write: usize = 0,
    scroll_len: usize = 0,
    scroll_mutex: std.Thread.Mutex = .{},

    // Currently attached client fd (-1 = none)
    client_fd: std.atomic.Value(i32) = std.atomic.Value(i32).init(-1),

    pub fn spawn(alloc: Allocator, id: [36]u8, cols_val: u16, rows_val: u16) !*Session {
        var master_fd: c_int = undefined;
        var ws: c.winsize = .{
            .ws_col = cols_val,
            .ws_row = rows_val,
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };
        const pid = c.forkpty(&master_fd, null, null, &ws);
        if (pid < 0) return error.ForkFailed;

        if (pid == 0) {
            // Child: exec shell
            _ = c.setenv("TERM", "xterm-ghostty", 1);
            _ = c.setenv("REMUX_SESSION", "1", 1);
            const shell: [*c]const u8 = if (c.getenv("SHELL")) |s| s else "/bin/zsh";
            var argv_arr = [_:null]?[*:0]const u8{shell};
            _ = c.execvp(shell, @ptrCast(&argv_arr));
            c._exit(1);
        }

        const sess = try alloc.create(Session);
        sess.* = Session{
            .id = id,
            .pty_fd = master_fd,
            .pid = pid,
            .cols = cols_val,
            .rows = rows_val,
            .alive = std.atomic.Value(bool).init(true),
            .alloc = alloc,
        };
        return sess;
    }

    /// Append data to the scrollback ring buffer.
    pub fn appendScrollback(self: *Session, data: []const u8) void {
        self.scroll_mutex.lock();
        defer self.scroll_mutex.unlock();
        for (data) |byte| {
            self.scrollback[self.scroll_write] = byte;
            self.scroll_write = (self.scroll_write + 1) % scrollback_capacity;
            if (self.scroll_len < scrollback_capacity) {
                self.scroll_len += 1;
            }
        }
    }

    /// Get current scrollback contents (linearized). Caller must free.
    pub fn getScrollback(self: *Session, alloc: Allocator) ![]u8 {
        self.scroll_mutex.lock();
        defer self.scroll_mutex.unlock();
        if (self.scroll_len == 0) return try alloc.alloc(u8, 0);
        const buf = try alloc.alloc(u8, self.scroll_len);
        if (self.scroll_len < scrollback_capacity) {
            // Buffer hasn't wrapped
            @memcpy(buf, self.scrollback[0..self.scroll_len]);
        } else {
            // Wrapped: read from scroll_write to end, then 0 to scroll_write
            const start = self.scroll_write;
            const first_len = scrollback_capacity - start;
            @memcpy(buf[0..first_len], self.scrollback[start..scrollback_capacity]);
            @memcpy(buf[first_len..], self.scrollback[0..start]);
        }
        return buf;
    }

    pub fn resize(self: *Session, cols_val: u16, rows_val: u16) void {
        self.cols = cols_val;
        self.rows = rows_val;
        var ws: c.winsize = .{
            .ws_col = cols_val,
            .ws_row = rows_val,
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };
        _ = c.ioctl(self.pty_fd, c.TIOCSWINSZ, &ws);
    }

    pub fn writeInput(self: *Session, data: []const u8) !void {
        try proto.writeAll(@intCast(self.pty_fd), data);
    }

    pub fn isAlive(self: *Session) bool {
        return self.alive.load(.acquire);
    }

    pub fn kill(self: *Session) void {
        self.alive.store(false, .release);
        _ = c.kill(self.pid, c.SIGTERM);
        _ = c.close(self.pty_fd);
        if (self.reader_thread) |t| t.join();
        _ = c.waitpid(self.pid, null, 0);
    }

    pub fn destroy(self: *Session) void {
        self.kill();
        self.alloc.destroy(self);
    }
};

/// Manages all active PTY sessions, keyed by UUID string.
pub const SessionManager = struct {
    sessions: std.StringHashMap(*Session),
    alloc: Allocator,

    pub fn init(alloc: Allocator) SessionManager {
        return .{
            .sessions = std.StringHashMap(*Session).init(alloc),
            .alloc = alloc,
        };
    }

    pub fn deinit(self: *SessionManager) void {
        var it = self.sessions.valueIterator();
        while (it.next()) |sp| sp.*.destroy();
        self.sessions.deinit();
    }

    pub fn getOrCreate(self: *SessionManager, id: [36]u8, cols: u16, rows: u16) !*Session {
        if (self.sessions.get(&id)) |s| {
            if (!s.isAlive()) {
                self.remove(&id);
            } else {
                // Existing session — resize to new client size
                s.resize(cols, rows);
                return s;
            }
        }
        // Create new session
        const sess = try Session.spawn(self.alloc, id, cols, rows);
        const key = try self.alloc.dupe(u8, &id);
        try self.sessions.put(key, sess);
        return sess;
    }

    pub fn get(self: *SessionManager, id: []const u8) ?*Session {
        return self.sessions.get(id);
    }

    pub fn remove(self: *SessionManager, id: []const u8) void {
        if (self.sessions.fetchRemove(id)) |kv| {
            kv.value.destroy();
            self.alloc.free(kv.key);
        }
    }

    /// Return JSON-encoded list of sessions. Caller must free.
    pub fn listJson(self: *SessionManager) ![]u8 {
        var buf: std.ArrayListAligned(u8, null) = .{};
        var w = buf.writer(self.alloc);
        try w.writeAll("[");
        var first = true;
        var it = self.sessions.iterator();
        while (it.next()) |entry| {
            if (!first) try w.writeAll(",");
            first = false;
            const s = entry.value_ptr.*;
            try w.print("{{\"id\":\"{s}\",\"alive\":{},\"cols\":{d},\"rows\":{d}}}", .{
                s.id,
                s.isAlive(),
                s.cols,
                s.rows,
            });
        }
        try w.writeAll("]");
        return try buf.toOwnedSlice(self.alloc);
    }

    /// Remove dead sessions.
    pub fn reapDead(self: *SessionManager) void {
        var to_remove: std.ArrayList([]const u8) = .empty;
        defer to_remove.deinit(self.alloc);
        var it = self.sessions.iterator();
        while (it.next()) |entry| {
            if (!entry.value_ptr.*.isAlive()) {
                to_remove.append(self.alloc, entry.key_ptr.*) catch continue;
            }
        }
        for (to_remove.items) |key| self.remove(key);
    }
};
