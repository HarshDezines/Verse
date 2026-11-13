import Cocoa

struct TrackInfo: Equatable {
    let id: String
    let name: String
    let artist: String
    let album: String
    let duration: Double   // seconds
    let artwork: String

    var json: String {
        let dict: [String: Any] = [
            "id": id, "name": name, "artist": artist, "album": album,
            "duration": duration, "artwork": artwork,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}

/// Reads the Spotify desktop app's now-playing state through AppleScript.
/// No Spotify developer account or API key needed.
final class SpotifyPoller {
    enum State {
        case notInstalled
        case notRunning
        case noPermission
        case idle
        case error(String)
        case active(TrackInfo, position: Double, playing: Bool)
    }

    var onState: ((State) -> Void)?

    private let bundleID = "com.spotify.client"
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "verse.spotify", qos: .userInitiated)
    private var emit: (State) -> Void {
        return { st in DispatchQueue.main.async { self.onState?(st) } }
    }

    private static let source = """
    tell application id "com.spotify.client"
        if player state is stopped then return "STOPPED"
        if player state is playing then
            set playState to "playing"
        else
            set playState to "paused"
        end if
        set sep to character id 31
        set p to player position
        set t to current track
        set tid to ""
        set tn to ""
        set ta to ""
        set tal to ""
        set td to 0
        set art to ""
        try
            set tid to id of t
        end try
        try
            set tn to name of t
        end try
        try
            set ta to artist of t
        end try
        try
            set tal to album of t
        end try
        try
            set td to duration of t
        end try
        try
            set art to artwork url of t
        end try
        return tid & sep & tn & sep & ta & sep & tal & sep & (td as string) & sep & (p as string) & sep & playState & sep & art
    end tell
    """

    private lazy var script: NSAppleScript? = {
        let s = NSAppleScript(source: Self.source)
        var err: NSDictionary?
        s?.compileAndReturnError(&err)
        return s
    }()

    func start() {
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .milliseconds(500), leeway: .milliseconds(20))
        t.setEventHandler { [weak self] in self?.poll() }
        t.resume()
        timer = t
    }

    private func poll() {
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil else {
            emit(.notInstalled); return
        }
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty else {
            emit(.notRunning); return
        }
        guard let script = script else { emit(.idle); return }

        var err: NSDictionary?
        let result = script.executeAndReturnError(&err)
        if let err = err {
            let code = err[NSAppleScript.errorNumber] as? Int ?? 0
            let text = err[NSAppleScript.errorMessage] as? String ?? "unknown error"
            NSLog("Verse AppleScript error \(code): \(text)")
            if code == -1743 || code == -1744 { emit(.noPermission) }
            else { emit(.error("AppleScript error \(code): \(text)")) }
            return
        }
        guard let out = result.stringValue, out != "STOPPED" else { emit(.idle); return }

        let p = out.components(separatedBy: "\u{1F}")
        guard p.count >= 8, !p[0].isEmpty else { emit(.error("Unexpected reply from Spotify: \(out.prefix(120))")); return }
        // Ads and podcasts have no lyrics
        if p[0].hasPrefix("spotify:ad") { emit(.idle); return }

        let num: (String) -> Double = { Double($0.replacingOccurrences(of: ",", with: ".")) ?? 0 }
        let track = TrackInfo(
            id: p[0], name: p[1], artist: p[2], album: p[3],
            duration: num(p[4]) / 1000.0,
            artwork: p[7]
        )
        emit(.active(track, position: num(p[5]), playing: p[6] == "playing"))
    }
}
