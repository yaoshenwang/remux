// swift-tools-version: 6.0

import PackageDescription

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
