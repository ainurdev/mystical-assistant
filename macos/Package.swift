// swift-tools-version:5.9
//
// Mystical.app — the native macOS shell around the dashboard. System frameworks
// only (AppKit, WebKit, UserNotifications), so it builds with the Swift in the
// Command Line Tools: no Xcode, no packages to fetch. `build.sh` turns the
// executable into a bundle; see docs/superpowers/specs/macos-app-design.md.
import Foundation
import PackageDescription

// With only the Command Line Tools installed, swift-build doesn't always hand
// the compiler Swift Testing's macro plugin ("plugin for module 'TestingMacros'
// not found" → `error: fatalError`). Point at it when it's there; Xcode
// toolchains find their own and skip this.
let cltTesting = "/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing"
let testingFlags: [SwiftSetting] = FileManager.default.fileExists(atPath: cltTesting)
    ? [.unsafeFlags(["-plugin-path", cltTesting])] : []

let package = Package(
    name: "Mystical",
    platforms: [.macOS(.v14)],   // WKPreferences.inactiveSchedulingPolicy
    targets: [
        // Everything worth a unit test, kept free of AppKit so `swift test` can
        // exercise it without a window server.
        .target(name: "MysticalCore"),
        .executableTarget(name: "Mystical", dependencies: ["MysticalCore"]),
        .testTarget(name: "MysticalCoreTests", dependencies: ["MysticalCore"],
                    swiftSettings: testingFlags),
    ]
)
