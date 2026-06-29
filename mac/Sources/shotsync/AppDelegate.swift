import AppKit
import ShotsyncCore

final class SystemDefaultsBackend: DefaultsBackend {
  private func run(_ launch: String, _ args: [String]) {
    let p = Process(); p.executableURL = URL(fileURLWithPath: launch); p.arguments = args
    try? p.run(); p.waitUntilExit()
  }
  func read() -> String? {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
    p.arguments = ["read", "com.apple.screencapture", "location"]
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
    try? p.run(); p.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return (s?.isEmpty == false) ? s : nil
  }
  func write(_ value: String) { run("/usr/bin/defaults", ["write", "com.apple.screencapture", "location", value]) }
  func clear() { run("/usr/bin/defaults", ["delete", "com.apple.screencapture", "location"]) }
  func applyChange() { run("/usr/bin/killall", ["SystemUIServer"]) }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var watcher: Watcher?
  private var uploader: Uploader!
  private var dirManager: ScreenshotDirManager!
  private var paused = false
  private var todayCount = 0
  private let folder = NSHomeDirectory() + "/Pictures/shotsync"

  func applicationDidFinishLaunching(_ n: Notification) {
    let support = NSHomeDirectory() + "/Library/Application Support/shotsync"
    try? FileManager.default.createDirectory(atPath: support, withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    uploader = Uploader(queue: UploadQueue(fileURL: URL(fileURLWithPath: support + "/queue.json")))

    dirManager = ScreenshotDirManager(
      backend: SystemDefaultsBackend(),
      savedOriginal: { Config.originalScreenshotDir },
      setSavedOriginal: { Config.originalScreenshotDir = $0 })

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    rebuildMenu()

    if Config.baseURL == nil || Config.token() == nil { promptSettings() }
    confirmRedirectIfNeeded()
    startWatching()
    uploader.drainQueue()
  }

  private func startWatching() {
    watcher?.stop()
    watcher = Watcher(folder: folder) { [weak self] path in
      guard let self, !self.paused else { return }
      self.uploader.enqueueAndUpload(path)
      self.todayCount += 1
      self.rebuildMenu()
    }
    watcher?.start()
  }

  // Only capture the original location when we have NOT already redirected
  // (guards against re-capturing the shotsync folder as "original" on relaunch).
  private func confirmRedirectIfNeeded() {
    guard Config.originalScreenshotDir == nil else { return }
    let a = NSAlert()
    a.messageText = "Redirect screenshots to shotsync?"
    a.informativeText = "shotsync will set the system screenshot location to ~/Pictures/shotsync so only screenshots are synced. It restores your original location when you quit or choose “Restore default screenshot location”."
    a.addButton(withTitle: "Redirect"); a.addButton(withTitle: "Not now")
    if a.runModal() == .alertFirstButtonReturn { dirManager.redirect(to: folder) }
  }

  private func promptSettings() {
    let a = NSAlert(); a.messageText = "shotsync settings"
    a.informativeText = "Worker base URL and access token"
    let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 320, height: 54))
    stack.orientation = .vertical
    let urlField = NSTextField(string: Config.baseURL?.absoluteString ?? "https://")
    let tokenField = NSSecureTextField(string: Config.token() ?? "")
    urlField.frame = NSRect(x: 0, y: 28, width: 320, height: 22)
    tokenField.frame = NSRect(x: 0, y: 0, width: 320, height: 22)
    stack.addArrangedSubview(urlField); stack.addArrangedSubview(tokenField)
    a.accessoryView = stack
    a.addButton(withTitle: "Save"); a.addButton(withTitle: "Cancel")
    if a.runModal() == .alertFirstButtonReturn {
      if let u = URL(string: urlField.stringValue) { Config.baseURL = u }
      Config.setToken(tokenField.stringValue)
    }
  }

  private func rebuildMenu() {
    let menu = NSMenu()
    statusItem.button?.title = paused ? "⏸" : "●"
    menu.addItem(NSMenuItem(title: paused ? "Paused" : "Syncing", action: nil, keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Today: \(todayCount)", action: nil, keyEquivalent: ""))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: paused ? "Resume" : "Pause", action: #selector(togglePause), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Open gallery", action: #selector(openGallery), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Copy gallery link", action: #selector(copyLink), keyEquivalent: ""))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Settings…", action: #selector(settings), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Restore default screenshot location", action: #selector(restoreDir), keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Quit shotsync", action: #selector(quit), keyEquivalent: "q"))
    for i in menu.items where i.action != nil { i.target = self }
    statusItem.menu = menu
  }

  @objc private func togglePause() { paused.toggle(); rebuildMenu() }
  @objc private func openGallery() { if let u = Config.baseURL { NSWorkspace.shared.open(u) } }
  @objc private func copyLink() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(Config.baseURL?.absoluteString ?? "", forType: .string)
  }
  @objc private func settings() { promptSettings() }
  @objc private func restoreDir() { dirManager.restore() }
  @objc private func quit() { dirManager.restore(); NSApp.terminate(nil) }
}
