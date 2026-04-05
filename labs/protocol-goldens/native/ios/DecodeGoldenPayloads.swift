@main
struct DecodeGoldenPayloads {
  static func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count == 2 else {
      throw DecodeError.message("expected compiled fixture JSON string")
    }

    var parser = SimpleJSONParser(arguments[1])
    let fixtures = try parser.parseArray()
    var decodedTargets: [String] = []

    for fixture in fixtures {
      let fixtureObject = try fixture.asObject()
      let target = try fixtureObject.requireString("target")
      let json = try fixtureObject.requireValue("json")

      switch target {
      case "LegacyAuth":
        let value = try decodeLegacyAuth(from: json)
        try check(value.type == "auth", "unexpected legacy auth type")
        decodedTargets.append(target)
      case "AuthEnvelope":
        let value = try decodeEnvelope(from: json, payloadDecoder: decodeAuthPayload)
        try check(value.domain == "core", "unexpected auth domain")
        decodedTargets.append(target)
      case "LegacyAuthOk":
        let value = try decodeLegacyAuthOk(from: json)
        try check(value.type == "auth_ok", "unexpected auth ok type")
        decodedTargets.append(target)
      case "AuthOkEnvelope":
        let value = try decodeEnvelope(from: json, payloadDecoder: decodeAuthOkPayload)
        try check(value.domain == "core", "unexpected auth ok domain")
        decodedTargets.append(target)
      case "LegacyAuthError":
        let value = try decodeLegacyAuthError(from: json)
        try check(value.type == "auth_error", "unexpected auth error type")
        decodedTargets.append(target)
      case "LegacyErrorMessage":
        let value = try decodeLegacyErrorMessage(from: json)
        try check(value.type == "error", "unexpected legacy error type")
        decodedTargets.append(target)
      case "LegacyPong":
        let value = try decodeLegacyPong(from: json)
        try check(value.type == "pong", "unexpected legacy pong type")
        decodedTargets.append(target)
      case "AuthErrorEnvelope":
        let value = try decodeEnvelope(from: json, payloadDecoder: decodeAuthErrorPayload)
        try check(value.domain == "core", "unexpected auth error domain")
        decodedTargets.append(target)
      case "LegacyInspectContent":
        let value = try decodeLegacyInspectContent(from: json)
        try check(value.type == "inspect_content", "unexpected legacy inspect content type")
        decodedTargets.append(target)
      case "InspectContentEnvelope":
        let value = try decodeEnvelope(from: json, payloadDecoder: decodeInspectContentPayload)
        try check(value.domain == "core", "unexpected inspect content domain")
        decodedTargets.append(target)
      case "LegacyRequestInspect":
        let value = try decodeLegacyInspectRequest(from: json)
        try check(value.type == "request_inspect", "unexpected legacy inspect request type")
        decodedTargets.append(target)
      case "RequestInspectEnvelope":
        let value = try decodeEnvelope(from: json, payloadDecoder: decodeInspectRequest)
        try check(value.domain == "inspect", "unexpected inspect request domain")
        decodedTargets.append(target)
      case "LegacyInspectSnapshot":
        let value = try decodeLegacyInspectSnapshot(from: json)
        try check(value.type == "inspect_snapshot", "unexpected legacy inspect snapshot type")
        decodedTargets.append(target)
      case "InspectSnapshotEnvelope":
        let value = try decodeEnvelope(from: json, payloadDecoder: decodeInspectSnapshot)
        try check(value.domain == "inspect", "unexpected inspect snapshot domain")
        decodedTargets.append(target)
      case "LegacyWorkspaceState":
        let value = try decodeLegacyWorkspaceState(from: json)
        try check(value.type == "workspace_state", "unexpected legacy workspace state type")
        decodedTargets.append(target)
      case "WorkspaceStateEnvelope":
        let value = try decodeEnvelope(from: json, payloadDecoder: decodeWorkspaceState)
        try check(value.domain == "runtime", "unexpected workspace state domain")
        decodedTargets.append(target)
      case "LegacyBandwidthStats":
        let value = try decodeLegacyBandwidthStats(from: json)
        try check(value.type == "bandwidth_stats", "unexpected legacy bandwidth stats type")
        decodedTargets.append(target)
      case "BandwidthStatsEnvelope":
        let value = try decodeEnvelope(from: json, payloadDecoder: decodeBandwidthStatsPayload)
        try check(value.domain == "admin", "unexpected bandwidth stats domain")
        decodedTargets.append(target)
      default:
        throw DecodeError.message("unknown fixture target \(target)")
      }
    }

    print(decodedTargets.joined(separator: ","))
  }

  private static func decodeLegacyAuth(from value: JSONValue) throws -> LegacyAuth {
    let object = try value.asObject()
    return LegacyAuth(
      type: try object.requireString("type"),
      token: try object.requireString("token"),
      password: object.optionalString("password"),
      cols: object.optionalInt("cols"),
      rows: object.optionalInt("rows"),
      capabilities: try object.optionalDecoded("capabilities", decodeProtocolCapabilities)
    )
  }

  private static func decodeAuthPayload(from value: JSONValue) throws -> AuthPayload {
    let object = try value.asObject()
    return AuthPayload(
      token: try object.requireString("token"),
      password: object.optionalString("password"),
      cols: object.optionalInt("cols"),
      rows: object.optionalInt("rows"),
      capabilities: try object.optionalDecoded("capabilities", decodeProtocolCapabilities)
    )
  }

  private static func decodeLegacyAuthOk(from value: JSONValue) throws -> LegacyAuthOk {
    let object = try value.asObject()
    return LegacyAuthOk(
      type: try object.requireString("type"),
      capabilities: try decodeProtocolCapabilities(from: object.requireValue("capabilities"))
    )
  }

  private static func decodeAuthOkPayload(from value: JSONValue) throws -> AuthOkPayload {
    let object = try value.asObject()
    return AuthOkPayload(
      capabilities: try decodeProtocolCapabilities(from: object.requireValue("capabilities"))
    )
  }

  private static func decodeLegacyAuthError(from value: JSONValue) throws -> LegacyAuthError {
    let object = try value.asObject()
    return LegacyAuthError(
      type: try object.requireString("type"),
      reason: try object.requireString("reason")
    )
  }

  private static func decodeAuthErrorPayload(from value: JSONValue) throws -> AuthErrorPayload {
    let object = try value.asObject()
    return AuthErrorPayload(reason: try object.requireString("reason"))
  }

  private static func decodeLegacyErrorMessage(from value: JSONValue) throws -> LegacyErrorMessage {
    let object = try value.asObject()
    return LegacyErrorMessage(
      type: try object.requireString("type"),
      code: object.optionalInt("code"),
      message: try object.requireString("message")
    )
  }

  private static func decodeLegacyPong(from value: JSONValue) throws -> LegacyPong {
    let object = try value.asObject()
    return LegacyPong(
      type: try object.requireString("type"),
      timestamp: try object.requireDouble("timestamp")
    )
  }

  private static func decodeLegacyInspectContent(from value: JSONValue) throws -> LegacyInspectContent {
    let object = try value.asObject()
    return LegacyInspectContent(
      type: try object.requireString("type"),
      content: try object.requireString("content")
    )
  }

  private static func decodeInspectContentPayload(from value: JSONValue) throws -> InspectContentPayload {
    let object = try value.asObject()
    return InspectContentPayload(content: try object.requireString("content"))
  }

  private static func decodeProtocolCapabilities(from value: JSONValue) throws -> ProtocolCapabilities {
    let object = try value.asObject()
    return ProtocolCapabilities(
      envelope: try object.requireBool("envelope"),
      inspectV2: try object.requireBool("inspectV2"),
      deviceTrust: try object.requireBool("deviceTrust")
    )
  }

  private static func decodeLegacyWorkspaceState(from value: JSONValue) throws -> LegacyWorkspaceState {
    let object = try value.asObject()
    let tabs = try object.requireArray("tabs").map(decodeWorkspaceTab)
    return LegacyWorkspaceState(
      type: try object.requireString("type"),
      session: try object.requireString("session"),
      tabs: tabs,
      activeTabIndex: try object.requireInt("activeTabIndex")
    )
  }

  private static func decodeWorkspaceState(from value: JSONValue) throws -> WorkspaceState {
    let object = try value.asObject()
    let tabs = try object.requireArray("tabs").map(decodeWorkspaceTab)
    return WorkspaceState(
      session: try object.requireString("session"),
      tabs: tabs,
      activeTabIndex: try object.requireInt("activeTabIndex")
    )
  }

  private static func decodeWorkspaceTab(from value: JSONValue) throws -> WorkspaceTab {
    let object = try value.asObject()
    let panes = try object.requireArray("panes").map(decodeWorkspacePane)
    return WorkspaceTab(
      index: try object.requireInt("index"),
      name: try object.requireString("name"),
      active: try object.requireBool("active"),
      isFullscreen: try object.requireBool("isFullscreen"),
      hasBell: try object.requireBool("hasBell"),
      panes: panes
    )
  }

  private static func decodeWorkspacePane(from value: JSONValue) throws -> WorkspacePane {
    let object = try value.asObject()
    return WorkspacePane(
      id: try object.requireString("id"),
      focused: try object.requireBool("focused"),
      title: try object.requireString("title"),
      command: object.optionalString("command"),
      cwd: object.optionalString("cwd"),
      rows: try object.requireInt("rows"),
      cols: try object.requireInt("cols"),
      x: try object.requireInt("x"),
      y: try object.requireInt("y")
    )
  }

  private static func decodeLegacyInspectRequest(from value: JSONValue) throws -> LegacyInspectRequest {
    let object = try value.asObject()
    return LegacyInspectRequest(
      type: try object.requireString("type"),
      scope: try object.requireString("scope"),
      paneId: object.optionalString("paneId"),
      tabIndex: object.optionalInt("tabIndex"),
      cursor: object.optionalString("cursor"),
      query: object.optionalString("query"),
      limit: object.optionalInt("limit")
    )
  }

  private static func decodeInspectRequest(from value: JSONValue) throws -> InspectRequest {
    let object = try value.asObject()
    return InspectRequest(
      scope: try object.requireString("scope"),
      paneId: object.optionalString("paneId"),
      tabIndex: object.optionalInt("tabIndex"),
      cursor: object.optionalString("cursor"),
      query: object.optionalString("query"),
      limit: object.optionalInt("limit")
    )
  }

  private static func decodeLegacyInspectSnapshot(from value: JSONValue) throws -> LegacyInspectSnapshot {
    let object = try value.asObject()
    let items = try object.requireArray("items").map(decodeInspectItem)
    return LegacyInspectSnapshot(
      type: try object.requireString("type"),
      descriptor: try decodeInspectDescriptor(from: object.requireValue("descriptor")),
      items: items,
      cursor: object.optionalString("cursor"),
      truncated: try object.requireBool("truncated")
    )
  }

  private static func decodeInspectSnapshot(from value: JSONValue) throws -> InspectSnapshot {
    let object = try value.asObject()
    let items = try object.requireArray("items").map(decodeInspectItem)
    return InspectSnapshot(
      descriptor: try decodeInspectDescriptor(from: object.requireValue("descriptor")),
      items: items,
      cursor: object.optionalString("cursor"),
      truncated: try object.requireBool("truncated")
    )
  }

  private static func decodeInspectDescriptor(from value: JSONValue) throws -> InspectDescriptor {
    let object = try value.asObject()
    return InspectDescriptor(
      scope: try object.requireString("scope"),
      source: try object.requireString("source"),
      precision: try object.requireString("precision"),
      staleness: try object.requireString("staleness"),
      capturedAt: try object.requireString("capturedAt"),
      paneId: object.optionalString("paneId"),
      tabIndex: object.optionalInt("tabIndex"),
      totalItems: object.optionalInt("totalItems")
    )
  }

  private static func decodeInspectItem(from value: JSONValue) throws -> InspectItem {
    let object = try value.asObject()
    let highlights = try object.optionalArray("highlights")?.map(decodeInspectHighlight)
    return InspectItem(
      type: try object.requireString("type"),
      content: try object.requireString("content"),
      lineNumber: object.optionalInt("lineNumber"),
      timestamp: try object.requireString("timestamp"),
      paneId: object.optionalString("paneId"),
      highlights: highlights
    )
  }

  private static func decodeInspectHighlight(from value: JSONValue) throws -> InspectHighlight {
    let object = try value.asObject()
    return InspectHighlight(
      start: try object.requireInt("start"),
      end: try object.requireInt("end")
    )
  }

  private static func decodeLegacyBandwidthStats(from value: JSONValue) throws -> LegacyBandwidthStats {
    let object = try value.asObject()
    return LegacyBandwidthStats(
      type: try object.requireString("type"),
      stats: try decodeBandwidthStats(from: object.requireValue("stats"))
    )
  }

  private static func decodeBandwidthStatsPayload(from value: JSONValue) throws -> BandwidthStatsPayload {
    let object = try value.asObject()
    return BandwidthStatsPayload(
      stats: try decodeBandwidthStats(from: object.requireValue("stats"))
    )
  }

  private static func decodeBandwidthStats(from value: JSONValue) throws -> BandwidthStats {
    let object = try value.asObject()
    return BandwidthStats(
      rawBytesPerSec: try object.requireDouble("rawBytesPerSec"),
      compressedBytesPerSec: try object.requireDouble("compressedBytesPerSec"),
      savedPercent: try object.requireDouble("savedPercent"),
      fullSnapshotsSent: try object.requireInt("fullSnapshotsSent"),
      diffUpdatesSent: try object.requireInt("diffUpdatesSent"),
      avgChangedRowsPerDiff: try object.requireDouble("avgChangedRowsPerDiff"),
      totalRawBytes: try object.requireInt("totalRawBytes"),
      totalCompressedBytes: try object.requireInt("totalCompressedBytes"),
      totalSavedBytes: try object.requireInt("totalSavedBytes"),
      rttMs: object.optionalInt("rttMs"),
      protocolName: try object.requireString("protocol")
    )
  }

  private static func decodeEnvelope<T>(
    from value: JSONValue,
    payloadDecoder: (JSONValue) throws -> T
  ) throws -> RemuxEnvelope<T> {
    let object = try value.asObject()
    return RemuxEnvelope(
      domain: try object.requireString("domain"),
      type: try object.requireString("type"),
      version: try object.requireInt("version"),
      requestId: object.optionalString("requestId"),
      emittedAt: try object.requireString("emittedAt"),
      source: try object.requireString("source"),
      payload: try payloadDecoder(object.requireValue("payload"))
    )
  }

  private static func check(_ condition: Bool, _ message: String) throws {
    if !condition {
      throw DecodeError.message(message)
    }
  }
}

private enum JSONValue {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  func asObject() throws -> [String: JSONValue] {
    guard case let .object(value) = self else {
      throw DecodeError.message("expected object")
    }
    return value
  }
}

private struct SimpleJSONParser {
  let input: [Character]
  var index: Int = 0

  init(_ input: String) {
    self.input = Array(input)
  }

  mutating func parseArray() throws -> [JSONValue] {
    try skipWhitespace()
    try expect("[")
    try skipWhitespace()
    if peek() == "]" {
      index += 1
      return []
    }

    var values: [JSONValue] = []
    while true {
      values.append(try parseValue())
      try skipWhitespace()
      if peek() == "," {
        index += 1
        try skipWhitespace()
        continue
      }
      if peek() == "]" {
        index += 1
        return values
      }
      throw parserError("expected ',' or ']'")
    }
  }

  mutating func parseValue() throws -> JSONValue {
    try skipWhitespace()
    switch peek() {
    case "\"":
      return .string(try parseString())
    case "{":
      return try parseObject()
    case "[":
      return try parseArrayValue()
    case "t":
      try expect("true")
      return .bool(true)
    case "f":
      try expect("false")
      return .bool(false)
    case "n":
      try expect("null")
      return .null
    default:
      return .number(try parseNumber())
    }
  }

  private mutating func parseObject() throws -> JSONValue {
    try expect("{")
    try skipWhitespace()
    if peek() == "}" {
      index += 1
      return .object([:])
    }

    var values: [String: JSONValue] = [:]
    while true {
      let key = try parseString()
      try skipWhitespace()
      try expect(":")
      values[key] = try parseValue()
      try skipWhitespace()
      if peek() == "," {
        index += 1
        try skipWhitespace()
        continue
      }
      if peek() == "}" {
        index += 1
        return .object(values)
      }
      throw parserError("expected ',' or '}'")
    }
  }

  private mutating func parseArrayValue() throws -> JSONValue {
    try expect("[")
    try skipWhitespace()
    if peek() == "]" {
      index += 1
      return .array([])
    }

    var values: [JSONValue] = []
    while true {
      values.append(try parseValue())
      try skipWhitespace()
      if peek() == "," {
        index += 1
        try skipWhitespace()
        continue
      }
      if peek() == "]" {
        index += 1
        return .array(values)
      }
      throw parserError("expected ',' or ']'")
    }
  }

  private mutating func parseString() throws -> String {
    try expect("\"")
    var result = ""
    while index < input.count {
      let character = input[index]
      index += 1
      if character == "\"" {
        return result
      }
      if character == "\\" {
        let escaped = try nextCharacter()
        switch escaped {
        case "\"", "\\", "/":
          result.append(escaped)
        case "b":
          result.append("\u{8}")
        case "f":
          result.append("\u{c}")
        case "n":
          result.append("\n")
        case "r":
          result.append("\r")
        case "t":
          result.append("\t")
        case "u":
          let scalar = try parseUnicodeEscape()
          result.append(Character(scalar))
        default:
          throw parserError("unsupported escape sequence")
        }
        continue
      }
      result.append(character)
    }

    throw parserError("unterminated string")
  }

  private mutating func parseUnicodeEscape() throws -> UnicodeScalar {
    var hex = ""
    for _ in 0..<4 {
      hex.append(try nextCharacter())
    }
    guard let value = UInt32(hex, radix: 16), let scalar = UnicodeScalar(value) else {
      throw parserError("invalid unicode escape")
    }
    return scalar
  }

  private mutating func parseNumber() throws -> Double {
    let start = index
    if peek() == "-" {
      index += 1
    }
    while peek().isNumber {
      index += 1
    }
    if peek() == "." {
      index += 1
      while peek().isNumber {
        index += 1
      }
    }
    if peek() == "e" || peek() == "E" {
      index += 1
      if peek() == "+" || peek() == "-" {
        index += 1
      }
      while peek().isNumber {
        index += 1
      }
    }
    let literal = String(input[start..<index])
    guard let value = Double(literal) else {
      throw parserError("invalid number")
    }
    return value
  }

  private mutating func skipWhitespace() throws {
    while peek().isWhitespace {
      index += 1
    }
  }

  private func peek() -> Character {
    guard index < input.count else {
      return "\0"
    }
    return input[index]
  }

  private mutating func nextCharacter() throws -> Character {
    guard index < input.count else {
      throw parserError("unexpected end of input")
    }
    defer { index += 1 }
    return input[index]
  }

  private mutating func expect(_ literal: String) throws {
    for expected in literal {
      guard index < input.count, input[index] == expected else {
        throw parserError("expected '\(literal)'")
      }
      index += 1
    }
  }

  private func parserError(_ message: String) -> DecodeError {
    .message("\(message) at index \(index)")
  }
}

private extension Dictionary where Key == String, Value == JSONValue {
  func requireValue(_ key: String) throws -> JSONValue {
    guard let value = self[key] else {
      throw DecodeError.message("missing key \(key)")
    }
    return value
  }

  func requireString(_ key: String) throws -> String {
    guard case let .string(value) = try requireValue(key) else {
      throw DecodeError.message("expected string for \(key)")
    }
    return value
  }

  func optionalString(_ key: String) -> String? {
    guard let value = self[key] else {
      return nil
    }
    if case .null = value {
      return nil
    }
    if case let .string(string) = value {
      return string
    }
    return nil
  }

  func requireBool(_ key: String) throws -> Bool {
    guard case let .bool(value) = try requireValue(key) else {
      throw DecodeError.message("expected bool for \(key)")
    }
    return value
  }

  func requireInt(_ key: String) throws -> Int {
    Int(try requireDouble(key))
  }

  func optionalInt(_ key: String) -> Int? {
    guard let value = self[key] else {
      return nil
    }
    if case .null = value {
      return nil
    }
    if case let .number(number) = value {
      return Int(number)
    }
    return nil
  }

  func requireDouble(_ key: String) throws -> Double {
    guard case let .number(value) = try requireValue(key) else {
      throw DecodeError.message("expected number for \(key)")
    }
    return value
  }

  func requireArray(_ key: String) throws -> [JSONValue] {
    guard case let .array(value) = try requireValue(key) else {
      throw DecodeError.message("expected array for \(key)")
    }
    return value
  }

  func optionalArray(_ key: String) throws -> [JSONValue]? {
    guard let value = self[key] else {
      return nil
    }
    if case .null = value {
      return nil
    }
    guard case let .array(array) = value else {
      throw DecodeError.message("expected array for \(key)")
    }
    return array
  }

  func optionalDecoded<T>(
    _ key: String,
    _ decoder: (JSONValue) throws -> T
  ) throws -> T? {
    guard let value = self[key] else {
      return nil
    }
    if case .null = value {
      return nil
    }
    return try decoder(value)
  }
}

private enum DecodeError: Error {
  case message(String)
}
