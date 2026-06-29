import Testing
import AppKit
import Foundation
@testable import ShotsyncCore

@Suite struct ThumbnailerTests {
  @Test func fitLandscape() {
    let r = fitDimensions(1000, 500, maxEdge: 480)
    #expect(r.w == 480); #expect(r.h == 240)
  }
  @Test func fitPortrait() {
    let r = fitDimensions(500, 1000, maxEdge: 480)
    #expect(r.w == 240); #expect(r.h == 480)
  }
  @Test func noUpscale() {
    let r = fitDimensions(300, 200, maxEdge: 480)
    #expect(r.w == 300); #expect(r.h == 200)
  }

  // Build a real 100x40 PNG in memory, then encode a <=20px thumbnail.
  private func samplePNG(w: Int, h: Int) -> Data {
    let img = NSImage(size: NSSize(width: w, height: h))
    img.lockFocus()
    NSColor.red.drawSwatch(in: NSRect(x: 0, y: 0, width: w, height: h))
    img.unlockFocus()
    let tiff = img.tiffRepresentation!
    let rep = NSBitmapImageRep(data: tiff)!
    return rep.representation(using: .png, properties: [:])!
  }

  @Test func encodeThumbnailProducesSmallerJPEG() {
    let png = samplePNG(w: 100, h: 40)
    let thumb = encodeThumbnailJPEG(pngData: png, maxEdge: 20, quality: 0.7)
    #expect(thumb != nil)
    let rep = NSBitmapImageRep(data: thumb!)!
    #expect(max(rep.pixelsWide, rep.pixelsHigh) == 20)
  }

  @Test func encodeThumbnailNilOnGarbage() {
    #expect(encodeThumbnailJPEG(pngData: Data([0, 1, 2]), maxEdge: 20, quality: 0.7) == nil)
  }
}
