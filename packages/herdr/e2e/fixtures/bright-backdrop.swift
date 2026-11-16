// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import AppKit
import CoreGraphics

final class BrightPattern: NSView {
    override func draw(_ dirty: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        for row in 0...Int(bounds.height / 40) {
            for col in 0...Int(bounds.width / 60) where (row + col) % 2 == 0 {
                NSColor(white: 0.72, alpha: 1).setFill()
                NSRect(x: col * 60, y: row * 40, width: 60, height: 40).fill()
            }
        }
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 14, weight: .regular), .foregroundColor: NSColor.black]
        for row in 0...Int(bounds.height / 80) {
            ("Bright owned backdrop - text and alternating light tiles" as NSString).draw(at: NSPoint(x: 12, y: row * 80 + 10), withAttributes: attributes)
        }
    }
}

guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[1]),
      let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]],
      let target = windows.filter({ ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 })
        .max(by: { a, b in
            let x = a[kCGWindowBounds as String] as? [String: CGFloat] ?? [:], y = b[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
            return (x["Width"] ?? 0) * (x["Height"] ?? 0) < (y["Width"] ?? 0) * (y["Height"] ?? 0)
        }),
      let id = target[kCGWindowNumber as String] as? Int,
      let box = target[kCGWindowBounds as String] as? [String: CGFloat],
      let x = box["X"], let y = box["Y"], let width = box["Width"], let height = box["Height"], width > 100, height > 100
else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let top = NSScreen.screens.first?.frame.maxY ?? 0
let frame = NSRect(x: x, y: top - y - height, width: width, height: height)
let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.hasShadow = false
panel.isOpaque = true
panel.hidesOnDeactivate = false
panel.ignoresMouseEvents = true
panel.contentView = BrightPattern(frame: NSRect(origin: .zero, size: frame.size))
panel.order(.below, relativeTo: id)
let receipt: [String: Any] = ["ready": true, "targetPid": pid, "targetWindow": id, "backdropWindow": panel.windowNumber, "brightest": "#ffffff", "pattern": "#b8b8b8", "activation": "accessory with nonactivating panel"]
try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
app.run()
