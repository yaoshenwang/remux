// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Remux",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../../packages/RemuxKit"),
    ],
    targets: [
        .executableTarget(
            name: "Remux",
            dependencies: ["RemuxKit", "GhosttyKit"],
            path: "Sources/Remux",
            linkerSettings: [
                .linkedFramework("Cocoa"),
                .linkedFramework("Metal"),
                .linkedFramework("MetalKit"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreText"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Foundation"),
                .linkedFramework("IOKit"),
                .linkedFramework("IOSurface"),
                .linkedFramework("UniformTypeIdentifiers"),
                .linkedLibrary("c++"),
                .linkedLibrary("z"),
            ]
        ),
        .binaryTarget(
            name: "GhosttyKit",
            path: "../../vendor/ghostty/macos/GhosttyKit.xcframework"
        ),
    ]
)
