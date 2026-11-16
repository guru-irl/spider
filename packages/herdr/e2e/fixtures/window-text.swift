// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import Foundation
import Vision
import ImageIO

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: image).perform([request])
let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
let data = try JSONSerialization.data(withJSONObject: text)
print(String(data: data, encoding: .utf8)!)
