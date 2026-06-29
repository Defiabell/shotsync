import Testing
import Foundation
@testable import ShotsyncCore

@Suite struct UploadRequestTests {
  @Test func requestHeadersAndURL() {
    let req = buildUploadRequest(
      baseURL: URL(string: "https://example.workers.dev")!,
      token: "secret", filename: "Shot.png",
      full: Data([1, 2, 3]), thumb: Data([9]), boundary: "BOUND")
    #expect(req.url?.absoluteString == "https://example.workers.dev/api/upload")
    #expect(req.httpMethod == "POST")
    #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
    #expect(req.value(forHTTPHeaderField: "X-Source") == "mac")
    #expect(req.value(forHTTPHeaderField: "X-Filename") == "Shot.png")
    #expect(req.value(forHTTPHeaderField: "Content-Type") == "multipart/form-data; boundary=BOUND")
  }

  @Test func bodyContainsBothParts() {
    let req = buildUploadRequest(
      baseURL: URL(string: "https://x")!, token: "t", filename: "a.png",
      full: Data("FULL".utf8), thumb: Data("THUMB".utf8), boundary: "B")
    let body = String(data: req.httpBody!, encoding: .utf8)!
    #expect(body.contains("name=\"full\""))
    #expect(body.contains("image/png"))
    #expect(body.contains("name=\"thumb\""))
    #expect(body.contains("image/jpeg"))
    #expect(body.contains("--B--"))   // closing boundary
  }

  @Test func omitsThumbWhenNil() {
    let req = buildUploadRequest(
      baseURL: URL(string: "https://x")!, token: "t", filename: "a.png",
      full: Data("FULL".utf8), thumb: nil, boundary: "B")
    let body = String(data: req.httpBody!, encoding: .utf8)!
    #expect(!body.contains("name=\"thumb\""))
    #expect(body.contains("name=\"full\""))
  }
}
