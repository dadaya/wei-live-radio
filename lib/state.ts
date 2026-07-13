import fs from "fs"
import path from "path"

export type QualityPreset = "480p" | "720p" | "1080p"

export interface StreamSettings {
  rtmpUrl: string
  streamKey: string
  quality: QualityPreset
  fps: 24 | 30 | 60
  videoBitrateKbps: number
  audioBitrateKbps: 128 | 192 | 320
  x264Preset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium"
  backgroundVideo: string | null // filename in media/video, null = solid color
  shuffle: boolean
}

export interface AppState {
  settings: StreamSettings
  playlistOrder: string[] // filenames in media/music, in play order
  auth: AuthState
}

export interface AuthState {
  // SHA-256 hex digest of the dashboard password, or null if unprotected.
  passwordHash: string | null
  // Whether the first-run "set a password?" prompt has been resolved --
  // either a password was set, or the user explicitly chose to skip it.
  // Until this is true, every request is redirected to /onboarding.
  onboardingDone: boolean
}

export const RESOLUTIONS: Record<QualityPreset, { w: number; h: number; defaultBitrate: number }> = {
  "480p": { w: 854, h: 480, defaultBitrate: 1200 },
  "720p": { w: 1280, h: 720, defaultBitrate: 2500 },
  "1080p": { w: 1920, h: 1080, defaultBitrate: 4500 },
}

export const PROJECT_ROOT = process.cwd()
export const DATA_DIR = path.join(PROJECT_ROOT, "data")
export const MUSIC_DIR = path.join(PROJECT_ROOT, "media", "music")
export const VIDEO_DIR = path.join(PROJECT_ROOT, "media", "video")
export const STATE_FILE = path.join(DATA_DIR, "state.json")
// Lives inside MUSIC_DIR so the concat demuxer can reference tracks (and
// itself, for infinite looping) with safe relative paths.
//
// IMPORTANT: this filename must NOT start with a dot. FFmpeg's concat
// demuxer rejects any referenced file whose name starts with "." as
// "Unsafe file name" — even when `-safe 0` is passed — which broke the
// self-referencing infinite-loop trick every time playback wrapped around
// (the exact "interruption/buffering right when the playlist loops" bug).
export const PLAYLIST_FILE_NAME = "weiradio-playlist.txt"
export const PLAYLIST_FILE = path.join(MUSIC_DIR, PLAYLIST_FILE_NAME)

const DEFAULT_STATE: AppState = {
  settings: {
    rtmpUrl: "",
    streamKey: "",
    quality: "720p",
    fps: 30,
    videoBitrateKbps: 2500,
    audioBitrateKbps: 128,
    x264Preset: "ultrafast",
    backgroundVideo: null,
    shuffle: false,
  },
  playlistOrder: [],
  auth: { passwordHash: null, onboardingDone: false },
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, MUSIC_DIR, VIDEO_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function readState(): AppState {
  ensureDirs()
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8")
    const parsed = JSON.parse(raw)
    return {
      settings: { ...DEFAULT_STATE.settings, ...parsed.settings },
      playlistOrder: Array.isArray(parsed.playlistOrder) ? parsed.playlistOrder : [],
      auth: { ...DEFAULT_STATE.auth, ...parsed.auth },
    }
  } catch {
    return structuredClone(DEFAULT_STATE)
  }
}

export function writeState(state: AppState) {
  ensureDirs()
  const tmp = STATE_FILE + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

export function updateSettings(patch: Partial<StreamSettings>): AppState {
  const state = readState()
  state.settings = { ...state.settings, ...patch }
  writeState(state)
  return state
}

export function updateAuth(patch: Partial<AuthState>): AppState {
  const state = readState()
  state.auth = { ...state.auth, ...patch }
  writeState(state)
  return state
}
