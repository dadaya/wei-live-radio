import fs from "fs"
import path from "path"
import {
  RESOLUTIONS,
  MUSIC_DIR,
  VIDEO_DIR,
  PLAYLIST_FILE,
  PLAYLIST_FILE_NAME,
  type StreamSettings,
} from "./state"
import type { Track } from "./scan"

function escapeConcatPath(p: string) {
  // concat demuxer: single-quote paths, escape existing single quotes
  return `'${p.replace(/'/g, "'\\''")}'`
}

// How many times the track list is written back-to-back before falling back
// to the self-referencing loop line (see below). Bounded so the playlist
// file stays small even for very large libraries, with a floor so short
// playlists still get many, many laps before ever touching the expensive
// path.
const MAX_PLAYLIST_LINES = 5000
const MIN_PLAYLIST_REPEATS = 20
function computeRepeatCount(trackCount: number): number {
  if (trackCount <= 0) return 1
  return Math.max(MIN_PLAYLIST_REPEATS, Math.floor(MAX_PLAYLIST_LINES / trackCount))
}

/**
 * Writes the concat playlist file FFmpeg reads. Returns the ordered tracks used.
 *
 * Writes the track list back-to-back many times (see computeRepeatCount)
 * and ONLY THEN appends a reference to itself, so the concat demuxer keeps
 * sequentially reading "one more file" forever, which is what makes the
 * loop gapless in the long run.
 *
 * IMPORTANT: relying on the self-reference for every single lap (i.e.
 * writing the track list just once) is NOT gapless in practice. Confirmed
 * against real FFmpeg builds under an actual live push: the moment the
 * demuxer hits that self-reference, it has to close the current file,
 * re-open and re-parse the playlist text file, then re-open and re-probe
 * the very first track again -- and that reopen is slow enough to show up
 * as a real stutter/rebuffer on the live output (e.g. visible as YouTube
 * buffering), not just the theoretical fd-leak concern noted below. With a
 * short playlist (a couple of demo tracks) this reopen was being hit after
 * every single lap, i.e. every ~10-20 seconds -- a stutter roughly every
 * two songs. Pre-writing many laps up front means that reopen only has to
 * happen once every `computeRepeatCount()` laps instead of every lap, so
 * for any realistic playlist it's not reached during normal operation --
 * the scheduled maintenance restart (MAINTENANCE_RESTART_MS in streamer.ts)
 * regenerates this file long before the laps could ever run out.
 *
 * NOTE: an earlier revision of this code replaced this trick with
 * `-stream_loop -1` on the concat input (the same option used for the
 * looping background video), on the theory that it would be more robust.
 * Testing against real FFmpeg builds showed the opposite: `-stream_loop`
 * makes FFmpeg *seek* back to the start of the concat timeline on every
 * lap, and the concat demuxer does not reliably support that — in practice
 * it fails right at the loop boundary with `Operation not permitted` and
 * the whole stream dies. The self-referencing file avoids seeking
 * entirely: the demuxer just keeps sequentially opening "the next file in
 * the list", which happens to be the list itself again. Keep this pattern;
 * do not switch to `-stream_loop` for this input.
 */
export function writePlaylistFile(tracks: Track[], shuffle: boolean): Track[] {
  const ordered = [...tracks]
  if (shuffle) {
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
    }
  }
  const lines = ["ffconcat version 1.0"]
  const repeatCount = computeRepeatCount(ordered.length)
  for (let rep = 0; rep < repeatCount; rep++) {
    for (const t of ordered) {
      lines.push(`file ${escapeConcatPath(t.filename)}`)
    }
  }
  lines.push(`file ${escapeConcatPath(PLAYLIST_FILE_NAME)}`)
  fs.writeFileSync(PLAYLIST_FILE, lines.join("\n") + "\n")
  return ordered
}

// System ffmpeg (from apt/yum/etc.) is dynamically linked against the
// host's glibc and its NSS modules load normally, so DNS resolution for
// network outputs (RTMP, HTTP, ...) works correctly. This app used to also
// bundle `ffmpeg-static` (a fully static glibc build from
// johnvansickle.com) as a convenience/fallback, but static glibc binaries
// are well documented to be unable to load NSS modules for DNS resolution —
// on affected hosts/distros this doesn't fail gracefully, FFmpeg segfaults
// (SIGSEGV) the instant it tries to open a network destination by hostname,
// before printing anything. Purely local pipelines (reading local media,
// writing a local file) never touch that code path, so the binary looked
// completely fine until the first real RTMP push on a fresh server — the
// classic "works on my machine, crash-loops on a clean Linux deploy"
// report. See: https://github.com/eugeneware/ffmpeg-static/issues/142,
// https://trac.ffmpeg.org/ticket/9309
//
// The dependency has been removed entirely: `scripts/ensure-ffmpeg.js`
// installs a system ffmpeg automatically on `pnpm install`/`npm install`
// (see its postinstall hook), so there's no static binary to fall back to
// anymore, and no risk of silently picking the broken one. Set FFMPEG_PATH
// to force a specific binary; otherwise this resolves the OS-installed one.
export function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH
  }
  for (const c of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    try {
      if (fs.existsSync(c)) return fs.realpathSync(c)
    } catch {
      // keep looking
    }
  }
  // Last resort: whatever "ffmpeg" resolves to on PATH.
  return "ffmpeg"
}

/**
 * Builds the full FFmpeg argument list. ONE process handles:
 * looped video bg + looped audio concat + x264/aac encode + RTMP push + preview JPEG.
 */
export function buildArgs(settings: StreamSettings): string[] {
  const { w, h } = RESOLUTIONS[settings.quality]
  const fps = settings.fps
  const vb = settings.videoBitrateKbps
  const gop = fps * 2

  const args: string[] = ["-hide_banner", "-loglevel", "warning", "-re"]

  // Input 0: video background (looped) or solid color.
  // -thread_queue_size gives the demuxer thread a bigger input buffer so a
  // brief disk-read hiccup on a slow/weak server doesn't starve the encoder
  // (which is what shows up downstream as the player re-buffering).
  if (settings.backgroundVideo) {
    args.push(
      "-stream_loop", "-1",
      "-thread_queue_size", "1024",
      "-i", path.join(VIDEO_DIR, settings.backgroundVideo),
    )
  } else {
    args.push("-f", "lavfi", "-i", `color=c=0x0f1115:s=${w}x${h}:r=${fps}`)
  }

  // Input 1: music playlist — loops forever via the self-referencing concat
  // file (see writePlaylistFile for why `-stream_loop` is deliberately NOT
  // used here). `+genpts+igndts` regenerates presentation timestamps instead
  // of trusting each file's (often inconsistent) embedded ones, which is the
  // main cause of an audible stall/gap right when FFmpeg switches from one
  // track to the next inside a concat demuxer.
  args.push(
    "-fflags", "+genpts+igndts",
    "-thread_queue_size", "1024",
    "-safe", "0",
    "-f", "concat",
    "-i", PLAYLIST_FILE,
  )

  // Filter graph:
  //  - video: scale/pad to target resolution
  //  - audio: aresample+asetpts rebuilds a perfectly continuous timestamp/sample
  //    stream across track boundaries, so differing sample rates, channel
  //    layouts, or VBR headers between files in the playlist never cause an
  //    audible click, gap, or the encoder briefly stalling on a lap restart.
  const filter =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p[vout];` +
    `[1:a]aresample=44100:async=1:first_pts=0,asetpts=N/SR/TB[aout]`
  args.push("-filter_complex", filter)

  // Output: the stream
  args.push(
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", settings.x264Preset,
    "-tune", "zerolatency",
    "-b:v", `${vb}k`,
    "-maxrate", `${vb}k`,
    "-bufsize", `${vb * 2}k`,
    "-g", String(gop),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", `${settings.audioBitrateKbps}k`,
    "-ar", "44100",
    "-ac", "2",
    // Prevents "Too many packets buffered for output stream" aborts if the
    // RTMP socket briefly can't keep up on a slow server/network — instead
    // of the whole process dying, FFmpeg is allowed a bigger muxing queue.
    "-max_muxing_queue_size", "1024",
  )
  const url = settings.rtmpUrl.replace(/\/+$/, "") + "/" + settings.streamKey
  args.push("-f", "flv", url)

  // Machine-readable progress on stdout
  args.push("-progress", "pipe:1", "-nostats")

  return args
}
