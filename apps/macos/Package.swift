// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Remux",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "Remux", targets: ["Remux"]),
        .executable(name: "remux-bridge", targets: ["remux-bridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .executableTarget(
            name: "Remux",
            dependencies: ["SwiftTerm"],
            path: "Sources"
        ),
        .executableTarget(
            name: "remux-bridge",
            path: "Bridge",
            exclude: ["Package.swift"]
        ),
    ]
)
