import Testing
import Foundation
@testable import ShotsyncCore

@Suite struct UploadQueueTests {
  private func tmpURL() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory() + "shotsync-q-\(UUID().uuidString).json")
  }

  @Test func enqueueDedupesAndPersists() {
    let url = tmpURL(); defer { try? FileManager.default.removeItem(at: url) }
    let q = UploadQueue(fileURL: url)
    q.enqueue("/a.png"); q.enqueue("/a.png"); q.enqueue("/b.png")
    #expect(q.all().map(\.path) == ["/a.png", "/b.png"])
    // reload from disk
    let q2 = UploadQueue(fileURL: url)
    #expect(q2.all().map(\.path) == ["/a.png", "/b.png"])
  }

  @Test func removeAndFailure() {
    let url = tmpURL(); defer { try? FileManager.default.removeItem(at: url) }
    let q = UploadQueue(fileURL: url)
    q.enqueue("/a.png")
    q.recordFailure("/a.png")
    #expect(q.all().first?.attempts == 1)
    q.remove("/a.png")
    #expect(q.all().isEmpty)
  }

  @Test func backoffCappedAt300() {
    #expect(UploadQueue.backoffSeconds(attempts: 0) == 1)
    #expect(UploadQueue.backoffSeconds(attempts: 3) == 8)
    #expect(UploadQueue.backoffSeconds(attempts: 20) == 300)
  }
}
