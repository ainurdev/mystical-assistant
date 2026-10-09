import Foundation
import MysticalCore

/// The app's only line to the bridge: `bin/mystical` for lifecycle and status,
/// one HTTP GET for the live session map. No lifecycle logic lives here — start,
/// stop and restart mean exactly what they mean in a terminal, launchd handover
/// included, because they are the same script.
@MainActor
final class Bridge {
    /// The checkout this app was built from, stamped by build.sh.
    let repo: String
    /// The building shell's PATH, stamped by build.sh. An app opened from Finder
    /// gets /usr/bin:/bin:/usr/sbin:/sbin, where `mystical start` finds no npm.
    let path: String

    private(set) var status: BridgeStatus?
    private(set) var waiting: [WaitingSession] = []
    /// Consecutive failed polls — one blip (a restart's first second) is not "down".
    private(set) var misses = 0
    var onChange: (() -> Void)?

    private var timer: Timer?
    private var lastStatusCheck = Date.distantPast

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        repo = info["MysticalRepo"] as? String ?? ""
        path = info["MysticalPath"] as? String ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    }

    var launcher: String { (repo as NSString).appendingPathComponent("bin/mystical") }
    var repoMissing: Bool { !FileManager.default.isExecutableFile(atPath: launcher) }
    var up: Bool { misses == 0 && status?.answering == true }

    func start() {
        Task { await refreshStatus(); await poll() }
        // The dashboard's own cadence for the same map.
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.poll() }
        }
    }

    /// `mystical status --json`. Cheap enough to re-run every ~10s while the
    /// bridge is down (to tell "stopped" from "starting"), and on every failure
    /// edge so a rotated token or moved port is picked up.
    func refreshStatus() async {
        lastStatusCheck = Date()
        guard !repoMissing else { status = nil; onChange?(); return }
        let (_, out) = await run(["status", "--json"])
        status = BridgeStatus.parse(Data(out.utf8))
        onChange?()
    }

    private func poll() async {
        let port = status?.dashboard?.port ?? 8790
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/local/running")!)
        req.timeoutInterval = 2.5
        let wasUp = up
        if let (data, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200,
           let w = Running.waiting(data) {
            waiting = w
            misses = 0
            // Back from down: re-read status (new pid, maybe a new token).
            if !wasUp || status?.answering != true { await refreshStatus(); return }
        } else {
            misses += 1
            waiting = []
            if misses == 1 || Date().timeIntervalSince(lastStatusCheck) > 10 {
                await refreshStatus(); return
            }
        }
        onChange?()
    }

    /// Runs `bin/mystical <args>` and returns (exit code, stdout+stderr).
    func run(_ args: [String]) async -> (Int32, String) {
        let launcher = launcher, path = path, repo = repo
        return await withCheckedContinuation { cont in
            DispatchQueue.global().async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: launcher)
                p.arguments = args
                p.currentDirectoryURL = URL(fileURLWithPath: repo)
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = path
                p.environment = env
                let pipe = Pipe()
                p.standardOutput = pipe
                p.standardError = pipe
                p.standardInput = FileHandle.nullDevice
                do { try p.run() } catch {
                    cont.resume(returning: (-1, "\(error)")); return
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                cont.resume(returning: (p.terminationStatus, String(decoding: data, as: UTF8.self)))
            }
        }
    }

    /// start / stop / restart, then a fresh status. Returns the output on failure.
    func lifecycle(_ verb: String) async -> String? {
        let (code, out) = await run([verb])
        misses = 0
        await refreshStatus()
        return code == 0 ? nil : out
    }
}
