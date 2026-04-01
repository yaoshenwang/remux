// swift-tools-version: 6.0

import PackageDescription

// NOTE: iOS apps cannot be built with `swift build` (SPM limitation).
// Build with: xcodebuild -scheme Remux -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
// This Package.swift is used by Xcode for SPM dependency resolution only.
let package = Package(
    name: "RemuxiOS",
    platforms: [.iOS(.v17)],
    dependencies: [
        .package(path: "../../packages/RemuxKit"),
    ],
    targets: [
        .executableTarget(
            name: "RemuxiOS",
            dependencies: ["RemuxKit"],
            path: "Sources/Remux",
            linkerSettings: [
                .linkedFramework("UIKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("WebKit"),
            ]
        ),
    ]
)
