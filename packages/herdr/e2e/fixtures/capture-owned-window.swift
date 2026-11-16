// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import AppKit
import CoreGraphics
import ScreenCaptureKit

guard CommandLine.arguments.count == 4, let pid = Int32(CommandLine.arguments[1]), pid > 0,
      NSRunningApplication(processIdentifier: pid)?.bundleURL?.path == CommandLine.arguments[2] else { exit(2) }
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
guard CGPreflightScreenCaptureAccess() else {
    fputs("Existing window-capture permission is unavailable; no permission was requested.\n", stderr)
    exit(3)
}
Task { @MainActor in
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let window = content.windows.filter({ $0.owningApplication?.processID == pid && $0.windowLayer == 0 })
            .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { exit(4) }
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width)
        config.height = Int(window.frame.height)
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { exit(5) }
        try png.write(to: URL(fileURLWithPath: CommandLine.arguments[3]), options: .atomic)
        print("Captured only owned PID \(pid), window \(window.windowID).")
        exit(0)
    } catch {
        fputs("Owned-window capture failed: \(error)\n", stderr)
        exit(6)
    }
}
RunLoop.main.run()
