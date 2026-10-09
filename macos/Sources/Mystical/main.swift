import AppKit

// No nib, no storyboard: the menus and the window are built in code, which is
// what lets the whole app build with the Command Line Tools' swift.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
