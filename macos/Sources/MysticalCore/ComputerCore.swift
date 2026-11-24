import Foundation

/// The parts of computer use worth a unit test, free of AppKit and of the
/// window server: chords to key codes, screenshot pixels to screen points, which
/// app counts as granted, and how big a screenshot is. The app's ComputerUse.swift
/// does the posting and capturing; bridge/computer.py decides what is allowed.
public enum ComputerCore {
    // CGEventFlags raw values, so this module needs no CoreGraphics.
    public static let shift: UInt64 = 0x20000
    public static let control: UInt64 = 0x40000
    public static let option: UInt64 = 0x80000
    public static let command: UInt64 = 0x100000
    public static let function: UInt64 = 0x800000

    static let modifiers: [String: UInt64] = [
        "shift": shift, "ctrl": control, "control": control, "alt": option, "option": option, "opt": option,
        "cmd": command, "command": command, "super": command, "meta": command, "win": command,
        "fn": function,
    ]

    /// macOS virtual key codes (ANSI layout) for the names Claude sends.
    static let keys: [String: UInt16] = {
        var k: [String: UInt16] = [
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
            "escape": 53, "esc": 53, "forwarddelete": 117, "home": 115, "end": 119,
            "pageup": 116, "page_up": 116, "pagedown": 121, "page_down": 121,
            "left": 123, "right": 124, "down": 125, "up": 126,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
            "f9": 101, "f10": 109, "f11": 103, "f12": 111,
            "-": 27, "minus": 27, "=": 24, "equal": 24, "[": 33, "]": 30, ";": 41, "'": 39,
            ",": 43, "comma": 43, ".": 47, "period": 47, "/": 44, "slash": 44, "\\": 42, "`": 50,
        ]
        let letters: [(String, UInt16)] = [
            ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8),
            ("v", 9), ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17),
            ("o", 31), ("u", 32), ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("k", 40), ("n", 45),
            ("m", 46),
            ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("9", 25), ("7", 26),
            ("8", 28), ("0", 29),
        ]
        for (n, c) in letters { k[n] = c }
        return k
    }()

    public struct Chord: Equatable {
        public let key: UInt16?      // nil: modifiers alone (e.g. "shift" to hold)
        public let flags: UInt64
        public let modifierKeys: [UInt16]
    }

    static let modifierKeyCode: [UInt64: UInt16] = [shift: 56, control: 59, option: 58, command: 55, function: 63]

    /// "cmd+shift+a" → key 0 with command|shift. Nil when a part isn't a key we know.
    public static func chord(_ text: String) -> Chord? {
        let parts = text.split(separator: "+", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        guard !parts.isEmpty, !(parts.count == 1 && parts[0].isEmpty) else { return nil }
        var flags: UInt64 = 0
        var key: UInt16?
        var mods: [UInt16] = []
        for p in parts where !p.isEmpty {
            if let m = modifiers[p] {
                flags |= m
                if let code = modifierKeyCode[m] { mods.append(code) }
            } else if let k = keys[p], key == nil {
                key = k
            } else {
                return nil
            }
        }
        if key == nil && flags == 0 { return nil }
        return Chord(key: key, flags: flags, modifierKeys: mods)
    }

    /// The size a screenshot is sent at: the display's pixels scaled down so the
    /// long edge is at most 1568 and the whole at most ~1.15 megapixels (what
    /// the model reads best), never up.
    public static func shotSize(width: Double, height: Double) -> (Int, Int) {
        guard width > 0, height > 0 else { return (0, 0) }
        let s = min(1, 1568 / max(width, height), (1_150_000 / (width * height)).squareRoot())
        return (Int((width * s).rounded()), Int((height * s).rounded()))
    }

    /// A point in the last screenshot (pixels) → global screen points, for a
    /// screenshot of a display at `origin` that is `points` big. Clamped to it.
    public static func toScreen(x: Double, y: Double, image: (Int, Int),
                                origin: (Double, Double), points: (Double, Double)) -> (Double, Double) {
        guard image.0 > 0, image.1 > 0 else { return (origin.0 + x, origin.1 + y) }
        let px = min(max(x, 0), Double(image.0 - 1)), py = min(max(y, 0), Double(image.1 - 1))
        return (origin.0 + px * points.0 / Double(image.0), origin.1 + py * points.1 / Double(image.1))
    }

    /// The inverse, for cursor_position.
    public static func toImage(x: Double, y: Double, image: (Int, Int),
                               origin: (Double, Double), points: (Double, Double)) -> (Int, Int) {
        guard points.0 > 0, points.1 > 0 else { return (Int(x), Int(y)) }
        return (Int(((x - origin.0) * Double(image.0) / points.0).rounded()),
                Int(((y - origin.1) * Double(image.1) / points.1).rounded()))
    }

    /// Whether an app is one of `granted`, by its name or bundle id, any case.
    public static func granted(_ granted: [String], name: String?, bundle: String?) -> Bool {
        let n = (name ?? "").lowercased(), b = (bundle ?? "").lowercased()
        return granted.contains {
            let g = $0.lowercased()
            return (!n.isEmpty && g == n) || (!b.isEmpty && g == b)
        }
    }

    /// Text split for typing: runs of at most 20 UTF-16 units (what one key
    /// event carries), with each newline as its own Return.
    public static func typingRuns(_ text: String) -> [String] {
        var out: [String] = []
        var cur = ""
        for ch in text {
            if ch == "\n" || ch == "\r\n" {
                if !cur.isEmpty { out.append(cur); cur = "" }
                out.append("\n")
            } else {
                // Never an empty run: typed, it is key code 0 with no text, which is "a".
                if !cur.isEmpty, cur.utf16.count + String(ch).utf16.count > 20 { out.append(cur); cur = "" }
                cur.append(ch)
            }
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    /// The dashboard token from the URL the window loads (`?token=`).
    public static func token(from url: URL?) -> String? {
        guard let url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        return items.first { $0.name == "token" }?.value
    }
}
