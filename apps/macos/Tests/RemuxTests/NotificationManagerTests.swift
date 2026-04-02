import Foundation
import Testing
@testable import Remux

@Suite("OSCNotificationParser")
struct OSCNotificationParserTests {

    @Test("Parses OSC 9 and OSC 99 notifications")
    func parsesOSC9And99() {
        let payload = "\u{1b}]9;Build complete\u{07}\u{1b}]99;Tests passed\u{07}"
        let parsed = OSCNotificationParser.parse(Data(payload.utf8))

        #expect(parsed == [
            OSCParsedNotification(title: "Terminal Notification", body: "Build complete"),
            OSCParsedNotification(title: "Terminal Notification", body: "Tests passed"),
        ])
    }

    @Test("Parses OSC 777 notifications with explicit title")
    func parsesOSC777() {
        let payload = "\u{1b}]777;notify;Deploy;Finished successfully\u{07}"
        let parsed = OSCNotificationParser.parse(Data(payload.utf8))

        #expect(parsed == [
            OSCParsedNotification(title: "Deploy", body: "Finished successfully"),
        ])
    }
}
