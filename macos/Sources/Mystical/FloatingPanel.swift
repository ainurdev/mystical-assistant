import AppKit
import MysticalCore

/// The WAITING ON YOU panel: a small always-on-top list of the sessions blocked
/// on you, on every Space, shown while the dashboard isn't the key window — the
/// menu bar count, but readable from the app you're actually in. Click a row to
/// open that session. Non-activating, so it never takes focus; borderless and
/// movable by its body; its frame is remembered.
///
/// HIDE, at the header's right end, puts it away until something new needs you
/// (the rule: MysticalCore/PanelHide.swift). It is remembered like the frame,
/// and turning PANEL off and on again shows the panel. A word, at rest too: a
/// dash reads as "shrink to a chip", which this doesn't do, and a control that
/// shows only on hover can't be found. No "show panel" control: the menu bar
/// and Dock menus list the rows meanwhile.
@MainActor
final class FloatingPanel {
    private let panel: NSPanel
    private let stack = NSStackView()
    private let onOpen: (String) -> Void
    private var shown: [WaitingSession] = []
    /// The last good poll's turns: what HIDE records each row against.
    private var turns: [String: String] = [:]
    private var hide = PanelHide.load(.standard) {
        didSet { if hide != oldValue { PanelHide.save(hide, .standard) } }
    }

    init(onOpen: @escaping (String) -> Void) {
        self.onOpen = onOpen
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 60),
                        styleMask: [.nonactivatingPanel, .borderless],
                        backing: .buffered, defer: false)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        // The panel is up while you're in another app: without this no tooltip shows.
        panel.allowsToolTipsWhenApplicationIsInactive = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false

        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = Placeholder.ground.withAlphaComponent(0.96).cgColor
        card.layer?.cornerRadius = 10
        card.layer?.borderWidth = 1
        card.layer?.borderColor = Placeholder.teal.withAlphaComponent(0.3).cgColor
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            stack.topAnchor.constraint(equalTo: card.topAnchor),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])
        panel.contentView = card
        // First run: top-right of the main screen; afterwards, where you left it.
        if !panel.setFrameUsingName("Floating"), let screen = NSScreen.main {
            let v = screen.visibleFrame
            panel.setFrameTopLeftPoint(NSPoint(x: v.maxX - 300 - 12, y: v.maxY - 12))
        }
        panel.setFrameAutosaveName("Floating")
    }

    /// `show` is the switch; the panel also hides when nothing waits, the
    /// dashboard itself is in front (you can see the list there), or you pressed
    /// HIDE and nothing new has come. `turns` is nil after a failed poll.
    func update(_ waiting: [WaitingSession], turns: [String: String]?, show: Bool, dashboardInFront: Bool) {
        if !show {
            hide = nil   // PANEL off, then on: the panel is back
        } else {
            if let turns { self.turns = turns }
            hide = hide?.after(waiting, turns: turns, dashboardInFront: dashboardInFront)
        }
        if waiting != shown { rebuild(waiting) }
        if show && hide == nil && !waiting.isEmpty && !dashboardInFront {
            panel.orderFrontRegardless()
        } else {
            panel.orderOut(nil)
        }
    }

    private func rebuild(_ waiting: [WaitingSession]) {
        shown = waiting
        stack.views.forEach { $0.removeFromSuperview() }
        let mono = { (size: CGFloat, w: NSFont.Weight) in NSFont.monospacedSystemFont(ofSize: size, weight: w) }
        let head = NSTextField(labelWithString: "✦ WAITING ON YOU · \(waiting.count)")
        head.font = Self.headFont
        head.textColor = Self.headColor
        let top = NSStackView()
        top.alignment = .firstBaseline
        top.addView(head, in: .leading)
        top.addView(HideButton(target: self, action: #selector(hideClicked(_:))), in: .trailing)
        top.widthAnchor.constraint(equalToConstant: 276).isActive = true
        stack.addArrangedSubview(top)
        for w in waiting.prefix(6) {
            let b = NSButton(title: "▸ \(w.title)", target: self, action: #selector(rowClicked(_:)))
            b.isBordered = false
            b.alignment = .left
            b.font = mono(12, .regular)
            b.contentTintColor = Placeholder.teal
            b.toolTip = w.label
            b.identifier = NSUserInterfaceItemIdentifier(w.id)
            b.lineBreakMode = .byTruncatingTail
            b.widthAnchor.constraint(lessThanOrEqualToConstant: 276).isActive = true
            stack.addArrangedSubview(b)
        }
        if waiting.count > 6 {
            let more = NSTextField(labelWithString: "… and \(waiting.count - 6) more")
            more.font = mono(10, .regular)
            more.textColor = Placeholder.teal.withAlphaComponent(0.5)
            stack.addArrangedSubview(more)
        }
        // Grow downwards from a fixed top-left, so the panel stays where you put it.
        let size = NSSize(width: 300, height: stack.fittingSize.height)
        var f = panel.frame
        f.origin.y += f.height - size.height
        f.size = size
        panel.setFrame(f, display: true)
    }

    @objc private func rowClicked(_ sender: NSButton) {
        if let id = sender.identifier?.rawValue { onOpen(id) }
    }

    @objc private func hideClicked(_ sender: NSButton) {
        hide = PanelHide(shown, turns: turns)
        panel.orderOut(nil)
        // Gone under the pointer, so no mouseExited: it would come back hovered.
        (sender as? HideButton)?.style(hot: false)
    }

    /// The header's type, which HIDE shares.
    fileprivate static let headFont = NSFont.monospacedSystemFont(ofSize: 10, weight: .semibold)
    fileprivate static let headColor = Placeholder.teal.withAlphaComponent(0.6)
}

/// HIDE in the header's own type: teal at 0.6 at rest, full teal and underlined
/// under the pointer. It tracks the pointer itself, as the panel is never key.
private final class HideButton: NSButton {
    convenience init(target: AnyObject, action: Selector) {
        self.init(frame: .zero)
        self.target = target
        self.action = action
        isBordered = false
        toolTip = "Hide until something new needs you"
        setAccessibilityLabel("Hide")
        style(hot: false)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { style(hot: true) }
    override func mouseExited(with event: NSEvent) { style(hot: false) }

    func style(hot: Bool) {
        attributedTitle = NSAttributedString(string: "HIDE", attributes: [
            .font: FloatingPanel.headFont,
            .foregroundColor: hot ? Placeholder.teal : FloatingPanel.headColor,
            .underlineStyle: hot ? NSUnderlineStyle.single.rawValue : 0,
        ])
    }
}
