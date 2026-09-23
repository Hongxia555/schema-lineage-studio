// Schema Lineage Studio — native macOS shell.
// A window hosting the same HTML page as the web version (bundled offline in
// Resources/web), plus what a web page can't do on its own: open/save .dbml
// files (each in its own tab), a title bar that tracks the active tab and unsaved
// changes, and standard
// menus (the Edit menu is what makes ⌘C/⌘V/⌘Z work inside the web view).

import Cocoa
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var pageReady = false
    var pendingOpen: [URL] = []
    var anyDirty = false { didSet { window?.isDocumentEdited = anyDirty } }
    var activeDirty = false
    var closeConfirmed = false          // unsaved tabs already resolved (saved or discarded)

    let dbmlType = UTType(filenameExtension: "dbml", conformingTo: .plainText) ?? .plainText

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenus()

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "sls")
        // open tabs live in the page's localStorage; the self-test must not touch the user's
        if SelfTest.requested { config.websiteDataStore = .nonPersistent() }
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
        window.title = "Schema Lineage Studio"

        let webDir = Bundle.main.resourceURL!.appendingPathComponent("web")
        web.loadFileURL(webDir.appendingPathComponent("index.html"), allowingReadAccessTo: webDir)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Double-clicking a .dbml in Finder, or dropping it on the Dock icon: each opens in a tab.
    func application(_ application: NSApplication, open urls: [URL]) {
        if pageReady { urls.forEach { openFile($0) } } else { pendingOpen += urls }
    }

    // MARK: messages from the page (window.SLS in the HTML)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            pageReady = true
            pendingOpen.forEach { openFile($0) }
            pendingOpen = []
            SelfTest.startIfRequested(self)
        case "state":
            let name = body["name"] as? String ?? "Untitled"
            let path = body["path"] as? String
            window.title = name
            window.representedURL = path.map { URL(fileURLWithPath: $0) }
            activeDirty = body["dirty"] as? Bool ?? false
            anyDirty = (body["dirtyCount"] as? Int ?? 0) > 0
        case "saveTab":   // the page's Save / Don't Save / Cancel on closing one tab
            guard let id = body["id"] as? String else { return }
            let closeAfter = body["closeAfter"] as? Bool ?? false
            js("return SLS.doc(id)", ["id": id]) { doc in
                guard let doc = doc as? [String: Any] else { return }
                self.save(doc, forcePanel: false) { ok in
                    if ok && closeAfter { self.js("SLS.closeTab(id)", ["id": id]) }
                }
            }
        case "open":      // the page's Import button
            openDocument(nil)
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

    /// Run JavaScript in the page with named arguments; `then` gets the returned value (nil on error).
    func js(_ code: String, _ args: [String: Any] = [:], then: ((Any?) -> Void)? = nil) {
        web.callAsyncJavaScript(code, arguments: args, in: nil, in: .page) { result in
            switch result {
            case .success(let v): then?(v)
            case .failure: then?(nil)
            }
        }
    }

    // MARK: File menu — every document is a tab in the page

    @objc func newDocument(_ sender: Any?) { js("SLS.newDocument()") }

    @objc func openDocument(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [dbmlType, .plainText]
        panel.allowsMultipleSelection = true
        panel.beginSheetModal(for: window) { response in
            if response == .OK { panel.urls.forEach { self.openFile($0) } }
        }
    }

    func openFile(_ url: URL, then: ((Bool) -> Void)? = nil) {
        do {
            let text = try String(contentsOf: url, encoding: .utf8)
            js("return SLS.openDocument(text, path, name)", ["text": text, "path": url.path, "name": url.lastPathComponent]) { _ in then?(true) }
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
        } catch {
            showError("Couldn't open “\(url.lastPathComponent)”.", error)
            then?(false)
        }
    }

    @objc func saveDocument(_ sender: Any?) { saveActive(forcePanel: false) }
    @objc func saveDocumentAs(_ sender: Any?) { saveActive(forcePanel: true) }

    func saveActive(forcePanel: Bool, done: ((Bool) -> Void)? = nil) {
        js("return SLS.activeDoc()") { doc in
            guard let doc = doc as? [String: Any] else { done?(false); return }
            self.save(doc, forcePanel: forcePanel) { done?($0) }
        }
    }

    /// Save one tab: to its file if it has one, else ask where.
    func save(_ doc: [String: Any], forcePanel: Bool, done: @escaping (Bool) -> Void) {
        if !forcePanel, let path = doc["path"] as? String {
            write(doc, to: URL(fileURLWithPath: path), done: done); return
        }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [dbmlType]
        var name = doc["name"] as? String ?? "schema"
        if !name.lowercased().hasSuffix(".dbml") { name += ".dbml" }
        panel.nameFieldStringValue = name
        panel.beginSheetModal(for: window) { response in
            if response == .OK, let url = panel.url { self.write(doc, to: url, done: done) } else { done(false) }
        }
    }

    func write(_ doc: [String: Any], to url: URL, done: @escaping (Bool) -> Void) {
        guard let id = doc["id"] as? String, let text = doc["text"] as? String else { done(false); return }
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            showError("Couldn't save “\(url.lastPathComponent)”.", error)
            done(false); return
        }
        NSDocumentController.shared.noteNewRecentDocumentURL(url)
        js("SLS.markSaved(id, path, name, text)", ["id": id, "path": url.path, "name": url.lastPathComponent, "text": text]) { _ in done(true) }
    }

    // MARK: tabs

    @objc func closeTab(_ sender: Any?) { js("SLS.closeActiveTab()") }
    @objc func nextTab(_ sender: Any?) { js("SLS.cycleTab(1)") }
    @objc func previousTab(_ sender: Any?) { js("SLS.cycleTab(-1)") }

    // MARK: unsaved changes on close / quit

    /// Save All / Don't Save / Cancel across every unsaved tab. Calls back true when it's fine to go.
    func resolveUnsaved(_ then: @escaping (Bool) -> Void) {
        js("return SLS.dirtyDocs()") { value in
            let docs = value as? [[String: Any]] ?? []
            if docs.isEmpty { then(true); return }
            let alert = NSAlert()
            if docs.count == 1 {
                alert.messageText = "Save changes to “\(docs[0]["name"] as? String ?? "Untitled")”?"
                alert.addButton(withTitle: "Save")
            } else {
                let names = docs.compactMap { $0["name"] as? String }.map { "“\($0)”" }.joined(separator: ", ")
                alert.messageText = "\(docs.count) tabs have unsaved changes: \(names). Save them?"
                alert.addButton(withTitle: "Save All")
            }
            alert.informativeText = "Your changes will be lost if you don't save them."
            alert.addButton(withTitle: "Don't Save")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: self.window) { response in
                switch response {
                case .alertFirstButtonReturn:
                    self.saveSequentially(docs, then: then)
                case .alertSecondButtonReturn:
                    self.js("SLS.discardUnsaved()") { _ in then(true) }
                default:
                    then(false)
                }
            }
        }
    }

    func saveSequentially(_ docs: [[String: Any]], then: @escaping (Bool) -> Void) {
        guard let doc = docs.first else { then(true); return }
        // bring the tab forward so a Save panel for an untitled tab shows what it's saving
        js("SLS.showDoc(id)", ["id": doc["id"] ?? ""]) { _ in
            self.save(doc, forcePanel: false) { ok in
                if ok { self.saveSequentially(Array(docs.dropFirst()), then: then) } else { then(false) }
            }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeConfirmed || !anyDirty { return true }
        resolveUnsaved { ok in if ok { self.closeConfirmed = true; self.window.close() } }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if closeConfirmed || !anyDirty { return .terminateNow }
        resolveUnsaved { ok in
            if ok { self.closeConfirmed = true }
            NSApp.reply(toApplicationShouldTerminate: ok)
        }
        return .terminateLater
    }

    // MARK: helpers

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
        fileMenu.addItem(withTitle: "New Tab", action: #selector(newDocument(_:)), keyEquivalent: "t")
        fileMenu.addItem(withTitle: "New", action: #selector(newDocument(_:)), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close Tab", action: #selector(closeTab(_:)), keyEquivalent: "w")
        let closeWin = fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        closeWin.keyEquivalentModifierMask = [.command, .shift]
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
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Show Previous Tab", action: #selector(previousTab(_:)), keyEquivalent: "[")
            .keyEquivalentModifierMask = [.command, .shift]
        windowMenu.addItem(withTitle: "Show Next Tab", action: #selector(nextTab(_:)), keyEquivalent: "]")
            .keyEquivalentModifierMask = [.command, .shift]
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

// MARK: self-test (only when SLS_SELFTEST_REPORT is set — used by scripts/test_mac_app.sh)
// Opens a file in a tab, lets the real WebKit engine render it, writes measurements +
// a snapshot, then exercises re-open, Save As, typing, a second tab and Don't Save,
// and quits. Runs on a throwaway data store, never for users.
enum SelfTest {
    static var requested: Bool { ProcessInfo.processInfo.environment["SLS_SELFTEST_REPORT"] != nil }

    static func after(_ seconds: Double, _ block: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: block)
    }

    static func startIfRequested(_ app: AppDelegate) {
        let env = ProcessInfo.processInfo.environment
        guard let report = env["SLS_SELFTEST_REPORT"], let open = env["SLS_SELFTEST_OPEN"] else { return }
        let openURL = URL(fileURLWithPath: open)
        var steps: [String: Any] = [:]
        func finish() {
            if let out = try? JSONSerialization.data(withJSONObject: steps, options: [.sortedKeys]) {
                try? out.write(to: URL(fileURLWithPath: report + ".save.json"))
            }
            app.closeConfirmed = true   // self-test only: skip the "save changes?" prompt on quit
            NSApp.terminate(nil)
        }
        func tabsState(_ key: String, then: @escaping () -> Void) {
            app.js("return { count: SLS.tabCount(), names: [...document.querySelectorAll('.tab .tab-name')].map(e => e.textContent), dirtyDocs: SLS.dirtyDocs().length }") { v in
                var d = v as? [String: Any] ?? [:]
                d["windowTitle"] = app.window.title
                d["anyDirty"] = app.anyDirty
                d["editedDotShown"] = app.window.isDocumentEdited
                steps[key] = d
                then()
            }
        }

        app.openFile(openURL)
        after(2.0) {
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
                tabNames: [...document.querySelectorAll('.tab .tab-name')].map(e => e.textContent),
                activeTab: document.querySelector('.tab.active .tab-name').textContent,
                inApp: document.documentElement.classList.contains('in-mac-app'),
              });
            })()
            """
            app.web.evaluateJavaScript(js) { result, error in
                var info: [String: Any] = ["error": error?.localizedDescription ?? "no result"]
                if let s = result as? String, let d = s.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { info = parsed }
                info["windowTitle"] = app.window.title
                info["dirty"] = app.anyDirty
                if let out = try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys]) {
                    try? out.write(to: URL(fileURLWithPath: report))
                }
                app.web.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                       let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: report + ".png"))
                    }
                    guard let saveAs = env["SLS_SELFTEST_SAVEAS"] else { finish(); return }
                    // opening the same file again reuses its tab
                    app.openFile(openURL)
                    after(0.8) { tabsState("reopen") {
                        app.js("return SLS.activeDoc()") { doc in
                            guard let doc = doc as? [String: Any] else { finish(); return }
                            app.write(doc, to: URL(fileURLWithPath: saveAs)) { ok in
                                steps["saved"] = ok
                                after(0.3) { tabsState("afterSave") {
                                    // typing: the title bar must pick up the unsaved change
                                    app.web.evaluateJavaScript("{ const s = document.getElementById('src'); s.value += '\\n// edited'; s.dispatchEvent(new Event('input')); }") { _, _ in
                                        after(0.8) { tabsState("afterTyping") {
                                            // a second, new tab with text: two unsaved tabs
                                            app.newDocument(nil)
                                            after(0.5) {
                                                app.web.evaluateJavaScript("{ const s = document.getElementById('src'); s.value = 'Project scratch_pad {\\n}\\nTable t {\\n  id int\\n}\\n'; s.dispatchEvent(new Event('input')); }") { _, _ in
                                                    after(0.8) { tabsState("newTab") {
                                                        // Don't Save: file tab reverts to disk, the new tab goes away
                                                        app.js("SLS.discardUnsaved()") { _ in
                                                            after(0.5) { tabsState("discarded") {
                                                                app.js("return SLS.getSource()") { v in
                                                                    steps["revertedToDisk"] = (v as? String) == (try? String(contentsOf: URL(fileURLWithPath: saveAs), encoding: .utf8))
                                                                    finish()
                                                                }
                                                            } }
                                                        }
                                                    } }
                                                }
                                            }
                                        } }
                                    }
                                } }
                            }
                        }
                    } }
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
