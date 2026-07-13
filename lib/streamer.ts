import { spawn, type ChildProcess } from "child_process"
import { readState } from "./state"
import { getOrderedPlaylist, type Track } from "./scan"
import { buildArgs, writePlaylistFile, getFfmpegPath } from "./ffmpeg-args"

export interface NowPlaying {
  title: string
  artist: string
  index: number
  total: number
  elapsedInTrack: number
  duration: number
  next: string | null
}

export interface StreamStatus {
  running: boolean
  desired: boolean
  startedAt: number | null
  uptimeSec: number
  restarts: number
  nowPlaying: NowPlaying | null
  progress: { bitrate: string; speed: string; fps: string; droppedFrames: number }
  lastError: string | null
}

const MAX_LOG_LINES = 200
// If FFmpeg stops emitting -progress updates for this long while it's
// supposed to be running, we treat it as stalled/hung (e.g. blocked on a
// dead RTMP socket without exiting, or wedged while re-opening the
// self-referencing concat playlist at the loop boundary) and force a
// restart. Viewers see a stalled-but-alive process as endless buffering,
// which is worse than a clean restart. Kept tight (checked frequently, low
// timeout) so a hang right when the playlist loops is caught in a few
// seconds instead of leaving the stream stuck for up to 35s like before.
const STARTUP_GRACE_MS = 20_000
const STALL_TIMEOUT_MS = 10_000
const STALL_CHECK_INTERVAL_MS = 4_000
// The infinite-loop playlist trick (see ffmpeg-args.ts) re-opens the concat
// list — and therefore recurses into itself — on every lap. That's the only
// reliable way to get a gapless loop out of FFmpeg's concat demuxer, but
// empirically (tested against real FFmpeg builds) each recursive re-open
// leaks roughly one file descriptor that's never released for the life of
// the process. On a real 24/7 stream that slowly adds up towards the OS
// open-files limit. A scheduled, race-free restart (see restart()) resets
// it before that ever becomes a problem — the same maintenance-restart
// pattern most long-running streaming setups use, at the cost of a
// sub-second reconnect blip every few hours instead of an eventual crash.
const MAINTENANCE_RESTART_MS = 6 * 60 * 60 * 1000

class Streamer {
  private proc: ChildProcess | null = null
  private desired = false
  private startedAt: number | null = null
  private restarts = 0
  // Restart backoff starts fast (a hang/crash right at the playlist loop
  // boundary should recover in ~1s, not several seconds) and only backs off
  // if it keeps failing, capped low so a persistent problem still surfaces
  // quickly on the dashboard instead of silently waiting up to 30s.
  private backoffMs = 800
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stallCheckTimer: ReturnType<typeof setInterval> | null = null
  private maintenanceTimer: ReturnType<typeof setTimeout> | null = null
  private lastProgressAt: number | null = null
  // Real playback position reported by FFmpeg itself (from -progress
  // `out_time`), in seconds. Now Playing is derived from this instead of
  // wall-clock time since spawn, because encode speed can dip below 1x on
  // weaker servers -- a wall-clock estimate then runs ahead of what's
  // actually playing and "Now playing" drifts/looks wrong or frozen.
  private outTimeSec = 0
  // Counts consecutive crashes that happen within a couple seconds of spawn
  // via a fatal signal (SIGSEGV/SIGILL/SIGBUS). A real RTMP/network hiccup
  // or a stalled process (see checkStall) doesn't look like this -- this
  // pattern specifically means the ffmpeg binary itself is broken for this
  // host (e.g. a manually-set FFMPEG_PATH pointing at a static/incompatible
  // binary -- see getFfmpegPath() in ffmpeg-args.ts). No amount of
  // restarting fixes that, so after a couple of these in a row we say so
  // explicitly instead of leaving the dashboard stuck on a generic
  // "crashed; restarting" loop forever.
  private consecutiveFastCrashes = 0
  private logs: string[] = []
  private activePlaylist: Track[] = []
  private playlistTotalSec = 0
  private lastError: string | null = null
  private progress = { bitrate: "0", speed: "0", fps: "0", droppedFrames: 0 }
  private listeners = new Set<() => void>()

  onUpdate(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private notify() {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        /* listener gone */
      }
    }
  }

  private log(line: string) {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`
    this.logs.push(stamped)
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    // Mirror into the host process's own stdout/stderr so the log survives
    // even if nobody has the dashboard open (or the in-memory ring buffer
    // has since rotated past it). This is what shows up in `pm2 logs`,
    // `journalctl -u <service>`, or `docker logs` -- previously FFmpeg's
    // stderr only ever reached the in-memory buffer above, so a crash
    // reason was unrecoverable once it scrolled out of the dashboard.
    console.log(`[ffmpeg] ${stamped}`)
  }

  getLogs(): string[] {
    return [...this.logs]
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.proc) return { ok: true }
    const state = readState()
    if (!state.settings.rtmpUrl || !state.settings.streamKey) {
      return { ok: false, error: "RTMP URL and stream key are required." }
    }
    const tracks = await getOrderedPlaylist()
    if (tracks.length === 0) {
      return { ok: false, error: "Playlist is empty. Add music files first." }
    }
    // Cancel any pending watchdog respawn so we never double-spawn
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.desired = true
    this.lastError = null
    this.restarts = 0
    this.backoffMs = 800
    this.spawnProcess(state.settings.shuffle, tracks)
    return { ok: true }
  }

  private async respawn() {
    this.restartTimer = null
    if (!this.desired || this.proc) return
    const state = readState()
    const tracks = await getOrderedPlaylist()
    if (tracks.length === 0) {
      this.desired = false
      this.lastError = "Playlist became empty; stream stopped."
      this.notify()
      return
    }
    this.spawnProcess(state.settings.shuffle, tracks)
  }

  private spawnProcess(shuffle: boolean, tracks: Track[]) {
    const state = readState()
    this.activePlaylist = writePlaylistFile(tracks, shuffle)
    this.playlistTotalSec = this.activePlaylist.reduce((s, t) => s + (t.duration || 0), 0)

    const bin = getFfmpegPath()
    const args = buildArgs(state.settings)
    this.log(`Starting FFmpeg (${state.settings.quality}@${state.settings.fps}fps, RTMP)`)

    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
    this.proc = proc
    this.startedAt = Date.now()
    // Baseline so the stall watchdog's startup grace period counts from
    // spawn time even if the first -progress line hasn't arrived yet.
    this.lastProgressAt = Date.now()
    this.outTimeSec = 0

    let stdoutBuf = ""
    proc.stdout?.on("data", (chunk: Buffer) => {
      this.lastProgressAt = Date.now()
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split("\n")
      stdoutBuf = lines.pop() || ""
      for (const line of lines) {
        const [key, value] = line.split("=")
        if (!key || value === undefined) continue
        if (key === "bitrate") this.progress.bitrate = value.trim()
        else if (key === "speed") this.progress.speed = value.trim()
        else if (key === "fps") this.progress.fps = value.trim()
        else if (key === "drop_frames") this.progress.droppedFrames = Number(value) || 0
        else if (key === "out_time") {
          // Format is "HH:MM:SS.microseconds". Parsed instead of the
          // confusingly-named out_time_ms/out_time_us fields (both actually
          // report microseconds in real FFmpeg builds) to avoid unit bugs.
          const t = value.trim()
          const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(t)
          if (m) {
            const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number.parseFloat(m[3])
            if (Number.isFinite(secs) && secs >= 0) this.outTimeSec = secs
          }
        }
      }
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.log(line.trim())
      }
    })

    if (this.stallCheckTimer) clearInterval(this.stallCheckTimer)
    this.stallCheckTimer = setInterval(() => this.checkStall(proc), STALL_CHECK_INTERVAL_MS)

    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer)
    this.maintenanceTimer = setTimeout(() => {
      if (this.proc !== proc || !this.desired) return
      this.log("Scheduled maintenance restart (resets FFmpeg's internal resource usage)...")
      void this.restart()
    }, MAINTENANCE_RESTART_MS)

    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return
      const ranMs = this.startedAt ? Date.now() - this.startedAt : null
      this.proc = null
      this.startedAt = null
      if (this.stallCheckTimer) {
        clearInterval(this.stallCheckTimer)
        this.stallCheckTimer = null
      }
      if (this.maintenanceTimer) {
        clearTimeout(this.maintenanceTimer)
        this.maintenanceTimer = null
      }
      this.log(`FFmpeg exited (code=${code}, signal=${signal})`)

      const isFatalSignal = signal === "SIGSEGV" || signal === "SIGILL" || signal === "SIGBUS"
      const isInstantCrash = ranMs !== null && ranMs < 5000
      this.consecutiveFastCrashes = isFatalSignal && isInstantCrash ? this.consecutiveFastCrashes + 1 : 0

      if (this.desired) {
        this.restarts++
        if (this.consecutiveFastCrashes >= 2) {
          this.lastError =
            `FFmpeg keeps crashing instantly with ${signal} -- this is not a network hiccup, the ffmpeg ` +
            `binary itself is failing on this server. If FFMPEG_PATH is set, double-check it points at a ` +
            `real, working ffmpeg for this OS/architecture (run it with -version by hand to confirm). ` +
            `Restarting anyway in ${Math.round(this.backoffMs / 1000)}s, but that alone won't fix it.`
        } else {
          this.lastError = `FFmpeg crashed (code ${code}); restarting in ${Math.round(this.backoffMs / 1000)}s...`
        }
        this.log(this.lastError)
        this.restartTimer = setTimeout(() => {
          this.backoffMs = Math.min(this.backoffMs * 2, 8000)
          void this.respawn()
        }, this.backoffMs)
      }
      this.notify()
    })

    proc.on("error", (err) => {
      this.lastError = `Failed to spawn FFmpeg: ${err.message}`
      this.log(this.lastError)
      if (this.proc === proc) {
        this.proc = null
        this.startedAt = null
        this.desired = false
      }
      this.notify()
    })

    // Reset backoff (and the fast-crash-loop counter) after 30s of stable running
    setTimeout(() => {
      if (this.proc === proc) {
        this.backoffMs = 800
        this.consecutiveFastCrashes = 0
      }
    }, 30000)

    this.notify()
  }

  /**
   * Detects a hung-but-not-exited FFmpeg process: no -progress output for
   * STALL_TIMEOUT_MS while the stream is supposed to be live. This covers
   * cases (dead RTMP socket wedged instead of erroring, deadlocked filter
   * graph, disk I/O stuck on a weak server) where the process never fires
   * an "exit" event on its own, so the normal crash-restart path would
   * never trigger and viewers would see endless buffering.
   */
  private checkStall(proc: ChildProcess) {
    if (this.proc !== proc || !this.desired || !this.startedAt) return
    const sinceStart = Date.now() - this.startedAt
    if (sinceStart < STARTUP_GRACE_MS) return
    const idleFor = Date.now() - (this.lastProgressAt ?? this.startedAt)
    if (idleFor > STALL_TIMEOUT_MS) {
      this.lastError = `FFmpeg appears stalled (no progress for ${Math.round(idleFor / 1000)}s); forcing restart...`
      this.log(this.lastError)
      this.notify()
      try {
        proc.kill("SIGKILL")
      } catch {
        /* already dead */
      }
    }
  }

  stop() {
    this.desired = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer)
      this.stallCheckTimer = null
    }
    if (this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
    if (this.proc) {
      this.log("Stopping stream...")
      const p = this.proc
      this.proc = null
      this.startedAt = null
      p.kill("SIGTERM")
      setTimeout(() => {
        try {
          p.kill("SIGKILL")
        } catch {
          /* already dead */
        }
      }, 4000)
    }
    this.notify()
  }

  /** Resolves once `proc` has actually exited (or after a safety timeout). */
  private waitForExit(proc: ChildProcess | null): Promise<void> {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      proc.once("exit", finish)
      // Safety net: never block a restart forever even if the exit event
      // is somehow missed (stop() already force-kills after 4s).
      setTimeout(finish, 4500)
    })
  }

  async restart() {
    // Capture the current process BEFORE stop() nulls `this.proc`, so we can
    // wait for it to actually die. Without this, a fast Stop+Start could
    // spawn a second FFmpeg while the first one is still shutting down —
    // both briefly fighting over the RTMP connection and preview/playlist
    // files, which is exactly the kind of glitch that looks like a random
    // on-air interruption.
    const outgoing = this.proc
    this.stop()
    await this.waitForExit(outgoing)
    // brief pause to let the socket/pipe fully settle
    await new Promise((r) => setTimeout(r, 300))
    return this.start()
  }

  private computeNowPlaying(): NowPlaying | null {
    if (!this.startedAt || this.activePlaylist.length === 0) return null
    if (this.playlistTotalSec <= 0) {
      const t = this.activePlaylist[0]
      return {
        title: t.title,
        artist: t.artist,
        index: 0,
        total: this.activePlaylist.length,
        elapsedInTrack: 0,
        duration: t.duration,
        next: this.activePlaylist[1]?.title ?? null,
      }
    }
    // Real position reported by FFmpeg, wrapped to the playlist length. Using
    // the encoder's own clock (rather than wall-clock time since spawn) keeps
    // this accurate even if encoding briefly runs below realtime speed.
    const elapsed = this.outTimeSec % this.playlistTotalSec
    let acc = 0
    for (let i = 0; i < this.activePlaylist.length; i++) {
      const t = this.activePlaylist[i]
      if (elapsed < acc + t.duration || i === this.activePlaylist.length - 1) {
        const next = this.activePlaylist[(i + 1) % this.activePlaylist.length]
        return {
          title: t.title,
          artist: t.artist,
          index: i,
          total: this.activePlaylist.length,
          elapsedInTrack: Math.max(0, Math.floor(elapsed - acc)),
          duration: t.duration,
          next: next.title,
        }
      }
      acc += t.duration
    }
    return null
  }

  getStatus(): StreamStatus {
    return {
      running: this.proc !== null,
      desired: this.desired,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      nowPlaying: this.computeNowPlaying(),
      progress: { ...this.progress },
      lastError: this.lastError,
    }
  }
}

// Survive Next.js dev-mode module reloads with a globalThis singleton.
// The version suffix ensures stale instances from older code are replaced
// after an engine update (any orphaned ffmpeg would be reaped by stop/start).
const SINGLETON_KEY = "__weiRadioStreamer_v5"
const globalForStreamer = globalThis as unknown as Record<string, Streamer | undefined>

export function getStreamer(): Streamer {
  if (!globalForStreamer[SINGLETON_KEY]) {
    globalForStreamer[SINGLETON_KEY] = new Streamer()
  }
  return globalForStreamer[SINGLETON_KEY]
}
