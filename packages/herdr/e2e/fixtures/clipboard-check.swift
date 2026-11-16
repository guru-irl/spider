// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import Foundation
import AppKit

let pasteboard = NSPasteboard.general
let original = (pasteboard.pasteboardItems ?? []).map { item in
  Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } })
}
let before = pasteboard.changeCount
let command = Process()
command.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
command.arguments = ["do", "spider-panel.refresh"]
let output = Pipe(), errors = Pipe()
command.standardOutput = output
command.standardError = errors
try command.run()
let stdout = output.fileHandleForReading.readDataToEndOfFile()
let stderr = errors.fileHandleForReading.readDataToEndOfFile()
command.waitUntilExit()
let until = Date().addingTimeInterval(5)
while pasteboard.string(forType: .string) != "spider-native-clipboard-canary" && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.025)) }
let observed = pasteboard.string(forType: .string) == "spider-native-clipboard-canary"
let changed = pasteboard.changeCount != before
var restored = false
if observed {
  pasteboard.clearContents()
  let items = original.map { values in
    let item = NSPasteboardItem()
    for (type, data) in values { item.setData(data, forType: type) }
    return item
  }
  if !items.isEmpty { pasteboard.writeObjects(items) }
  let actual = (pasteboard.pasteboardItems ?? []).map { item in
    Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } })
  }
  restored = actual == original
} else {
  restored = !changed
}
let receipt: [String: Any] = ["exitCode": Int(command.terminationStatus), "wrote": observed, "restored": restored, "changed": changed, "initialItems": original.count, "outputBytes": stdout.count, "errorBytes": stderr.count, "error": String(data: stderr, encoding: .utf8) ?? ""]
print(String(data: try JSONSerialization.data(withJSONObject: receipt), encoding: .utf8)!)
