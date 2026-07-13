import fs from "fs"
import path from "path"
import { parseFile } from "music-metadata"
import { MUSIC_DIR, VIDEO_DIR, readState, writeState, ensureDirs } from "./state"

export interface Track {
  filename: string
  title: string
  artist: string
  duration: number // seconds
  sizeBytes: number
}

const AUDIO_EXTS = new Set([".mp3", ".flac", ".ogg", ".wav", ".m4a", ".aac"])
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov", ".gif"])

// Metadata cache keyed by filename + mtime so we never re-parse unchanged files.
const metaCache = new Map<string, Track>()

export async function scanMusic(): Promise<Track[]> {
  ensureDirs()
  const files = fs
    .readdirSync(MUSIC_DIR)
    .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))

  const tracks: Track[] = []
  for (const filename of files) {
    const full = path.join(MUSIC_DIR, filename)
    const stat = fs.statSync(full)
    const cacheKey = `${filename}:${stat.mtimeMs}:${stat.size}`
    const cached = metaCache.get(cacheKey)
    if (cached) {
      tracks.push(cached)
      continue
    }
    let track: Track = {
      filename,
      title: path.basename(filename, path.extname(filename)),
      artist: "",
      duration: 0,
      sizeBytes: stat.size,
    }
    try {
      const meta = await parseFile(full, { duration: true, skipCovers: true })
      track = {
        ...track,
        title: meta.common.title || track.title,
        artist: meta.common.artist || "",
        duration: Math.round(meta.format.duration || 0),
      }
    } catch {
      // keep filename-based fallback
    }
    metaCache.set(cacheKey, track)
    tracks.push(track)
  }
  return tracks
}

/** Returns tracks in the saved playlist order; syncs order with what's on disk. */
export async function getOrderedPlaylist(): Promise<Track[]> {
  const tracks = await scanMusic()
  const state = readState()
  const byName = new Map(tracks.map((t) => [t.filename, t]))

  const ordered: Track[] = []
  for (const name of state.playlistOrder) {
    const t = byName.get(name)
    if (t) {
      ordered.push(t)
      byName.delete(name)
    }
  }
  // Append any new files not in the saved order
  for (const t of byName.values()) ordered.push(t)

  const newOrder = ordered.map((t) => t.filename)
  if (JSON.stringify(newOrder) !== JSON.stringify(state.playlistOrder)) {
    state.playlistOrder = newOrder
    writeState(state)
  }
  return ordered
}

export function scanVideos(): { filename: string; sizeBytes: number }[] {
  ensureDirs()
  return fs
    .readdirSync(VIDEO_DIR)
    .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
    .map((f) => ({ filename: f, sizeBytes: fs.statSync(path.join(VIDEO_DIR, f)).size }))
}

export function isAudioFile(name: string) {
  return AUDIO_EXTS.has(path.extname(name).toLowerCase())
}
export function isVideoFile(name: string) {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase())
}
