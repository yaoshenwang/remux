import Foundation
import Testing
@testable import Remux

@Suite("AppCommand")
struct AppCommandTests {

    @Test("Window command only matches its target window")
    func windowCommandMatchesTargetWindow() {
        let command = WindowCommand(action: .splitRight, targetWindowNumber: 17)

        #expect(command.matches(windowNumber: 17))
        #expect(!command.matches(windowNumber: 18))
        #expect(!command.matches(windowNumber: nil))
    }

    @Test("Terminal command matches both window and leaf")
    func terminalCommandMatchesWindowAndLeaf() {
        let leafID = UUID()
        let command = TerminalCommand(
            action: .showSearch,
            targetWindowNumber: 42,
            leafID: leafID
        )

        #expect(command.matches(windowNumber: 42, leafID: leafID))
        #expect(!command.matches(windowNumber: 43, leafID: leafID))
        #expect(!command.matches(windowNumber: 42, leafID: UUID()))
    }
}
