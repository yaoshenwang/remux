// Adapted from yaoshenwang/remux remuxd/src/bridge.zig
// Attach client: connects to daemon, proxies stdin/stdout ↔ PTY session.
const std = @import("std");
const posix = std.posix;
const proto = @import("protocol.zig");

const c = @cImport({
    @cInclude("poll.h");
    @cInclude("signal.h");
    @cInclude("sys/ioctl.h");
    @cInclude("unistd.h");
    @cInclude("termios.h");
});

var g_winch = std.atomic.Value(bool).init(false);

pub fn attach(socket_path: []const u8, session_id: []const u8) !void {
    if (session_id.len != 36) {
        std.debug.print("remux-agent: invalid session ID (expected 36-char UUID)\n", .{});
        return error.InvalidSessionId;
    }

    // Get terminal size
    var cols: u16 = 80;
    var rows: u16 = 24;
    var ws: c.winsize = undefined;
    if (c.ioctl(c.STDOUT_FILENO, c.TIOCGWINSZ, &ws) == 0) {
        cols = ws.ws_col;
        rows = ws.ws_row;
    }

    // Connect to daemon
    const addr = std.net.Address.initUnix(socket_path) catch {
        std.debug.print("remux-agent: socket path too long\n", .{});
        return error.SocketPathTooLong;
    };
    const sock_fd = posix.socket(posix.AF.UNIX, posix.SOCK.STREAM, 0) catch {
        std.debug.print("remux-agent: cannot create socket\n", .{});
        return error.SocketCreation;
    };
    defer posix.close(sock_fd);

    posix.connect(sock_fd, &addr.any, addr.getOsSockLen()) catch {
        std.debug.print("remux-agent: cannot connect to daemon at {s}\n", .{socket_path});
        std.debug.print("remux-agent: start daemon with: remux-agent serve\n", .{});
        return error.ConnectionRefused;
    };

    // Send Init frame
    var init_buf: [40]u8 = undefined;
    const init_payload = proto.encodeInit(&init_buf, session_id, cols, rows);
    try proto.writeFrame(sock_fd, .init, init_payload);

    // Set up SIGWINCH handler
    var sa: posix.Sigaction = .{
        .handler = .{ .handler = sigwinchHandler },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.WINCH, &sa, null);

    // Set terminal to raw mode
    const stdin_fd = c.STDIN_FILENO;
    var orig_termios: c.termios = undefined;
    const has_termios = c.tcgetattr(stdin_fd, &orig_termios) == 0;
    if (has_termios) {
        var raw = orig_termios;
        const lflag_mask: @TypeOf(raw.c_lflag) =
            @as(@TypeOf(raw.c_lflag), @intCast(c.ECHO)) |
            @as(@TypeOf(raw.c_lflag), @intCast(c.ICANON)) |
            @as(@TypeOf(raw.c_lflag), @intCast(c.ISIG)) |
            @as(@TypeOf(raw.c_lflag), @intCast(c.IEXTEN));
        const iflag_mask: @TypeOf(raw.c_iflag) =
            @as(@TypeOf(raw.c_iflag), @intCast(c.IXON)) |
            @as(@TypeOf(raw.c_iflag), @intCast(c.ICRNL)) |
            @as(@TypeOf(raw.c_iflag), @intCast(c.BRKINT)) |
            @as(@TypeOf(raw.c_iflag), @intCast(c.INPCK)) |
            @as(@TypeOf(raw.c_iflag), @intCast(c.ISTRIP));
        const oflag_mask: @TypeOf(raw.c_oflag) =
            @as(@TypeOf(raw.c_oflag), @intCast(c.OPOST));
        raw.c_lflag &= ~lflag_mask;
        raw.c_iflag &= ~iflag_mask;
        raw.c_oflag &= ~oflag_mask;
        raw.c_cc[c.VMIN] = 1;
        raw.c_cc[c.VTIME] = 0;
        _ = c.tcsetattr(stdin_fd, c.TCSAFLUSH, &raw);
    }
    defer {
        if (has_termios) _ = c.tcsetattr(stdin_fd, c.TCSAFLUSH, &orig_termios);
    }

    // Spawn reader thread: daemon → stdout
    var should_exit = std.atomic.Value(bool).init(false);
    const reader = std.Thread.spawn(.{}, readerThread, .{ sock_fd, &should_exit }) catch {
        std.debug.print("remux-agent: failed to spawn reader\n", .{});
        return error.ThreadSpawn;
    };

    // Main loop: stdin → daemon
    var buf: [4096]u8 = undefined;
    while (true) {
        if (should_exit.load(.acquire)) break;

        // Check SIGWINCH
        if (g_winch.swap(false, .acq_rel)) {
            var new_ws: c.winsize = undefined;
            if (c.ioctl(c.STDOUT_FILENO, c.TIOCGWINSZ, &new_ws) == 0) {
                var resize_buf: [4]u8 = undefined;
                const resize_payload = proto.encodeResize(&resize_buf, new_ws.ws_col, new_ws.ws_row);
                proto.writeFrame(sock_fd, .resize, resize_payload) catch break;
            }
        }

        var poll_fd = [1]c.pollfd{.{
            .fd = stdin_fd,
            .events = c.POLLIN,
            .revents = 0,
        }};
        const ready = c.poll(&poll_fd, 1, 100);
        if (ready < 0) {
            if (std.posix.errno(-1) == .INTR) continue;
            break;
        }
        if (ready == 0) continue;
        if ((poll_fd[0].revents & (c.POLLERR | c.POLLHUP | c.POLLNVAL)) != 0) break;
        if ((poll_fd[0].revents & c.POLLIN) == 0) continue;

        const n = posix.read(stdin_fd, &buf) catch break;
        if (n == 0) break;
        proto.writeFrame(sock_fd, .data, buf[0..n]) catch break;
    }

    // Send detach
    proto.writeFrame(sock_fd, .detach, &.{}) catch {};
    reader.join();
}

fn readerThread(sock_fd: posix.fd_t, should_exit: *std.atomic.Value(bool)) void {
    var buf: [proto.max_payload]u8 = undefined;
    while (true) {
        const frame = proto.readFrame(sock_fd, &buf) orelse break;
        switch (frame.tag) {
            .data, .snapshot => {
                if (frame.payload.len > 0) {
                    proto.writeAll(c.STDOUT_FILENO, frame.payload) catch break;
                }
            },
            .exit => {
                should_exit.store(true, .release);
                return;
            },
            else => {},
        }
    }
    should_exit.store(true, .release);
}

fn sigwinchHandler(_: c_int) callconv(.c) void {
    g_winch.store(true, .release);
}
