import Foundation
import AppKit
import ImageIO
import UniformTypeIdentifiers

public enum ShotsyncCore {
  public static let version = "0.1.0"
}

/// Scale (w, h) to fit within maxEdge (long dimension only), with no upscaling.
/// Returns integer dimensions preserving aspect ratio.
public func fitDimensions(_ w: Int, _ h: Int, maxEdge: Int) -> (w: Int, h: Int) {
  let longEdge = max(w, h)
  if longEdge <= maxEdge { return (w, h) }
  let scale = Double(maxEdge) / Double(longEdge)
  return (Int((Double(w) * scale).rounded()), Int((Double(h) * scale).rounded()))
}

/// Decode PNG, downscale via fitDimensions, encode as JPEG.
/// Returns nil if PNG is undecodable or encoding fails.
public func encodeThumbnailJPEG(pngData: Data, maxEdge: Int, quality: CGFloat) -> Data? {
  guard let src = CGImageSourceCreateWithData(pngData as CFData, nil),
        let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
  let dims = fitDimensions(cg.width, cg.height, maxEdge: maxEdge)
  guard let ctx = CGContext(
    data: nil, width: dims.w, height: dims.h, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.interpolationQuality = .high
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: dims.w, height: dims.h))
  guard let scaled = ctx.makeImage() else { return nil }
  let out = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(
    out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
  CGImageDestinationAddImage(dest, scaled, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return nil }
  return out as Data
}
