import Testing
import Foundation
@testable import ShotsyncCore

@Suite struct DedupTests {
  @Test func markThenDetected() throws {
    let tmp = NSTemporaryDirectory() + "shotsync-dedup-\(UUID().uuidString).png"
    try Data([1, 2, 3]).write(to: URL(fileURLWithPath: tmp))
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    #expect(!isUploaded(tmp))
    #expect(markUploaded(tmp))
    #expect(isUploaded(tmp))
  }

  @Test func unmarkedFileNotDetected() throws {
    let tmp = NSTemporaryDirectory() + "shotsync-dedup-\(UUID().uuidString).png"
    try Data([1]).write(to: URL(fileURLWithPath: tmp))
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    #expect(!isUploaded(tmp))
  }
}
