import Testing
import Foundation
@testable import ShotsyncCore

final class FakeBackend: DefaultsBackend {
  var current: String?
  var applied = 0
  func read() -> String? { current }
  func write(_ value: String) { current = value }
  func clear() { current = nil }
  func applyChange() { applied += 1 }
}

@Suite struct ScreenshotDirTests {
  @Test func redirectSavesOriginalOnce() {
    let be = FakeBackend(); be.current = "/Users/me/Desktop"
    var saved: String?? = nil // outer optional = "has been set"
    let mgr = ScreenshotDirManager(
      backend: be,
      savedOriginal: { saved ?? nil },
      setSavedOriginal: { saved = .some($0) })

    mgr.redirect(to: "/Users/me/Pictures/shotsync")
    #expect(be.current == "/Users/me/Pictures/shotsync")
    #expect((saved ?? nil) == "/Users/me/Desktop") // original captured
    #expect(be.applied == 1)

    // second redirect must NOT overwrite the saved original
    be.current = "/Users/me/Pictures/shotsync"
    mgr.redirect(to: "/Users/me/Pictures/other")
    #expect((saved ?? nil) == "/Users/me/Desktop")
  }

  @Test func restoreWritesBackOriginalAndClears() {
    let be = FakeBackend(); be.current = "/Users/me/Pictures/shotsync"
    var saved: String?? = .some("/Users/me/Desktop")
    let mgr = ScreenshotDirManager(
      backend: be,
      savedOriginal: { saved ?? nil },
      setSavedOriginal: { saved = .some($0) })

    mgr.restore()
    #expect(be.current == "/Users/me/Desktop")
    #expect((saved ?? nil) == nil)            // saved cleared after restore
    #expect(be.applied == 1)
  }

  @Test func restoreWithDefaultOriginalClearsBackend() {
    let be = FakeBackend(); be.current = "/Users/me/Pictures/shotsync"
    var saved: String?? = .some(nil)      // original WAS the default (no explicit value)
    let mgr = ScreenshotDirManager(
      backend: be,
      savedOriginal: { saved ?? nil },
      setSavedOriginal: { saved = .some($0) })

    mgr.restore()
    #expect(be.current == nil)            // cleared back to default
    #expect(be.applied == 1)
  }
}
