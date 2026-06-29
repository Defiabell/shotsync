import Foundation

/// Represents a single item in the upload queue.
public struct QueueItem: Codable, Equatable {
  public let path: String
  public var attempts: Int

  public init(path: String, attempts: Int = 0) {
    self.path = path
    self.attempts = attempts
  }
}

/// Persistent upload queue with capped exponential backoff.
/// Stores items as JSON on disk and survives reload.
public final class UploadQueue {
  private let fileURL: URL
  private var items: [QueueItem]
  private let lock = NSLock()

  /// Initialize queue from disk (loads existing items if file exists).
  public init(fileURL: URL) {
    self.fileURL = fileURL
    if let data = try? Data(contentsOf: fileURL),
       let decoded = try? JSONDecoder().decode([QueueItem].self, from: data) {
      self.items = decoded
    } else {
      self.items = []
    }
  }

  /// Persist current queue to disk.
  private func persist() {
    if let data = try? JSONEncoder().encode(items) {
      try? data.write(to: fileURL)
    }
  }

  /// Append path to queue if not already present (deduplicates).
  public func enqueue(_ path: String) {
    lock.lock(); defer { lock.unlock() }
    guard !items.contains(where: { $0.path == path }) else { return }
    items.append(QueueItem(path: path))
    persist()
  }

  /// Return all queued items.
  public func all() -> [QueueItem] {
    lock.lock(); defer { lock.unlock() }
    return items
  }

  /// Remove item by path.
  public func remove(_ path: String) {
    lock.lock(); defer { lock.unlock() }
    items.removeAll { $0.path == path }
    persist()
  }

  /// Record a failure for a path (increments attempts).
  public func recordFailure(_ path: String) {
    lock.lock(); defer { lock.unlock() }
    if let i = items.firstIndex(where: { $0.path == path }) {
      items[i].attempts += 1
      persist()
    }
  }

  /// Compute backoff seconds: 2^attempts, capped at 300.
  public static func backoffSeconds(attempts: Int) -> Int {
    // Cap before converting to Int: pow can return +inf for huge attempts and
    // Int(+inf) traps. Comparing the Double first avoids that.
    let raw = pow(2.0, Double(attempts))
    return raw >= 300 ? 300 : Int(raw)
  }
}
