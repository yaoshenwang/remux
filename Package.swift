// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "remux",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "remux", targets: ["remux"])
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0")
    ],
    targets: [
        .executableTarget(
            name: "remux",
            dependencies: ["SwiftTerm"],
            path: "Sources"
        )
    ]
)
