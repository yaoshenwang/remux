package remux.protocol

import java.io.File

fun main(args: Array<String>) {
    require(args.isNotEmpty()) { "expected fixture file paths" }
    val decoded = mutableListOf<String>()

    for (fixturePath in args) {
        val fileName = File(fixturePath).name
        val root = SimpleJsonParser(File(fixturePath).readText()).parseValue().asObject()

        when (fileName) {
            "auth.legacy.json" -> decodeLegacyAuth(root)
            "auth.envelope.json" -> decodeAuthEnvelope(root)
            "auth_ok.legacy.json" -> decodeLegacyAuthOk(root)
            "auth_ok.envelope.json" -> decodeAuthOkEnvelope(root)
            "auth_error.legacy.json" -> decodeLegacyAuthError(root)
            "auth_error.envelope.json" -> decodeAuthErrorEnvelope(root)
            "inspect_content.legacy.json" -> decodeLegacyInspectContent(root)
            "inspect_content.envelope.json" -> decodeInspectContentEnvelope(root)
            "error.legacy.json" -> decodeLegacyError(root)
            "pong.legacy.json" -> decodeLegacyPong(root)
            "workspace_state.legacy.json" -> decodeLegacyWorkspaceState(root)
            "workspace_state.envelope.json" -> decodeWorkspaceStateEnvelope(root)
            "request_inspect.legacy.json" -> decodeLegacyInspectRequest(root)
            "request_inspect.envelope.json" -> decodeInspectRequestEnvelope(root)
            "inspect_snapshot.legacy.json" -> decodeLegacyInspectSnapshot(root)
            "inspect_snapshot.envelope.json" -> decodeInspectSnapshotEnvelope(root)
            "bandwidth_stats.legacy.json" -> decodeLegacyBandwidthStats(root)
            "bandwidth_stats.envelope.json" -> decodeBandwidthStatsEnvelope(root)
            else -> error("unknown fixture $fileName")
        }

        decoded += fileName
    }

    println(decoded.joinToString(","))
}

private fun decodeLegacyAuth(obj: Map<String, JsonValue>): LegacyAuth = LegacyAuth(
    type = obj.requireString("type"),
    token = obj.requireString("token"),
    password = obj.optionalString("password"),
    cols = obj.optionalInt("cols"),
    rows = obj.optionalInt("rows"),
    capabilities = obj.optionalObject("capabilities")?.let(::decodeProtocolCapabilities),
)

private fun decodeAuthEnvelope(obj: Map<String, JsonValue>): RemuxEnvelope<AuthPayload> = RemuxEnvelope(
    domain = obj.requireString("domain"),
    type = obj.requireString("type"),
    version = obj.requireInt("version"),
    requestId = obj.optionalString("requestId"),
    emittedAt = obj.requireString("emittedAt"),
    source = obj.requireString("source"),
    payload = decodeAuthPayload(obj.requireObject("payload")),
)

private fun decodeLegacyAuthOk(obj: Map<String, JsonValue>): LegacyAuthOk = LegacyAuthOk(
    type = obj.requireString("type"),
    capabilities = obj.requireObject("capabilities").let(::decodeProtocolCapabilities),
)

private fun decodeAuthOkEnvelope(obj: Map<String, JsonValue>): RemuxEnvelope<AuthOkPayload> = RemuxEnvelope(
    domain = obj.requireString("domain"),
    type = obj.requireString("type"),
    version = obj.requireInt("version"),
    requestId = obj.optionalString("requestId"),
    emittedAt = obj.requireString("emittedAt"),
    source = obj.requireString("source"),
    payload = AuthOkPayload(
        capabilities = obj.requireObject("payload").requireObject("capabilities").let(::decodeProtocolCapabilities),
    ),
)

private fun decodeLegacyAuthError(obj: Map<String, JsonValue>): LegacyAuthError = LegacyAuthError(
    type = obj.requireString("type"),
    reason = obj.requireString("reason"),
)

private fun decodeAuthErrorEnvelope(obj: Map<String, JsonValue>): RemuxEnvelope<AuthErrorPayload> = RemuxEnvelope(
    domain = obj.requireString("domain"),
    type = obj.requireString("type"),
    version = obj.requireInt("version"),
    requestId = obj.optionalString("requestId"),
    emittedAt = obj.requireString("emittedAt"),
    source = obj.requireString("source"),
    payload = AuthErrorPayload(
        reason = obj.requireObject("payload").requireString("reason"),
    ),
)

private fun decodeLegacyInspectContent(obj: Map<String, JsonValue>): LegacyInspectContent = LegacyInspectContent(
    type = obj.requireString("type"),
    content = obj.requireString("content"),
)

private fun decodeInspectContentEnvelope(obj: Map<String, JsonValue>): RemuxEnvelope<InspectContentPayload> = RemuxEnvelope(
    domain = obj.requireString("domain"),
    type = obj.requireString("type"),
    version = obj.requireInt("version"),
    requestId = obj.optionalString("requestId"),
    emittedAt = obj.requireString("emittedAt"),
    source = obj.requireString("source"),
    payload = InspectContentPayload(
        content = obj.requireObject("payload").requireString("content"),
    ),
)

private fun decodeLegacyError(obj: Map<String, JsonValue>): LegacyErrorMessage = LegacyErrorMessage(
    type = obj.requireString("type"),
    code = obj.optionalInt("code"),
    message = obj.requireString("message"),
)

private fun decodeLegacyPong(obj: Map<String, JsonValue>): LegacyPong = LegacyPong(
    type = obj.requireString("type"),
    timestamp = obj.requireNumber("timestamp"),
)

private fun decodeLegacyWorkspaceState(obj: Map<String, JsonValue>): LegacyWorkspaceState = LegacyWorkspaceState(
    type = obj.requireString("type"),
    session = obj.requireString("session"),
    tabs = obj.requireList("tabs").map { decodeWorkspaceTab(it.asObject()) },
    activeTabIndex = obj.requireInt("activeTabIndex"),
)

private fun decodeWorkspaceStateEnvelope(obj: Map<String, JsonValue>): RemuxEnvelope<WorkspaceState> = RemuxEnvelope(
    domain = obj.requireString("domain"),
    type = obj.requireString("type"),
    version = obj.requireInt("version"),
    requestId = obj.optionalString("requestId"),
    emittedAt = obj.requireString("emittedAt"),
    source = obj.requireString("source"),
    payload = decodeWorkspaceState(obj.requireObject("payload")),
)

private fun decodeLegacyInspectRequest(obj: Map<String, JsonValue>): LegacyInspectRequest = LegacyInspectRequest(
    type = obj.requireString("type"),
    scope = obj.requireString("scope"),
    paneId = obj.optionalString("paneId"),
    tabIndex = obj.optionalInt("tabIndex"),
    cursor = obj.optionalString("cursor"),
    query = obj.optionalString("query"),
    limit = obj.optionalInt("limit"),
)

private fun decodeInspectRequestEnvelope(obj: Map<String, JsonValue>): RemuxEnvelope<InspectRequest> = RemuxEnvelope(
    domain = obj.requireString("domain"),
    type = obj.requireString("type"),
    version = obj.requireInt("version"),
    requestId = obj.optionalString("requestId"),
    emittedAt = obj.requireString("emittedAt"),
    source = obj.requireString("source"),
    payload = decodeInspectRequest(obj.requireObject("payload")),
)

private fun decodeLegacyInspectSnapshot(obj: Map<String, JsonValue>): LegacyInspectSnapshot = LegacyInspectSnapshot(
    type = obj.requireString("type"),
    descriptor = decodeInspectDescriptor(obj.requireObject("descriptor")),
    items = obj.requireList("items").map { decodeInspectItem(it.asObject()) },
    cursor = obj.optionalString("cursor"),
    truncated = obj.requireBoolean("truncated"),
)

private fun decodeInspectSnapshotEnvelope(obj: Map<String, JsonValue>): RemuxEnvelope<InspectSnapshot> = RemuxEnvelope(
    domain = obj.requireString("domain"),
    type = obj.requireString("type"),
    version = obj.requireInt("version"),
    requestId = obj.optionalString("requestId"),
    emittedAt = obj.requireString("emittedAt"),
    source = obj.requireString("source"),
    payload = decodeInspectSnapshot(obj.requireObject("payload")),
)

private fun decodeLegacyBandwidthStats(obj: Map<String, JsonValue>): LegacyBandwidthStats = LegacyBandwidthStats(
    type = obj.requireString("type"),
    stats = decodeBandwidthStats(obj.requireObject("stats")),
)

private fun decodeBandwidthStatsEnvelope(obj: Map<String, JsonValue>): RemuxEnvelope<BandwidthStatsPayload> = RemuxEnvelope(
    domain = obj.requireString("domain"),
    type = obj.requireString("type"),
    version = obj.requireInt("version"),
    requestId = obj.optionalString("requestId"),
    emittedAt = obj.requireString("emittedAt"),
    source = obj.requireString("source"),
    payload = BandwidthStatsPayload(
        stats = decodeBandwidthStats(obj.requireObject("payload").requireObject("stats")),
    ),
)

private fun decodeProtocolCapabilities(obj: Map<String, JsonValue>): ProtocolCapabilities = ProtocolCapabilities(
    envelope = obj.requireBoolean("envelope"),
    inspectV2 = obj.requireBoolean("inspectV2"),
    deviceTrust = obj.requireBoolean("deviceTrust"),
)

private fun decodeAuthPayload(obj: Map<String, JsonValue>): AuthPayload = AuthPayload(
    token = obj.requireString("token"),
    password = obj.optionalString("password"),
    cols = obj.optionalInt("cols"),
    rows = obj.optionalInt("rows"),
    capabilities = obj.optionalObject("capabilities")?.let(::decodeProtocolCapabilities),
)

private fun decodeWorkspaceState(obj: Map<String, JsonValue>): WorkspaceState = WorkspaceState(
    session = obj.requireString("session"),
    tabs = obj.requireList("tabs").map { decodeWorkspaceTab(it.asObject()) },
    activeTabIndex = obj.requireInt("activeTabIndex"),
)

private fun decodeWorkspaceTab(obj: Map<String, JsonValue>): WorkspaceTab = WorkspaceTab(
    index = obj.requireInt("index"),
    name = obj.requireString("name"),
    active = obj.requireBoolean("active"),
    isFullscreen = obj.requireBoolean("isFullscreen"),
    hasBell = obj.requireBoolean("hasBell"),
    panes = obj.requireList("panes").map { decodeWorkspacePane(it.asObject()) },
)

private fun decodeWorkspacePane(obj: Map<String, JsonValue>): WorkspacePane = WorkspacePane(
    id = obj.requireString("id"),
    focused = obj.requireBoolean("focused"),
    title = obj.requireString("title"),
    command = obj.optionalString("command"),
    cwd = obj.optionalString("cwd"),
    rows = obj.requireInt("rows"),
    cols = obj.requireInt("cols"),
    x = obj.requireInt("x"),
    y = obj.requireInt("y"),
)

private fun decodeInspectRequest(obj: Map<String, JsonValue>): InspectRequest = InspectRequest(
    scope = obj.requireString("scope"),
    paneId = obj.optionalString("paneId"),
    tabIndex = obj.optionalInt("tabIndex"),
    cursor = obj.optionalString("cursor"),
    query = obj.optionalString("query"),
    limit = obj.optionalInt("limit"),
)

private fun decodeInspectSnapshot(obj: Map<String, JsonValue>): InspectSnapshot = InspectSnapshot(
    descriptor = decodeInspectDescriptor(obj.requireObject("descriptor")),
    items = obj.requireList("items").map { decodeInspectItem(it.asObject()) },
    cursor = obj.optionalString("cursor"),
    truncated = obj.requireBoolean("truncated"),
)

private fun decodeInspectDescriptor(obj: Map<String, JsonValue>): InspectDescriptor = InspectDescriptor(
    scope = obj.requireString("scope"),
    source = obj.requireString("source"),
    precision = obj.requireString("precision"),
    staleness = obj.requireString("staleness"),
    capturedAt = obj.requireString("capturedAt"),
    paneId = obj.optionalString("paneId"),
    tabIndex = obj.optionalInt("tabIndex"),
    totalItems = obj.optionalInt("totalItems"),
)

private fun decodeInspectItem(obj: Map<String, JsonValue>): InspectItem = InspectItem(
    type = obj.requireString("type"),
    content = obj.requireString("content"),
    lineNumber = obj.optionalInt("lineNumber"),
    timestamp = obj.requireString("timestamp"),
    paneId = obj.optionalString("paneId"),
    highlights = obj.optionalList("highlights")?.map { decodeInspectHighlight(it.asObject()) },
)

private fun decodeInspectHighlight(obj: Map<String, JsonValue>): InspectHighlight = InspectHighlight(
    start = obj.requireInt("start"),
    end = obj.requireInt("end"),
)

private fun decodeBandwidthStats(obj: Map<String, JsonValue>): BandwidthStats = BandwidthStats(
    rawBytesPerSec = obj.requireNumber("rawBytesPerSec"),
    compressedBytesPerSec = obj.requireNumber("compressedBytesPerSec"),
    savedPercent = obj.requireNumber("savedPercent"),
    fullSnapshotsSent = obj.requireInt("fullSnapshotsSent"),
    diffUpdatesSent = obj.requireInt("diffUpdatesSent"),
    avgChangedRowsPerDiff = obj.requireNumber("avgChangedRowsPerDiff"),
    totalRawBytes = obj.requireInt("totalRawBytes"),
    totalCompressedBytes = obj.requireInt("totalCompressedBytes"),
    totalSavedBytes = obj.requireInt("totalSavedBytes"),
    rttMs = obj.optionalInt("rttMs"),
    protocolName = obj.requireString("protocol"),
)

sealed class JsonValue {
    data class JsonString(val value: String) : JsonValue()
    data class JsonNumber(val value: Double) : JsonValue()
    data class JsonBoolean(val value: Boolean) : JsonValue()
    data class JsonObject(val value: Map<String, JsonValue>) : JsonValue()
    data class JsonArray(val value: List<JsonValue>) : JsonValue()
    object JsonNull : JsonValue()
}

private fun JsonValue.asObject(): Map<String, JsonValue> = when (this) {
    is JsonValue.JsonObject -> value
    else -> error("expected object")
}

private fun Map<String, JsonValue>.requireValue(key: String): JsonValue = this[key] ?: error("missing $key")
private fun Map<String, JsonValue>.requireObject(key: String): Map<String, JsonValue> = requireValue(key).asObject()
private fun Map<String, JsonValue>.optionalObject(key: String): Map<String, JsonValue>? = when (val value = this[key]) {
    null, JsonValue.JsonNull -> null
    is JsonValue.JsonObject -> value.value
    else -> error("expected object for $key")
}
private fun Map<String, JsonValue>.requireString(key: String): String = when (val value = requireValue(key)) {
    is JsonValue.JsonString -> value.value
    else -> error("expected string for $key")
}
private fun Map<String, JsonValue>.optionalString(key: String): String? = when (val value = this[key]) {
    null, JsonValue.JsonNull -> null
    is JsonValue.JsonString -> value.value
    else -> error("expected string for $key")
}
private fun Map<String, JsonValue>.requireBoolean(key: String): Boolean = when (val value = requireValue(key)) {
    is JsonValue.JsonBoolean -> value.value
    else -> error("expected boolean for $key")
}
private fun Map<String, JsonValue>.requireNumber(key: String): Double = when (val value = requireValue(key)) {
    is JsonValue.JsonNumber -> value.value
    else -> error("expected number for $key")
}
private fun Map<String, JsonValue>.requireInt(key: String): Int = requireNumber(key).toInt()
private fun Map<String, JsonValue>.optionalInt(key: String): Int? = when (val value = this[key]) {
    null, JsonValue.JsonNull -> null
    is JsonValue.JsonNumber -> value.value.toInt()
    else -> error("expected number for $key")
}
private fun Map<String, JsonValue>.requireList(key: String): List<JsonValue> = when (val value = requireValue(key)) {
    is JsonValue.JsonArray -> value.value
    else -> error("expected array for $key")
}
private fun Map<String, JsonValue>.optionalList(key: String): List<JsonValue>? = when (val value = this[key]) {
    null, JsonValue.JsonNull -> null
    is JsonValue.JsonArray -> value.value
    else -> error("expected array for $key")
}

private class SimpleJsonParser(private val input: String) {
    private var index = 0

    fun parseValue(): JsonValue {
        skipWhitespace()
        return when (peek()) {
            '"' -> JsonValue.JsonString(parseString())
            '{' -> parseObject()
            '[' -> parseArray()
            't' -> {
                expectLiteral("true")
                JsonValue.JsonBoolean(true)
            }
            'f' -> {
                expectLiteral("false")
                JsonValue.JsonBoolean(false)
            }
            'n' -> {
                expectLiteral("null")
                JsonValue.JsonNull
            }
            else -> JsonValue.JsonNumber(parseNumber())
        }
    }

    private fun parseObject(): JsonValue.JsonObject {
        expect('{')
        skipWhitespace()
        if (peek() == '}') {
            index++
            return JsonValue.JsonObject(emptyMap())
        }
        val map = linkedMapOf<String, JsonValue>()
        while (true) {
            val key = parseString()
            skipWhitespace()
            expect(':')
            val value = parseValue()
            map[key] = value
            skipWhitespace()
            when (peek()) {
                ',' -> {
                    index++
                    skipWhitespace()
                }
                '}' -> {
                    index++
                    return JsonValue.JsonObject(map)
                }
                else -> error("expected ',' or '}' at index $index")
            }
        }
    }

    private fun parseArray(): JsonValue.JsonArray {
        expect('[')
        skipWhitespace()
        if (peek() == ']') {
            index++
            return JsonValue.JsonArray(emptyList())
        }
        val items = mutableListOf<JsonValue>()
        while (true) {
            items += parseValue()
            skipWhitespace()
            when (peek()) {
                ',' -> {
                    index++
                    skipWhitespace()
                }
                ']' -> {
                    index++
                    return JsonValue.JsonArray(items)
                }
                else -> error("expected ',' or ']' at index $index")
            }
        }
    }

    private fun parseString(): String {
        expect('"')
        val builder = StringBuilder()
        while (true) {
            require(index < input.length) { "unterminated string" }
            val current = input[index++]
            when (current) {
                '"' -> return builder.toString()
                '\\' -> {
                    require(index < input.length) { "unterminated escape" }
                    val escaped = input[index++]
                    builder.append(
                        when (escaped) {
                            '"', '\\', '/' -> escaped
                            'b' -> '\b'
                            'f' -> '\u000C'
                            'n' -> '\n'
                            'r' -> '\r'
                            't' -> '\t'
                            'u' -> parseUnicodeEscape()
                            else -> error("unsupported escape \\$escaped")
                        },
                    )
                }
                else -> builder.append(current)
            }
        }
    }

    private fun parseUnicodeEscape(): Char {
        require(index + 4 <= input.length) { "invalid unicode escape" }
        val hex = input.substring(index, index + 4)
        index += 4
        return hex.toInt(16).toChar()
    }

    private fun parseNumber(): Double {
        val start = index
        while (index < input.length && input[index] in "-+0123456789.eE") {
            index++
        }
        return input.substring(start, index).toDouble()
    }

    private fun expect(expected: Char) {
        require(peek() == expected) { "expected '$expected' at index $index" }
        index++
    }

    private fun expectLiteral(expected: String) {
        require(input.startsWith(expected, index)) { "expected $expected at index $index" }
        index += expected.length
    }

    private fun skipWhitespace() {
        while (index < input.length && input[index].isWhitespace()) {
            index++
        }
    }

    private fun peek(): Char {
        require(index < input.length) { "unexpected end of input" }
        return input[index]
    }
}
