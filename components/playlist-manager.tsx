"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { Upload, Trash2, ArrowUp, ArrowDown, Music2, Shuffle, RotateCcw, X, CheckCircle2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { uploadFile, UploadError } from "@/lib/upload-client"

interface Track {
  filename: string
  title: string
  artist: string
  duration: number
  sizeBytes: number
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

function fmtSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

// ---------------------------------------------------------------------------
// Upload queue
//
// Files are uploaded one request each (see lib/upload-client.ts), a few at a
// time. Uploading a 10-file batch in one multipart POST -- the old approach
// -- meant no per-file progress, no per-file errors, and one flaky file (or
// one dropped packet) failing the entire batch with a bare "Upload failed."
// ---------------------------------------------------------------------------

/** How many files upload in parallel. More than 2-3 just splits the same
 * bandwidth thinner and multiplies concurrent disk writes on a weak VPS. */
const CONCURRENT_UPLOADS = 2

type UploadStatus = "queued" | "uploading" | "done" | "error"

interface UploadItem {
  id: string
  file: File
  status: UploadStatus
  /** 0..1 while uploading */
  progress: number
  error?: string
  retryable?: boolean
}

let nextUploadId = 0

export function PlaylistManager() {
  const { data, mutate } = useSWR<{ tracks: Track[] }>("/api/playlist", fetcher)
  const { data: settingsData, mutate: mutateSettings } = useSWR<{
    settings: { shuffle: boolean }
  }>("/api/settings", fetcher)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortersRef = useRef<Map<string, AbortController>>(new Map())

  const tracks = data?.tracks ?? []
  const totalSec = tracks.reduce((s, t) => s + t.duration, 0)

  const patchUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)))
  }, [])

  const runUpload = useCallback(
    async (item: UploadItem) => {
      const aborter = new AbortController()
      abortersRef.current.set(item.id, aborter)
      try {
        await uploadFile(item.file, "music", {
          signal: aborter.signal,
          onProgress: (fraction) => patchUpload(item.id, { progress: fraction }),
        })
        patchUpload(item.id, { status: "done", progress: 1 })
        await mutate() // refresh the track list as each file lands
      } catch (err) {
        const e = err instanceof UploadError ? err : null
        patchUpload(item.id, {
          status: "error",
          error: e?.message ?? "Upload failed for an unknown reason.",
          retryable: e?.retryable ?? true,
        })
      } finally {
        abortersRef.current.delete(item.id)
      }
    },
    [mutate, patchUpload],
  )

  // Queue pump: whenever the list changes, promote queued items into the
  // free upload slots. Effect-driven so retries reuse the same path.
  useEffect(() => {
    const active = uploads.filter((u) => u.status === "uploading").length
    const slots = CONCURRENT_UPLOADS - active
    if (slots <= 0) return
    const next = uploads.filter((u) => u.status === "queued").slice(0, slots)
    if (!next.length) return
    const ids = new Set(next.map((n) => n.id))
    setUploads((prev) => prev.map((u) => (ids.has(u.id) ? { ...u, status: "uploading" as const } : u)))
    for (const item of next) void runUpload(item)
  }, [uploads, runUpload])

  function enqueueFiles(files: FileList) {
    const items: UploadItem[] = Array.from(files).map((file) => ({
      id: `u${nextUploadId++}`,
      file,
      status: "queued",
      progress: 0,
    }))
    setUploads((prev) => [...prev.filter((u) => u.status !== "done"), ...items])
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function retryUpload(id: string) {
    patchUpload(id, { status: "queued", progress: 0, error: undefined })
  }

  function removeUpload(id: string) {
    abortersRef.current.get(id)?.abort()
    setUploads((prev) => prev.filter((u) => u.id !== id))
  }

  const uploadsPending = uploads.some((u) => u.status === "queued" || u.status === "uploading")
  const failedUploads = uploads.filter((u) => u.status === "error")

  async function reorder(index: number, dir: -1 | 1) {
    const next = [...tracks]
    const j = index + dir
    if (j < 0 || j >= next.length) return
    ;[next[index], next[j]] = [next[j], next[index]]
    await mutate({ tracks: next }, { revalidate: false })
    await fetch("/api/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: next.map((t) => t.filename) }),
    })
    await mutate()
  }

  async function removeTrack(filename: string) {
    await fetch("/api/playlist", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    })
    await mutate()
  }

  async function toggleShuffle(checked: boolean) {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shuffle: checked }),
    })
    await mutateSettings()
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Playlist</h1>
          <p className="text-sm text-muted-foreground">
            {tracks.length} track{tracks.length === 1 ? "" : "s"} · {fmtDuration(totalSec)} total · loops forever
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Shuffle className="size-4 text-muted-foreground" aria-hidden />
            <Label htmlFor="shuffle" className="text-sm">Shuffle</Label>
            <Switch
              id="shuffle"
              checked={settingsData?.settings.shuffle ?? false}
              onCheckedChange={toggleShuffle}
            />
          </div>
          <Button size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="size-4" aria-hidden />
            {uploadsPending ? "Add more" : "Add music"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,.flac,.ogg,.wav,.m4a,.aac,audio/*"
            multiple
            className="sr-only"
            onChange={(e) => e.target.files?.length && enqueueFiles(e.target.files)}
            aria-label="Upload music files"
          />
        </div>
      </header>

      {uploads.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2 py-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Uploads</p>
              <div className="flex items-center gap-2">
                {failedUploads.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => failedUploads.forEach((u) => u.retryable !== false && retryUpload(u.id))}
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    Retry all failed
                  </Button>
                )}
                {!uploadsPending && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setUploads([])}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
            <ul className="flex flex-col gap-2">
              {uploads.map((u) => (
                <li key={u.id} className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    {u.status === "done" ? (
                      <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : u.status === "error" ? (
                      <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
                    ) : (
                      <Music2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <p className="min-w-0 flex-1 truncate text-sm">{u.file.name}</p>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {u.status === "uploading"
                        ? `${Math.round(u.progress * 100)}%`
                        : u.status === "queued"
                          ? "queued"
                          : u.status === "done"
                            ? fmtSize(u.file.size)
                            : ""}
                    </span>
                    {u.status === "error" && u.retryable !== false && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => retryUpload(u.id)}
                        aria-label={`Retry uploading ${u.file.name}`}
                      >
                        <RotateCcw className="size-3.5" aria-hidden />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      onClick={() => removeUpload(u.id)}
                      aria-label={
                        u.status === "uploading" ? `Cancel uploading ${u.file.name}` : `Dismiss ${u.file.name}`
                      }
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                  {(u.status === "uploading" || u.status === "queued") && (
                    <div
                      className="h-1 w-full overflow-hidden rounded-full bg-secondary"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(u.progress * 100)}
                      aria-label={`Upload progress for ${u.file.name}`}
                    >
                      <div
                        className="h-full bg-primary transition-[width] duration-200"
                        style={{ width: `${Math.round(u.progress * 100)}%` }}
                      />
                    </div>
                  )}
                  {u.status === "error" && <p className="text-xs text-destructive">{u.error}</p>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        Playlist changes while live take effect after a stream restart. You can also drop files directly into{" "}
        <code className="font-mono">media/music/</code> on the server.
      </p>

      {tracks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Music2 className="size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              No music yet. Upload audio files to build your 24/7 rotation.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tracks.map((track, i) => (
            <li
              key={track.filename}
              className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5"
            >
              <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{track.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {track.artist || "Unknown artist"} · {fmtDuration(track.duration)} · {fmtSize(track.sizeBytes)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={i === 0}
                  onClick={() => reorder(i, -1)}
                  aria-label={`Move ${track.title} up`}
                >
                  <ArrowUp className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={i === tracks.length - 1}
                  onClick={() => reorder(i, 1)}
                  aria-label={`Move ${track.title} down`}
                >
                  <ArrowDown className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={() => removeTrack(track.filename)}
                  aria-label={`Remove ${track.title}`}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
