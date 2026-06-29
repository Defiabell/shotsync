import AppKit
import ShotsyncCore

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class TempDelegate: NSObject, NSApplicationDelegate {
  var item: NSStatusItem!
  func applicationDidFinishLaunching(_ n: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.title = "◉"
    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "shotsync \(ShotsyncCore.version)", action: nil, keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    item.menu = menu
  }
}

let delegate = TempDelegate()
app.delegate = delegate
app.run()
