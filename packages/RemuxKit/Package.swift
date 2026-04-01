// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "RemuxKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "RemuxKit",
            targets: ["RemuxKit"]
        ),
    ],
    targets: [
        .target(
            name: "RemuxKit",
            resources: [
                .copy("Terminal/Resources"),
            ]
        ),
        .testTarget(
            name: "RemuxKitTests",
            dependencies: ["RemuxKit"]
        ),
    ]
)
