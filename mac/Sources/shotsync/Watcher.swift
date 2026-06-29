import Foundation
import CoreServices

final class Watcher {
  private let folder: String
  private let onNewFile: (String) -> Void
  private var stream: FSEventStreamRef?

  init(folder: String, onNewFile: @escaping (String) -> Void) {
    self.folder = folder
    self.onNewFile = onNewFile
  }

  func start() {
    var ctx = FSEventStreamContext(version: 0,
      info: Unmanaged.passUnretained(self).toOpaque(),
      retain: nil, release: nil, copyDescription: nil)
    let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
      let me = Unmanaged<Watcher>.fromOpaque(info!).takeUnretainedValue()
      let arr = unsafeBitCast(paths, to: NSArray.self) as! [String]
      for p in arr where p.lowercased().hasSuffix(".png") {
        me.handleCandidate(p)
      }
    }
    stream = FSEventStreamCreate(kCFAllocatorDefault, callback, &ctx,
      [folder] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
      0.5, UInt32(kFSEventStreamCreateFlagFileEvents))
    if let stream {
      FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
      FSEventStreamStart(stream)
    }
  }

  func stop() {
    if let stream {
      FSEventStreamStop(stream)
      FSEventStreamInvalidate(stream)
      FSEventStreamRelease(stream)
      self.stream = nil
    }
  }

  // Wait for the file size to stop changing (screenshot finished writing) before emitting.
  private func handleCandidate(_ path: String) {
    let size1 = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
      let size2 = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? -1
      if size1 == size2 && size2 > 0 { self.onNewFile(path) }
    }
  }
}
