// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "NotAloneApp",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(
            name: "NotAloneAppCore",
            targets: ["NotAloneAppCore"]
        ),
        .executable(
            name: "NotAloneApp",
            targets: ["NotAloneApp"]
        ),
    ],
    targets: [
        .target(
            name: "NotAloneAppCore"
        ),
        .executableTarget(
            name: "NotAloneApp",
            dependencies: ["NotAloneAppCore"]
        ),
    ]
)