// swift-tools-version:6.1
import PackageDescription

let package = Package(
  name: "shotsync",
  platforms: [.macOS(.v13)],
  targets: [
    .target(
      name: "ShotsyncCore"
    ),
    .executableTarget(
      name: "shotsync",
      dependencies: ["ShotsyncCore"]
    ),
    .testTarget(
      name: "ShotsyncCoreTests",
      dependencies: ["ShotsyncCore"]
    ),
  ]
)
