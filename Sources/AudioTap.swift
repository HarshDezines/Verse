import Foundation
import ScreenCaptureKit
import CoreMedia
import AudioToolbox
import QuartzCore
import CoreGraphics

/// Captures system audio with ScreenCaptureKit and turns it into
/// three numbers ~60x per second: loudness, bass level, and kick onsets.
final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    /// (rms, bass, onset)
    var onLevels: ((Float, Float, Bool) -> Void)?
    var onDenied: (() -> Void)?

    private var stream: SCStream?
    private let queue = DispatchQueue(label: "verse.audio", qos: .userInteractive)
    private(set) var running = false

    // DSP state (only touched on `queue`)
    private var lp1: Float = 0, lp2: Float = 0
    private var bassAvg: Float = 0, prevBass: Float = 0
    private var lastOnset: Double = 0, lastSend: Double = 0
    private var maxRms: Float = 0, maxBass: Float = 0, pendingOnset = false

    func start() {
        guard !running else { return }
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()   // shows the system prompt; takes effect after relaunch
            onDenied?()
            return
        }
        running = true
        Task { await self.begin() }
    }

    func stop() {
        running = false
        let s = stream
        stream = nil
        Task { try? await s?.stopCapture() }
    }

    private func begin() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { running = false; return }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true
            cfg.excludesCurrentProcessAudio = true
            cfg.sampleRate = 48_000
            cfg.channelCount = 2
            // We only want audio; keep the video side as cheap as possible.
            cfg.width = 2
            cfg.height = 2
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 2)
            cfg.queueDepth = 3

            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            try await s.startCapture()
            stream = s
        } catch {
            running = false
            NSLog("Verse audio capture failed: \(error.localizedDescription)")
            DispatchQueue.main.async { self.onDenied?() }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        running = false
        NSLog("Verse audio stream stopped: \(error.localizedDescription)")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sb) else { return }

        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed > 0 else { return }

        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: 16)
        defer { raw.deallocate() }
        let ablPtr = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: nil, bufferListOut: ablPtr, bufferListSize: needed,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block)
        guard status == noErr else { return }

        let abl = UnsafeMutableAudioBufferListPointer(ablPtr)
        guard abl.count > 0, let d0 = abl[0].mData else { return }
        let ch = max(1, Int(abl[0].mNumberChannels))
        let total = Int(abl[0].mDataByteSize) / MemoryLayout<Float>.size
        let frames = total / ch
        guard frames > 0 else { return }
        let left = d0.assumingMemoryBound(to: Float.self)
        let right: UnsafeMutablePointer<Float>? =
            (ch == 1 && abl.count > 1) ? abl[1].mData?.assumingMemoryBound(to: Float.self) : nil

        // two-pole low-pass at ~150 Hz isolates kick/bass energy
        let a: Float = 0.0194
        var sum: Float = 0, bsum: Float = 0
        for i in 0..<frames {
            var x: Float
            if ch >= 2 { x = 0.5 * (left[i * ch] + left[i * ch + 1]) }
            else if let r = right { x = 0.5 * (left[i] + r[i]) }
            else { x = left[i] }
            sum += x * x
            lp1 += a * (x - lp1)
            lp2 += a * (lp1 - lp2)
            bsum += lp2 * lp2
        }
        let rms = sqrt(sum / Float(frames))
        let bass = sqrt(bsum / Float(frames))

        // onset: bass jumps well above its recent average
        let now = CACurrentMediaTime()
        if bass > bassAvg * 1.45 && bass > prevBass * 1.08 && bass > 0.008 && now - lastOnset > 0.2 {
            lastOnset = now
            pendingOnset = true
        }
        bassAvg += (bass - bassAvg) * 0.08
        prevBass = bass
        maxRms = max(maxRms, rms)
        maxBass = max(maxBass, bass)

        if now - lastSend >= 1.0 / 30.0 {
            let r = maxRms, b = maxBass, o = pendingOnset
            maxRms = 0; maxBass = 0; pendingOnset = false; lastSend = now
            DispatchQueue.main.async { self.onLevels?(r, b, o) }
        }
    }
}
