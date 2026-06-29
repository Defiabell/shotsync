import Foundation
import Security

enum Config {
  private static let defaults = UserDefaults.standard
  private static let kBaseURL = "baseURL"
  private static let kOriginalDir = "originalScreenshotDir"
  private static let service = "shotsync"
  private static let account = "auth-token"

  static var baseURL: URL? {
    get { defaults.string(forKey: kBaseURL).flatMap(URL.init(string:)) }
    set { defaults.set(newValue?.absoluteString, forKey: kBaseURL) }
  }

  static var originalScreenshotDir: String? {
    get { defaults.string(forKey: kOriginalDir) }
    set { defaults.set(newValue, forKey: kOriginalDir) }
  }

  static func token() -> String? {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
          let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func setToken(_ value: String) {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(base as CFDictionary)
    var add = base
    add[kSecValueData as String] = Data(value.utf8)
    SecItemAdd(add as CFDictionary, nil)
  }
}
