// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "remux-bridge",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "remux-bridge",
            path: ".",
            exclude: ["Package.swift"]
        ),
    ]
)
