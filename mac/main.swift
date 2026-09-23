// Schema Lineage Studio — native macOS shell.
// A window hosting the same HTML page as the web version (bundled offline in
// Resources/web), plus what a web page can't do on its own: open/save .dbml
// files, a title bar that tracks the file and unsaved changes, and standard
// menus (the Edit menu is what makes ⌘C/⌘V/⌘Z work inside the web view).

import Cocoa
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var fileURL: URL?
    var pageReady = false
    var pendingOpen: URL?
    var dirty = false { didSet { window?.isDocumentEdited = dirty } }

    let dbmlType = UTType(filenameExtension: "dbml", conformingTo: .plainText) ?? .plainText

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenus()

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "sls")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = true }   // right-click → Inspect Element, for debugging

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.minSize = NSSize(width: 820, height: 520)
        window.contentView = web
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("SchemaLineageStudioMain")
        updateTitle()

        let webDir = Bundle.main.resourceURL!.appendingPathComponent("web")
        web.loadFileURL(webDir.appendingPathComponent("index.html"), allowingReadAccessTo: webDir)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Double-clicking a .dbml in Finder, or dropping it on the Dock icon.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        if pageReady { openFile(url) } else { pendingOpen = url }
    }

    // MARK: messages from the page (window.SLS in the HTML)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            pageReady = true
            if let url = pendingOpen { pendingOpen = nil; openFile(url) }
            SelfTest.startIfRequested(self)
        case "dirty":
            dirty = (body["dirty"] as? Bool) ?? false
        default:
            break
        }
    }

    // Links in notes open in the real browser, never inside the app window.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.navigationType == .linkActivated, url.scheme != "file" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    // MARK: File menu

    @objc func newDocument(_ sender: Any?) {
        confirmUnsaved { proceed in
            guard proceed else { return }
            self.loadIntoPage("", url: nil)
        }
    }

    @objc func openDocument(_ sender: Any?) {
        confirmUnsaved { proceed in
            guard proceed else { return }
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [self.dbmlType, .plainText]
            panel.allowsMultipleSelection = false
            panel.beginSheetModal(for: self.window) { response in
                if response == .OK, let url = panel.url { self.openFile(url, skipConfirm: true) }
            }
        }
    }

    func openFile(_ url: URL, skipConfirm: Bool = false) {
        let go = {
            do {
                let text = try String(contentsOf: url, encoding: .utf8)
                self.loadIntoPage(text, url: url)
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
            } catch {
                self.showError("Couldn't open “\(url.lastPathComponent)”.", error)
            }
        }
        if skipConfirm { go() } else { confirmUnsaved { if $0 { go() } } }
    }

    func loadIntoPage(_ text: String, url: URL?) {
        web.callAsyncJavaScript("SLS.loadSource(text)", arguments: ["text": text], in: nil, in: .page) { _ in }
        fileURL = url
        dirty = false
        updateTitle()
    }

    @objc func saveDocument(_ sender: Any?) {
        if let url = fileURL { write(to: url, done: nil) } else { saveDocumentAs(sender) }
    }

    @objc func saveDocumentAs(_ sender: Any?) {
        saveAs(done: nil)
    }

    func saveAs(done: ((Bool) -> Void)?) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [dbmlType]
        panel.nameFieldStringValue = fileURL?.lastPathComponent ?? "schema.dbml"
        panel.beginSheetModal(for: window) { response in
            if response == .OK, let url = panel.url { self.write(to: url, done: done) } else { done?(false) }
        }
    }

    func write(to url: URL, done: ((Bool) -> Void)?) {
        web.evaluateJavaScript("SLS.getSource()") { result, error in
            guard let text = result as? String else {
                self.showError("Couldn't read the schema from the editor.", error)
                done?(false); return
            }
            do {
                try text.write(to: url, atomically: true, encoding: .utf8)
                self.fileURL = url
                self.updateTitle()
                self.web.evaluateJavaScript("SLS.markSaved()", completionHandler: nil)
                self.dirty = false
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
                done?(true)
            } catch {
                self.showError("Couldn't save “\(url.lastPathComponent)”.", error)
                done?(false)
            }
        }
    }

    // MARK: unsaved changes

    /// Save / Don't Save / Cancel. Calls back with true when it's fine to discard the current text.
    func confirmUnsaved(_ then: @escaping (Bool) -> Void) {
        guard dirty else { then(true); return }
        let alert = NSAlert()
        alert.messageText = "Save changes to “\(fileURL?.lastPathComponent ?? "Untitled")”?"
        alert.informativeText = "Your changes will be lost if you don't save them."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Don't Save")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            switch response {
            case .alertFirstButtonReturn:
                if let url = self.fileURL { self.write(to: url) { then($0) } } else { self.saveAs { then($0) } }
            case .alertSecondButtonReturn:
                then(true)
            default:
                then(false)
            }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard dirty else { return true }
        confirmUnsaved { ok in if ok { self.dirty = false; self.window.close() } }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard dirty else { return .terminateNow }
        confirmUnsaved { ok in NSApp.reply(toApplicationShouldTerminate: ok) }
        return .terminateLater
    }

    // MARK: helpers

    func updateTitle() {
        if let url = fileURL {
            window.representedURL = url
            window.title = url.lastPathComponent
        } else {
            window.representedURL = nil
            window.title = "Untitled — Schema Lineage Studio"
        }
    }

    func showError(_ message: String, _ error: Error?) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = error?.localizedDescription ?? ""
        alert.alertStyle = .warning
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    func buildMenus() {
        let main = NSMenu()
        let appName = "Schema Lineage Studio"

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "New", action: #selector(newDocument(_:)), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileMenu.addItem(withTitle: "Save", action: #selector(saveDocument(_:)), keyEquivalent: "s")
        let saveAs = fileMenu.addItem(withTitle: "Save As…", action: #selector(saveDocumentAs(_:)), keyEquivalent: "s")
        saveAs.keyEquivalentModifierMask = [.command, .shift]
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        let fs = viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu

        let windowItem = NSMenuItem(); main.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

// MARK: self-test (only when SLS_SELFTEST_REPORT is set — used by scripts/test_mac_app.sh)
// Opens a file, lets the real WebKit engine render it, writes measurements +
// a snapshot, optionally exercises Save As, then quits. Never runs for users.
enum SelfTest {
    static func startIfRequested(_ app: AppDelegate) {
        let env = ProcessInfo.processInfo.environment
        guard let report = env["SLS_SELFTEST_REPORT"] else { return }
        if let open = env["SLS_SELFTEST_OPEN"] { app.openFile(URL(fileURLWithPath: open), skipConfirm: true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            let js = """
            (() => {
              const HEAD_H = 30, ROW_H = 26, bad = [];
              document.querySelectorAll('.node:not(.group-node):not(.sticky-node)').forEach(n => {
                const top = n.querySelector('.head').getBoundingClientRect().top;
                n.querySelectorAll('.row[data-field]').forEach((r, i) => {
                  const rr = r.getBoundingClientRect(), d = rr.top + rr.height/2 - top - (HEAD_H + i*ROW_H + ROW_H/2);
                  if(Math.abs(d) > 2) bad.push(n.dataset.id + '.' + r.dataset.field + ' ' + d.toFixed(1));
                });
              });
              const box = document.querySelector('.group-box');
              return JSON.stringify({
                title: document.title,
                status: document.getElementById('status').textContent,
                tables: document.querySelectorAll('.node:not(.sticky-node)').length,
                stickies: document.querySelectorAll('.sticky-node').length,
                groupBoxes: document.querySelectorAll('.group-box').length,
                refLines: document.querySelectorAll('.ref-hit').length,
                depLines: document.querySelectorAll('.dep-hit').length,
                misaligned: bad,
                dagreLoaded: typeof dagre !== 'undefined',
                fontsLoaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
                colorMix: CSS.supports('background', 'color-mix(in srgb, red 10%, transparent)'),
                groupBoxBg: box ? getComputedStyle(box).backgroundColor : null,
                sourceChars: SLS.getSource().length,
                inApp: document.documentElement.classList.contains('in-mac-app'),
              });
            })()
            """
            app.web.evaluateJavaScript(js) { result, error in
                var info: [String: Any] = ["error": error?.localizedDescription ?? "no result"]
                if let s = result as? String, let d = s.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { info = parsed }
                info["windowTitle"] = app.window.title
                info["dirty"] = app.dirty
                if let out = try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys]) {
                    try? out.write(to: URL(fileURLWithPath: report))
                }
                app.web.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                       let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: report + ".png"))
                    }
                    if let saveAs = env["SLS_SELFTEST_SAVEAS"] {
                        app.write(to: URL(fileURLWithPath: saveAs)) { ok in
                            var saved: [String: Any] = ["saved": ok, "windowTitle": app.window.title, "dirty": app.dirty]
                            // then type into the editor: the title bar must pick up the unsaved change
                            let edit = "const s = document.getElementById('src'); s.value += '\\n// edited'; s.dispatchEvent(new Event('input'));"
                            app.web.evaluateJavaScript(edit) { _, _ in
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                                    saved["dirtyAfterTyping"] = app.dirty
                                    saved["editedDotShown"] = app.window.isDocumentEdited
                                    if let out = try? JSONSerialization.data(withJSONObject: saved, options: [.sortedKeys]) {
                                        try? out.write(to: URL(fileURLWithPath: report + ".save.json"))
                                    }
                                    app.dirty = false   // self-test only: skip the "save changes?" prompt on quit
                                    NSApp.terminate(nil)
                                }
                            }
                        }
                    } else {
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
