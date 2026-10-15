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
        .target(
            name: "SessionEventDiagnostics",
            path: "Diagnostics",
            exclude: ["SessionEventCapabilities.swift", "SessionEventPreview.swift"],
            sources: ["SessionEventEvidence.swift"]
        ),
        .testTarget(
            name: "SessionEventDiagnosticsTests",
            dependencies: ["SessionEventDiagnostics"]
        ),
        .testTarget(
            name: "NotAloneSyncProbeTests",
            dependencies: ["NotAloneSyncCore"]
        ),
    ]
)
