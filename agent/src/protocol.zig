const std = @import("std");
const posix = std.posix;

/// Binary frame protocol for remux-agent IPC.
/// Frame format: [tag:u8][length:u32 LE][payload]

pub const Tag = enum(u8) {
    init = 0x01, // client→daemon: session_id(36) + cols:u16 + rows:u16
    data = 0x02, // bidirectional: raw terminal bytes
    resize = 0x03, // client→daemon: cols:u16 + rows:u16
    snapshot = 0x04, // daemon→client: scrollback bytes
    exit = 0x05, // daemon→client: exit_code:i32
    detach = 0x06, // client→daemon: (empty)
    kill = 0x07, // client→daemon: (empty)
    info = 0x08, // bidirectional: JSON
    list_req = 0x09, // client→daemon: request session list
    list_resp = 0x0A, // daemon→client: JSON session list
};

pub const header_size = 5; // 1 tag + 4 length
pub const max_payload = 64 * 1024;

pub fn writeFrame(fd: posix.fd_t, tag: Tag, payload: []const u8) !void {
    var header: [header_size]u8 = undefined;
    header[0] = @intFromEnum(tag);
    std.mem.writeInt(u32, header[1..5], @intCast(payload.len), .little);
    _ = try posix.write(fd, &header);
    if (payload.len > 0) {
        _ = try posix.write(fd, payload);
    }
}

pub fn readFrame(fd: posix.fd_t, buf: []u8) ?Frame {
    var header: [header_size]u8 = undefined;
    const hn = readExact(fd, &header) catch return null;
    if (hn < header_size) return null;

    const tag_byte = header[0];
    const length = std.mem.readInt(u32, header[1..5], .little);
    if (length > max_payload) return null;

    const payload_len: usize = @intCast(length);
    if (payload_len > buf.len) return null;

    if (payload_len > 0) {
        const pn = readExact(fd, buf[0..payload_len]) catch return null;
        if (pn < payload_len) return null;
    }

    return Frame{
        .tag = std.meta.intToEnum(Tag, tag_byte) catch return null,
        .payload = buf[0..payload_len],
    };
}

pub const Frame = struct {
    tag: Tag,
    payload: []const u8,
};

/// Encode Init payload: session_id(36 bytes) + cols:u16 + rows:u16
pub fn encodeInit(buf: []u8, session_id: []const u8, cols: u16, rows: u16) []u8 {
    @memcpy(buf[0..36], session_id[0..36]);
    std.mem.writeInt(u16, buf[36..38], cols, .little);
    std.mem.writeInt(u16, buf[38..40], rows, .little);
    return buf[0..40];
}

pub const InitPayload = struct {
    session_id: [36]u8,
    cols: u16,
    rows: u16,
};

pub fn decodeInit(payload: []const u8) ?InitPayload {
    if (payload.len < 40) return null;
    return .{
        .session_id = payload[0..36].*,
        .cols = std.mem.readInt(u16, payload[36..38], .little),
        .rows = std.mem.readInt(u16, payload[38..40], .little),
    };
}

/// Encode Resize payload: cols:u16 + rows:u16
pub fn encodeResize(buf: []u8, cols: u16, rows: u16) []u8 {
    std.mem.writeInt(u16, buf[0..2], cols, .little);
    std.mem.writeInt(u16, buf[2..4], rows, .little);
    return buf[0..4];
}

pub fn decodeResize(payload: []const u8) ?struct { cols: u16, rows: u16 } {
    if (payload.len < 4) return null;
    return .{
        .cols = std.mem.readInt(u16, payload[0..2], .little),
        .rows = std.mem.readInt(u16, payload[2..4], .little),
    };
}

fn readExact(fd: posix.fd_t, buf: []u8) !usize {
    var total: usize = 0;
    while (total < buf.len) {
        const n = posix.read(fd, buf[total..]) catch |err| {
            if (total > 0) return total;
            return err;
        };
        if (n == 0) return total;
        total += n;
    }
    return total;
}
