import Foundation

/// Builds a multipart POST request for uploading image data to the API.
/// - Parameters:
///   - baseURL: The base API URL (e.g., https://example.workers.dev)
///   - token: Bearer token for Authorization header
///   - filename: Name to include in X-Filename header
///   - full: Full-resolution image data (PNG)
///   - thumb: Optional thumbnail image data (JPEG)
///   - boundary: MIME boundary string for multipart encoding
/// - Returns: A fully configured URLRequest for POST /api/upload
public func buildUploadRequest(
  baseURL: URL, token: String, filename: String,
  full: Data, thumb: Data?, boundary: String
) -> URLRequest {
  var req = URLRequest(url: baseURL.appendingPathComponent("api/upload"))
  req.httpMethod = "POST"
  req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
  req.setValue("mac", forHTTPHeaderField: "X-Source")
  req.setValue(filename, forHTTPHeaderField: "X-Filename")
  req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

  var body = Data()
  func appendPart(name: String, contentType: String, fileName: String, data: Data) {
    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
    body.append("Content-Type: \(contentType)\r\n\r\n".data(using: .utf8)!)
    body.append(data)
    body.append("\r\n".data(using: .utf8)!)
  }
  appendPart(name: "full", contentType: "image/png", fileName: filename, data: full)
  if let thumb { appendPart(name: "thumb", contentType: "image/jpeg", fileName: "thumb.jpg", data: thumb) }
  body.append("--\(boundary)--\r\n".data(using: .utf8)!)
  req.httpBody = body
  return req
}
