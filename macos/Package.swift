// swift-tools-version:5.9
//
// Mystical.app — the native macOS shell around the dashboard. System frameworks
// only (AppKit, WebKit, UserNotifications), so it builds with the Swift in the
// Command Line Tools: no Xcode, no packages to fetch. `build.sh` turns the
// executable into a bundle; see docs/superpowers/specs/macos-app-design.md.
import PackageDescription

let package = Package(
    name: "Mystical",
    platforms: [.macOS(.v14)],   // WKPreferences.inactiveSchedulingPolicy
    targets: [
        // Everything worth a unit test, kept free of AppKit so `swift test` can
        // exercise it without a window server.
        .target(name: "MysticalCore"),
        .executableTarget(name: "Mystical", dependencies: ["MysticalCore"]),
        .testTarget(name: "MysticalCoreTests", dependencies: ["MysticalCore"]),
    ]
)
