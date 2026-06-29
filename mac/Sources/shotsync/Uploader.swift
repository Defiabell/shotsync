import Foundation
import ShotsyncCore

final class Uploader {
  private let queue: UploadQueue
  private let session = URLSession(configuration: .default)
  init(queue: UploadQueue) { self.queue = queue }

  func upload(path: String, completion: @escaping (Bool) -> Void) {
    guard !isUploaded(path) else { completion(true); return }
    guard let baseURL = Config.baseURL, let token = Config.token() else { completion(false); return }
    guard let full = try? Data(contentsOf: URL(fileURLWithPath: path)) else { completion(false); return }
    let thumb = encodeThumbnailJPEG(pngData: full, maxEdge: 480, quality: 0.7)
    let filename = (path as NSString).lastPathComponent
    let boundary = "shotsync-\(UUID().uuidString)"
    let req = buildUploadRequest(baseURL: baseURL, token: token, filename: filename,
                                 full: full, thumb: thumb, boundary: boundary)
    session.dataTask(with: req) { _, resp, _ in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
      if ok { _ = markUploaded(path); self.queue.remove(path) }
      else { self.queue.recordFailure(path) }
      completion(ok)
    }.resume()
  }

  func enqueueAndUpload(_ path: String) { queue.enqueue(path); upload(path: path) { _ in } }

  func drainQueue() {
    for item in queue.all() { upload(path: item.path) { _ in } }
  }
}
