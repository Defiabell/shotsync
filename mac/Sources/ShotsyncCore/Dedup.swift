import Foundation

private let kAttr = "com.jinkun.shotsync.uploaded"

/// Marks a file as uploaded by setting an extended attribute.
/// - Parameter path: The filesystem path to the file.
/// - Returns: true if the attribute was set successfully, false otherwise.
public func markUploaded(_ path: String) -> Bool {
  let value: [UInt8] = [0x31] // "1"
  let rc = value.withUnsafeBytes { buf in
    setxattr(path, kAttr, buf.baseAddress, buf.count, 0, 0)
  }
  return rc == 0
}

/// Checks if a file is marked as uploaded.
/// - Parameter path: The filesystem path to the file.
/// - Returns: true if the extended attribute is present, false otherwise.
public func isUploaded(_ path: String) -> Bool {
  return getxattr(path, kAttr, nil, 0, 0, 0) >= 0
}
