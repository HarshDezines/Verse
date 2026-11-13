import Cocoa
import WebKit

/// Transparent strip over the top of the window so you can drag it
/// (the web view would otherwise eat the clicks).
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.zoom(nil) } else { window?.performDrag(with: event) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var web: WKWebView!
    private let spotify = SpotifyPoller()
    private let audio = AudioTap()
    private var pageReady = false
    private var lastTrackID: String?
    private var lastStatus = ""
    private var floatItem: NSMenuItem!
    private var audioItem: NSMenuItem!

    private var reactToAudio: Bool {
        get { UserDefaults.standard.object(forKey: "reactToAudio") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "reactToAudio") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        cfg.userContentController.add(self, name: "net")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }
        web.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Verse"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 0.024, green: 0.024, blue: 0.03, alpha: 1)
        window.collectionBehavior = [.fullScreenPrimary]
        window.minSize = NSSize(width: 480, height: 300)
        window.center()
        window.setFrameAutosaveName("VerseMainWindow")

        let root = NSView()
        window.contentView = root
        let strip = DragStrip()
        for v in [web!, strip] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
        }
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            web.topAnchor.constraint(equalTo: root.topAnchor),
            web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            strip.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            strip.topAnchor.constraint(equalTo: root.topAnchor),
            strip.heightAnchor.constraint(equalToConstant: 34),
        ])

        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        spotify.onState = { [weak self] in self?.handle($0) }
        audio.onLevels = { [weak self] rms, bass, onset in
            self?.js("verse.audio(\(rms),\(bass),\(onset ? 1 : 0))")
        }
        audio.onDenied = { [weak self] in self?.js("verse.status('audio-denied')") }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        lastTrackID = nil
        lastStatus = ""
        spotify.start()
        if reactToAudio && !audio.running { audio.start() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - Spotify → page

    private func handle(_ state: SpotifyPoller.State) {
        switch state {
        case .notInstalled: status("no-spotify")
        case .notRunning: status("not-running")
        case .noPermission: status("auth")
        case .idle: status("idle")
        case let .error(message): status("error", detail: message)
        case let .active(track, position, playing):
            js("verse.position(\(position),\(playing))")
            if track.id != lastTrackID {
                lastTrackID = track.id
                lastStatus = "ok"
                js("verse.track(\(track.json))")
            }
        }
    }

    private func status(_ code: String, detail: String = "") {
        let key = code + detail
        guard key != lastStatus else { return }
        lastStatus = key
        lastTrackID = nil
        var arg = "null"
        if let enc = try? JSONSerialization.data(withJSONObject: [detail]),
           let str = String(data: enc, encoding: .utf8) { arg = str }
        js("verse.status('\(code)', \(arg)[0])")
    }

    private func js(_ code: String) {
        guard pageReady else { return }
        web.evaluateJavaScript(code, completionHandler: nil)
    }

    // MARK: - Native networking (lyrics + artwork), avoids CORS issues in the web view

    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.httpAdditionalHeaders = ["User-Agent": "Verse/1.0 (macOS lyrics viewer)"]
        return URLSession(configuration: c)
    }()

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "net",
              let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let urlString = body["url"] as? String,
              let url = URL(string: urlString) else { return }
        let kind = body["kind"] as? String ?? "text"
        session.dataTask(with: url) { [weak self] data, response, error in
            var result: [String: Any] = [:]
            let http = response as? HTTPURLResponse
            result["status"] = http?.statusCode ?? 0
            if let error = error { result["error"] = error.localizedDescription }
            if let data = data, let http = http, http.statusCode == 200 {
                if kind == "image" {
                    let mime = http.mimeType ?? "image/jpeg"
                    result["body"] = "data:\(mime);base64," + data.base64EncodedString()
                } else {
                    result["body"] = String(data: data, encoding: .utf8) ?? ""
                }
            }
            if result["error"] != nil || http?.statusCode != 200 {
                NSLog("Verse fetch \(urlString) -> \(http?.statusCode ?? 0) \(error?.localizedDescription ?? "")")
            }
            var arg = "null"
            if let enc = try? JSONSerialization.data(withJSONObject: [result]),
               let str = String(data: enc, encoding: .utf8) { arg = str }
            DispatchQueue.main.async { self?.js("verse._net(\(id),\(arg))") }
        }.resume()
    }

    // MARK: - Menu

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Verse", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Verse", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Verse", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        let fs = NSMenuItem(title: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fs)
        floatItem = NSMenuItem(title: "Float on Top", action: #selector(toggleFloat), keyEquivalent: "t")
        floatItem.target = self
        view.addItem(floatItem)
        view.addItem(.separator())
        audioItem = NSMenuItem(title: "React to Audio", action: #selector(toggleAudio), keyEquivalent: "a")
        audioItem.keyEquivalentModifierMask = [.command, .shift]
        audioItem.target = self
        audioItem.state = reactToAudio ? .on : .off
        view.addItem(audioItem)
        view.addItem(.separator())
        let later = NSMenuItem(title: "Lyrics Earlier", action: #selector(syncEarlier), keyEquivalent: "]")
        later.target = self
        view.addItem(later)
        let earlier = NSMenuItem(title: "Lyrics Later", action: #selector(syncLater), keyEquivalent: "[")
        earlier.target = self
        view.addItem(earlier)
        let reset = NSMenuItem(title: "Reset Sync", action: #selector(syncReset), keyEquivalent: "0")
        reset.target = self
        view.addItem(reset)
        let refetch = NSMenuItem(title: "Reload Lyrics", action: #selector(reloadLyrics), keyEquivalent: "r")
        refetch.target = self
        view.addItem(refetch)
        viewItem.submenu = view
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    @objc private func toggleFloat() {
        window.level = window.level == .floating ? .normal : .floating
        floatItem.state = window.level == .floating ? .on : .off
    }
    @objc private func toggleAudio() {
        reactToAudio.toggle()
        audioItem.state = reactToAudio ? .on : .off
        if reactToAudio { audio.start() } else { audio.stop() }
    }
    @objc private func syncEarlier() { js("verse.nudge(0.1)") }
    @objc private func syncLater() { js("verse.nudge(-0.1)") }
    @objc private func syncReset() { js("verse.nudge(0)") }
    @objc private func reloadLyrics() { js("verse.refetch(true)") }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
