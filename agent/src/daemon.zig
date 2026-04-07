// Adapted from yaoshenwang/remux remuxd/src/main.zig
// Unix socket daemon managing persistent PTY sessions.
const std = @import("std");
const posix = std.posix;
const proto = @import("protocol.zig");
const Session = @import("session.zig").Session;
const SessionManager = @import("session.zig").SessionManager;

const c = @cImport({
    @cInclude("signal.h");
    @cInclude("unistd.h");
    @cInclude("sys/wait.h");
    @cInclude("sys/stat.h");
});

var g_running = std.atomic.Value(bool).init(true);

pub fn run(socket_path: []const u8) !void {
    // Ignore SIGPIPE (broken client connections)
    var sa: posix.Sigaction = .{
        .handler = .{ .handler = posix.SIG.IGN },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.PIPE, &sa, null);

    // Set up SIGCHLD to reap children automatically
    var sa_chld: posix.Sigaction = .{
        .handler = .{ .handler = sigchldHandler },
        .mask = posix.sigemptyset(),
        .flags = posix.SA.NOCLDSTOP,
    };
    posix.sigaction(posix.SIG.CHLD, &sa_chld, null);

    var gpa: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const alloc = gpa.allocator();

    var manager = SessionManager.init(alloc);
    defer manager.deinit();
    var manager_mutex: std.Thread.Mutex = .{};

    // Remove stale socket
    std.fs.deleteFileAbsolute(socket_path) catch {};

    // Bind Unix socket
    const addr = std.net.Address.initUnix(socket_path) catch {
        std.debug.print("remux-agent: socket path too long: {s}\n", .{socket_path});
        return error.SocketPathTooLong;
    };
    const server_fd = posix.socket(posix.AF.UNIX, posix.SOCK.STREAM, 0) catch {
        std.debug.print("remux-agent: failed to create socket\n", .{});
        return error.SocketCreation;
    };
    defer posix.close(server_fd);

    posix.bind(server_fd, &addr.any, addr.getOsSockLen()) catch {
        std.debug.print("remux-agent: failed to bind {s}\n", .{socket_path});
        return error.SocketBind;
    };

    // Set socket permissions (owner only)
    _ = c.chmod(socket_path.ptr, 0o600);

    posix.listen(server_fd, 8) catch {
        std.debug.print("remux-agent: failed to listen\n", .{});
        return error.SocketListen;
    };

    std.debug.print("remux-agent: listening on {s}\n", .{socket_path});

    // Accept loop
    while (g_running.load(.acquire)) {
        const client = posix.accept(server_fd, null, null, 0) catch continue;

        // Handle client in a new thread
        const thread = std.Thread.spawn(.{}, handleClient, .{ client, &manager, &manager_mutex, alloc }) catch {
            posix.close(client);
            continue;
        };
        thread.detach();
    }
}

fn handleClient(
    client_fd: posix.fd_t,
    manager: *SessionManager,
    mutex: *std.Thread.Mutex,
    alloc: std.mem.Allocator,
) void {
    defer posix.close(client_fd);

    var buf: [proto.max_payload]u8 = undefined;

    // Read first frame — must be Init or ListReq
    const frame = proto.readFrame(client_fd, &buf) orelse return;

    switch (frame.tag) {
        .list_req => {
            // Return session list
            mutex.lock();
            manager.reapDead();
            const json = manager.listJson() catch {
                mutex.unlock();
                return;
            };
            mutex.unlock();
            defer alloc.free(json);
            proto.writeFrame(client_fd, .list_resp, json) catch {};
            return;
        },
        .kill => {
            // Kill a session by ID from payload
            if (frame.payload.len >= 36) {
                mutex.lock();
                manager.remove(frame.payload[0..36]);
                mutex.unlock();
            }
            return;
        },
        .init => {
            const init = proto.decodeInit(frame.payload) orelse return;
            handleSession(client_fd, manager, mutex, alloc, init);
        },
        else => return,
    }
}

fn handleSession(
    client_fd: posix.fd_t,
    manager: *SessionManager,
    mutex: *std.Thread.Mutex,
    alloc: std.mem.Allocator,
    init: proto.InitPayload,
) void {
    // Get or create session
    mutex.lock();
    manager.reapDead();
    const sess = manager.getOrCreate(init.session_id, init.cols, init.rows) catch {
        mutex.unlock();
        return;
    };

    // Check if another client is already attached
    const prev = sess.client_fd.swap(client_fd, .acq_rel);
    _ = prev; // allow replacing (old client will see write errors and exit)

    // Start PTY reader thread if not running
    if (sess.reader_thread == null) {
        sess.reader_thread = std.Thread.spawn(.{}, ptyReaderThread, .{sess}) catch null;
    }
    mutex.unlock();

    // Send scrollback snapshot
    const snapshot = sess.getScrollback(alloc) catch &[0]u8{};
    defer if (snapshot.len > 0) alloc.free(snapshot);
    if (snapshot.len > 0) {
        proto.writeFrame(client_fd, .snapshot, snapshot) catch return;
    }

    // I/O proxy loop: client → PTY
    var read_buf: [4096]u8 = undefined;
    while (sess.isAlive()) {
        const frame = proto.readFrame(client_fd, &read_buf) orelse break;
        switch (frame.tag) {
            .data => {
                sess.writeInput(frame.payload) catch break;
            },
            .resize => {
                if (proto.decodeResize(frame.payload)) |sz| {
                    sess.resize(sz.cols, sz.rows);
                }
            },
            .detach => break,
            .kill => {
                mutex.lock();
                manager.remove(&sess.id);
                mutex.unlock();
                break;
            },
            else => {},
        }
    }

    // Detach: clear client_fd if we're still the current client
    _ = sess.client_fd.cmpxchgStrong(client_fd, -1, .acq_rel, .acquire);
}

fn ptyReaderThread(sess: *Session) void {
    var buf: [4096]u8 = undefined;
    while (sess.isAlive()) {
        const n = posix.read(@intCast(sess.pty_fd), &buf) catch break;
        if (n == 0) break;
        const data = buf[0..n];

        // Append to scrollback
        sess.appendScrollback(data);

        // Forward to attached client
        const cfd = sess.client_fd.load(.acquire);
        if (cfd >= 0) {
            proto.writeFrame(cfd, .data, data) catch {
                // Client disconnected — clear fd
                _ = sess.client_fd.cmpxchgStrong(cfd, -1, .acq_rel, .acquire);
            };
        }
    }
    sess.alive.store(false, .release);

    const cfd = sess.client_fd.load(.acquire);
    if (cfd >= 0) {
        proto.writeFrame(cfd, .exit, &.{}) catch {
            _ = sess.client_fd.cmpxchgStrong(cfd, -1, .acq_rel, .acquire);
        };
    }
}

fn sigchldHandler(_: c_int) callconv(.c) void {
    // Reap all zombie children
    while (true) {
        const ret = c.waitpid(-1, null, c.WNOHANG);
        if (ret <= 0) break;
    }
}
