const std = @import("std");
const posix = std.posix;
const daemon = @import("daemon.zig");
const client = @import("client.zig");
const proto = @import("protocol.zig");

const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("stdlib.h");
});

const version = "0.1.0";

fn defaultSocketPath(buf: []u8) []const u8 {
    const home = std.posix.getenv("HOME") orelse "/tmp";
    return std.fmt.bufPrint(buf, "{s}/.remux/agent.sock", .{home}) catch "/tmp/remux-agent.sock";
}

fn ensureDir(path: []const u8) void {
    const dir = std.fs.path.dirname(path) orelse return;
    std.fs.makeDirAbsolute(dir) catch {};
}

pub fn main() !void {
    var gpa: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const alloc = gpa.allocator();

    var args = try std.process.argsWithAllocator(alloc);
    defer args.deinit();
    _ = args.skip(); // skip binary name

    const subcmd = args.next() orelse {
        printUsage();
        return;
    };

    // Socket path (overrideable via env)
    var path_buf: [256]u8 = undefined;
    const socket_path = std.posix.getenv("REMUX_AGENT_SOCKET") orelse
        defaultSocketPath(&path_buf);

    if (std.mem.eql(u8, subcmd, "version")) {
        var buf: [64]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "remux-agent {s}\n", .{version}) catch return;
        _ = posix.write(1, msg) catch {};
    } else if (std.mem.eql(u8, subcmd, "serve")) {
        // Check --daemon flag
        var daemonize = false;
        while (args.next()) |arg| {
            if (std.mem.eql(u8, arg, "--daemon")) daemonize = true;
        }
        ensureDir(socket_path);
        if (daemonize) {
            const pid = c.fork();
            if (pid < 0) {
                std.debug.print("remux-agent: fork failed\n", .{});
                std.process.exit(1);
            }
            if (pid > 0) {
                // Parent: print PID and exit
                var pid_buf: [32]u8 = undefined;
                const pid_msg = std.fmt.bufPrint(&pid_buf, "{d}\n", .{pid}) catch return;
                _ = posix.write(1, pid_msg) catch {};
                return;
            }
            // Child: new session, close stdio
            _ = c.setsid();
            _ = c.close(0);
            _ = c.close(1);
            _ = c.close(2);
        }
        daemon.run(socket_path) catch |err| {
            std.debug.print("remux-agent: daemon error: {}\n", .{err});
            std.process.exit(1);
        };
    } else if (std.mem.eql(u8, subcmd, "attach")) {
        const session_id = args.next() orelse {
            std.debug.print("Usage: remux-agent attach <session-uuid>\n", .{});
            std.process.exit(1);
        };
        if (session_id.len != 36) {
            std.debug.print("remux-agent: session ID must be a 36-char UUID\n", .{});
            std.process.exit(1);
        }
        client.attach(socket_path, session_id) catch |err| {
            std.debug.print("remux-agent: attach failed: {}\n", .{err});
            std.process.exit(1);
        };
    } else if (std.mem.eql(u8, subcmd, "list")) {
        // Connect to daemon and request list
        const addr = std.net.Address.initUnix(socket_path) catch {
            std.debug.print("remux-agent: socket path too long\n", .{});
            return;
        };
        const sock_fd = posix.socket(posix.AF.UNIX, posix.SOCK.STREAM, 0) catch {
            std.debug.print("remux-agent: cannot create socket\n", .{});
            return;
        };
        defer posix.close(sock_fd);

        posix.connect(sock_fd, &addr.any, addr.getOsSockLen()) catch {
            std.debug.print("remux-agent: daemon not running at {s}\n", .{socket_path});
            return;
        };

        proto.writeFrame(sock_fd, .list_req, &.{}) catch return;
        var buf: [proto.max_payload]u8 = undefined;
        if (proto.readFrame(sock_fd, &buf)) |frame| {
            if (frame.tag == .list_resp) {
                _ = posix.write(1, frame.payload) catch {};
                _ = posix.write(1, "\n") catch {};
            }
        }
    } else if (std.mem.eql(u8, subcmd, "kill")) {
        const session_id = args.next() orelse {
            std.debug.print("Usage: remux-agent kill <session-uuid>\n", .{});
            return;
        };
        if (session_id.len != 36) {
            std.debug.print("remux-agent: session ID must be a 36-char UUID\n", .{});
            return;
        }
        const addr = std.net.Address.initUnix(socket_path) catch return;
        const sock_fd = posix.socket(posix.AF.UNIX, posix.SOCK.STREAM, 0) catch return;
        defer posix.close(sock_fd);
        posix.connect(sock_fd, &addr.any, addr.getOsSockLen()) catch {
            std.debug.print("remux-agent: daemon not running\n", .{});
            return;
        };
        proto.writeFrame(sock_fd, .kill, session_id[0..36]) catch return;
        std.debug.print("remux-agent: killed session {s}\n", .{session_id});
    } else {
        printUsage();
    }
}

fn printUsage() void {
    std.debug.print(
        \\Usage: remux-agent <command> [options]
        \\
        \\Commands:
        \\  serve [--daemon]           Start the agent daemon
        \\  attach <session-uuid>      Attach to a session (creates if new)
        \\  list                       List active sessions
        \\  kill <session-uuid>        Kill a session
        \\  version                    Print version
        \\
        \\Environment:
        \\  REMUX_AGENT_SOCKET         Override socket path (default: ~/.remux/agent.sock)
        \\
    , .{});
}
