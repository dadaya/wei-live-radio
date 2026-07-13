import { NextResponse } from "next/server"
import { readState, updateSettings, RESOLUTIONS, type StreamSettings } from "@/lib/state"
import { scanVideos } from "@/lib/scan"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const state = readState()
  const { streamKey, ...rest } = state.settings
  return NextResponse.json({
    settings: { ...rest, streamKeySet: streamKey.length > 0 },
    videos: scanVideos(),
  })
}

export async function PUT(req: Request) {
  const patch = (await req.json()) as Partial<StreamSettings>
  const allowed: (keyof StreamSettings)[] = [
    "rtmpUrl", "streamKey", "quality", "fps",
    "videoBitrateKbps", "audioBitrateKbps", "x264Preset",
    "backgroundVideo", "shuffle",
  ]
  const clean: Partial<StreamSettings> = {}
  for (const key of allowed) {
    if (key in patch) (clean as Record<string, unknown>)[key] = patch[key]
  }
  // If quality changed but bitrate wasn't explicitly set, apply the preset default
  if (clean.quality && !("videoBitrateKbps" in patch)) {
    clean.videoBitrateKbps = RESOLUTIONS[clean.quality].defaultBitrate
  }
  const state = updateSettings(clean)
  const { streamKey, ...rest } = state.settings
  return NextResponse.json({ settings: { ...rest, streamKeySet: streamKey.length > 0 } })
}
