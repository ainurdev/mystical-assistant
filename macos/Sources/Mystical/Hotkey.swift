import Carbon.HIToolbox

/// The summon shortcut, ⌃⌘A from any app (SETTINGS ▸ MAC APP), the Mac twin of
/// the Windows app's Win+Ctrl+A. Carbon's RegisterEventHotKey because it's the
/// one system hot key API that needs no Accessibility permission (NSEvent's
/// global monitor does), and a key it holds never reaches another app.
@MainActor
final class Hotkey {
    private var ref: EventHotKeyRef?
    // Carbon calls back with no context to capture, on the main thread: the action lives here.
    private static var pressed: (() -> Void)?

    init(_ pressed: @escaping () -> Void) {
        Hotkey.pressed = pressed
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            MainActor.assumeIsolated { Hotkey.pressed?() }
            return noErr
        }, 1, &spec, nil, nil)
    }

    /// On holds ⌃⌘A, off lets it go; asking for what's already so does nothing.
    func set(_ on: Bool) {
        guard on != (ref != nil) else { return }
        if let held = ref {
            UnregisterEventHotKey(held)
            ref = nil
            return
        }
        let id = EventHotKeyID(signature: OSType(0x4D59_5354), id: 1)  // "MYST"
        // Another app holding ⌃⌘A already: the switch stays on and the key does nothing.
        if RegisterEventHotKey(UInt32(kVK_ANSI_A), UInt32(cmdKey | controlKey), id,
                               GetApplicationEventTarget(), 0, &ref) != noErr {
            ref = nil
        }
    }
}
