import Foundation

public protocol DefaultsBackend {
  func read() -> String?
  func write(_ value: String)
  func clear()
  func applyChange()
}

public final class ScreenshotDirManager {
  private let backend: DefaultsBackend
  private let savedOriginal: () -> String?
  private let setSavedOriginal: (String?) -> Void
  private var hasSaved: Bool = false

  public init(backend: DefaultsBackend,
              savedOriginal: @escaping () -> String?,
              setSavedOriginal: @escaping (String?) -> Void) {
    self.backend = backend
    self.savedOriginal = savedOriginal
    self.setSavedOriginal = setSavedOriginal
  }

  public func redirect(to folder: String) {
    // Save the original value only on the first redirect.
    if !hasSaved {
      setSavedOriginal(backend.read())  // nil means "was the default"
      hasSaved = true
    }
    // Write the new folder path and apply the change.
    backend.write(folder)
    backend.applyChange()
  }

  public func restore() {
    // Restore the saved original, or clear if it was nil (the default).
    if let original = savedOriginal() {
      backend.write(original)
    } else {
      backend.clear()
    }
    // Apply the change and clear the saved state.
    backend.applyChange()
    setSavedOriginal(nil)
    hasSaved = false
  }
}
