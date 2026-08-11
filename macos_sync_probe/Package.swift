// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "NotAloneSyncProbe",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(
            name: "NotAloneSyncCore",
            targets: ["NotAloneSyncCore"]
        ),
        .executable(
            name: "notalone-sync-probe",
            targets: ["NotAloneSyncCLI"]
        ),
    ],
    targets: [
        .target(
            name: "NotAloneSyncCore",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Vision"),
            ]
        ),
        .executableTarget(
            name: "NotAloneSyncCLI",
            dependencies: ["NotAloneSyncCore"]
        ),
        .executableTarget(
            name: "NotAloneSyncApp",
            dependencies: ["NotAloneSyncCore"]
        ),
        .testTarget(
            name: "NotAloneSyncProbeTests",
            dependencies: ["NotAloneSyncCore"]
        ),
    ]
)
