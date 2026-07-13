"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { Upload, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SecurityForm } from "@/components/security-form"
import { uploadFile, UploadError } from "@/lib/upload-client"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface SettingsResponse {
  settings: {
    rtmpUrl: string
    quality: "480p" | "720p" | "1080p"
    fps: 24 | 30 | 60
    videoBitrateKbps: number
    audioBitrateKbps: 128 | 192 | 320
    x264Preset: string
    backgroundVideo: string | null
    shuffle: boolean
    streamKeySet: boolean
  }
  videos: { filename: string; sizeBytes: number }[]
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const NONE_VALUE = "__none__"

export function SettingsForm() {
  // Don't refetch on window focus: switching back to this tab used to
  // silently overwrite whatever the user had just typed in the fields
  // below (see the rtmpUrl local-state note further down).
  const { data, mutate } = useSWR<SettingsResponse>("/api/settings", fetcher, { revalidateOnFocus: false })
  // RTMP URL is plain local state, hydrated once from the server on first
  // load and never overwritten after that. It used to be bound straight to
  // the SWR cache -- any background revalidation (switching browser tabs
  // and back, or saving an unrelated field like quality/fps, which also
  // calls mutate()) refetched from the server and wiped out whatever the
  // user had just typed but not yet saved. That's why both the URL and key
  // had to be pasted in one uninterrupted sitting before. Stream key was
  // already local state (it's never echoed back from the server anyway).
  const [rtmpUrl, setRtmpUrl] = useState("")
  const [streamKey, setStreamKey] = useState("")
  const hydratedRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const [videoUploadPct, setVideoUploadPct] = useState(0)
  const [videoUploadError, setVideoUploadError] = useState<string | null>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)

  const s = data?.settings

  useEffect(() => {
    if (s && !hydratedRef.current) {
      setRtmpUrl(s.rtmpUrl)
      hydratedRef.current = true
    }
  }, [s])

  async function patch(update: Record<string, unknown>) {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    })
    await mutate()
  }

  async function saveOutput(e: React.FormEvent) {
    e.preventDefault()
    if (!s) return
    setSaving(true)
    setSavedMsg(null)
    const update: Record<string, unknown> = { rtmpUrl }
    if (streamKey) update.streamKey = streamKey
    await patch(update)
    setStreamKey("")
    setSavedMsg("Output settings saved. Restart the stream to apply.")
    setSaving(false)
  }

  // Streams the file to the server with real progress (see
  // lib/upload-client.ts) -- background videos are routinely hundreds of MB,
  // and the old single-fetch multipart upload gave no feedback and failed
  // outright for large files.
  async function uploadVideo(files: FileList) {
    setUploadingVideo(true)
    setVideoUploadError(null)
    setVideoUploadPct(0)
    try {
      const saved = await uploadFile(files[0], "video", {
        onProgress: (fraction) => setVideoUploadPct(Math.round(fraction * 100)),
      })
      await patch({ backgroundVideo: saved })
    } catch (err) {
      setVideoUploadError(err instanceof UploadError ? err.message : "Upload failed for an unknown reason.")
      await mutate()
    } finally {
      setUploadingVideo(false)
      if (videoInputRef.current) videoInputRef.current.value = ""
    }
  }

  if (!s) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-sm text-muted-foreground">Loading settings...</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Changes to quality and output apply on the next stream (re)start.
        </p>
      </header>

      {savedMsg && (
        <p className="rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">{savedMsg}</p>
      )}

      <SecurityForm />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Output</CardTitle>
          <CardDescription>Where the 24/7 stream is pushed.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveOutput} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rtmp-url">RTMP server URL</Label>
              <Input
                id="rtmp-url"
                placeholder="rtmp://live.twitch.tv/app"
                value={rtmpUrl}
                onChange={(e) => setRtmpUrl(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="stream-key">Stream key</Label>
              <Input
                id="stream-key"
                type="password"
                placeholder={s.streamKeySet ? "•••••••• (saved — enter to replace)" : "Your stream key"}
                value={streamKey}
                onChange={(e) => setStreamKey(e.target.value)}
                className="font-mono text-sm"
                autoComplete="off"
              />
            </div>
            <div>
              <Button type="submit" size="sm" disabled={saving}>
                <Save className="size-4" aria-hidden />
                Save output
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quality</CardTitle>
          <CardDescription>
            Lower is lighter on the CPU. For weak servers use 720p / 24fps / ultrafast.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="quality">Resolution</Label>
            <Select value={s.quality} onValueChange={(v) => patch({ quality: v })}>
              <SelectTrigger id="quality">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="480p">480p (854x480)</SelectItem>
                <SelectItem value="720p">720p (1280x720)</SelectItem>
                <SelectItem value="1080p">1080p (1920x1080)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="fps">Frame rate</Label>
            <Select value={String(s.fps)} onValueChange={(v) => patch({ fps: Number(v) })}>
              <SelectTrigger id="fps">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24">24 fps (lightest)</SelectItem>
                <SelectItem value="30">30 fps</SelectItem>
                <SelectItem value="60">60 fps (heavy)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="vbitrate">Video bitrate (kbps)</Label>
            <Input
              id="vbitrate"
              type="number"
              min={300}
              max={12000}
              value={s.videoBitrateKbps}
              onChange={(e) =>
                mutate(
                  { ...data!, settings: { ...s, videoBitrateKbps: Number(e.target.value) } },
                  { revalidate: false },
                )
              }
              onBlur={(e) => patch({ videoBitrateKbps: Number(e.target.value) || 2500 })}
              className="font-mono text-sm"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="abitrate">Audio bitrate</Label>
            <Select
              value={String(s.audioBitrateKbps)}
              onValueChange={(v) => patch({ audioBitrateKbps: Number(v) })}
            >
              <SelectTrigger id="abitrate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="128">128 kbps</SelectItem>
                <SelectItem value="192">192 kbps</SelectItem>
                <SelectItem value="320">320 kbps</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="preset">Encoder speed (x264 preset)</Label>
            <Select value={s.x264Preset} onValueChange={(v) => patch({ x264Preset: v })}>
              <SelectTrigger id="preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ultrafast">ultrafast — lowest CPU, recommended for weak servers</SelectItem>
                <SelectItem value="superfast">superfast</SelectItem>
                <SelectItem value="veryfast">veryfast — good balance</SelectItem>
                <SelectItem value="faster">faster</SelectItem>
                <SelectItem value="fast">fast</SelectItem>
                <SelectItem value="medium">medium — best quality, high CPU</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Video background</CardTitle>
          <CardDescription>
            A looping video or GIF shown behind the audio. If none is set, a solid dark background is used
            (cheapest option).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-48 flex-1 flex-col gap-2">
              <Label htmlFor="bg-video">Active background</Label>
              <Select
                value={s.backgroundVideo ?? NONE_VALUE}
                onValueChange={(v) => patch({ backgroundVideo: v === NONE_VALUE ? null : v })}
              >
                <SelectTrigger id="bg-video">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>None (solid color)</SelectItem>
                  {data?.videos.map((v) => (
                    <SelectItem key={v.filename} value={v.filename}>
                      {v.filename}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={uploadingVideo}
              onClick={() => videoInputRef.current?.click()}
            >
              <Upload className="size-4" aria-hidden />
              {uploadingVideo ? `Uploading... ${videoUploadPct}%` : "Upload video / GIF"}
            </Button>
            <input
              ref={videoInputRef}
              type="file"
              accept=".mp4,.mkv,.webm,.mov,.gif,video/*"
              className="sr-only"
              onChange={(e) => e.target.files?.length && uploadVideo(e.target.files)}
              aria-label="Upload background video"
            />
          </div>
          {videoUploadError && <p className="text-xs text-destructive">{videoUploadError}</p>}
        </CardContent>
      </Card>

    </div>
  )
}
