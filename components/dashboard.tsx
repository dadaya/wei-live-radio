"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import {
  Play,
  Square,
  RotateCcw,
  Gauge,
  ShieldAlert,
  Cast,
  Monitor,
  Timer,
  ChevronDown,
  ChevronUp,
  Terminal,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useStreamStatus } from "@/hooks/use-stream-status"

const HISTORY_LEN = 40

const QUALITY_RESOLUTION: Record<string, string> = {
  "480p": "854x480",
  "720p": "1280x720",
  "1080p": "1920x1080",
}

const settingsFetcher = (url: string) => fetch(url).then((r) => r.json())

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function fmtBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)} MB`
}

function parseBitrateKbps(bitrate: string | undefined): number {
  if (!bitrate) return 0
  const n = Number.parseFloat(bitrate)
  return Number.isFinite(n) ? n : 0
}

function pushHistory(arr: number[], value: number): number[] {
  const next = [...arr, value]
  return next.length > HISTORY_LEN ? next.slice(next.length - HISTORY_LEN) : next
}

export function Dashboard() {
  const { status, logs, system, connected } = useStreamStatus()
  const { data: settingsData } = useSWR<{ settings: { quality: string; x264Preset: string } }>(
    "/api/settings",
    settingsFetcher,
  )
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const running = status?.running ?? false

  // Rolling client-side history for the metric sparklines. Server-side
  // state would survive page reloads, but for a lightweight admin panel a
  // fresh trend window on each visit is a fair trade for the simplicity.
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [ramHistory, setRamHistory] = useState<number[]>([])
  const [bitrateHistory, setBitrateHistory] = useState<number[]>([])
  const [diskHistory, setDiskHistory] = useState<number[]>([])

  useEffect(() => {
    if (!system) return
    setCpuHistory((h) => pushHistory(h, system.cpuPct))
    setRamHistory((h) => pushHistory(h, system.ramTotalBytes > 0 ? (system.ramUsedBytes / system.ramTotalBytes) * 100 : 0))
    if (system.diskTotalBytes && system.diskUsedBytes !== null) {
      setDiskHistory((h) => pushHistory(h, (system.diskUsedBytes! / system.diskTotalBytes!) * 100))
    }
  }, [system])

  useEffect(() => {
    if (!status) return
    setBitrateHistory((h) => pushHistory(h, parseBitrateKbps(status.progress.bitrate)))
  }, [status])

  async function streamAction(action: "start" | "stop" | "restart") {
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setActionError(body.error || "Action failed")
      }
    } catch {
      setActionError("Network error")
    } finally {
      setBusy(false)
    }
  }

  const np = status?.nowPlaying
  const progressPct = np && np.duration > 0 ? Math.min(100, (np.elapsedInTrack / np.duration) * 100) : 0
  const remainingInTrack = np ? Math.max(0, np.duration - np.elapsedInTrack) : 0
  const speedNum = status ? Number.parseFloat(status.progress.speed) : NaN
  const healthPct = running && Number.isFinite(speedNum) ? Math.max(0, Math.min(100, Math.round(speedNum * 100))) : null
  const resolution = settingsData?.settings.quality ? QUALITY_RESOLUTION[settingsData.settings.quality] : null
  const encoderLabel = settingsData?.settings.x264Preset ? `libx264 (${settingsData.settings.x264Preset})` : "libx264"

  const statusLine = !connected
    ? { color: "bg-muted-foreground", text: "Connecting..." }
    : status?.lastError
      ? { color: "bg-destructive", text: "Attention needed" }
      : running
        ? { color: "bg-primary", text: "All systems operational" }
        : { color: "bg-muted-foreground", text: "Stream is offline" }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span className={`size-1.5 rounded-full ${statusLine.color} ${running ? "animate-pulse" : ""}`} aria-hidden />
            {statusLine.text}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => streamAction("restart")}>
                <RotateCcw className="size-4" aria-hidden />
                Restart Stream
              </Button>
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => streamAction("stop")}>
                <Square className="size-4" aria-hidden />
                Stop Stream
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy || !connected} onClick={() => streamAction("start")}>
              <Play className="size-4" aria-hidden />
              Start Stream
            </Button>
          )}
        </div>
      </header>

      {(actionError || status?.lastError) && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError || status?.lastError}
        </p>
      )}

      {/* Hero: live status, current/next track, and at-a-glance health */}
      <Card className="overflow-hidden py-0">
        <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 md:grid-cols-4">
          <div className="flex flex-col justify-center gap-1.5 px-5 py-5">
            <span className={`flex items-center gap-1.5 text-lg font-semibold ${running ? "text-primary" : "text-muted-foreground"}`}>
              <span className={`size-2 rounded-full ${running ? "animate-pulse bg-primary" : "bg-muted-foreground"}`} aria-hidden />
              {running ? "LIVE" : "OFFLINE"}
            </span>
            <p className="text-xs text-muted-foreground">{running ? "Stream is running" : "Stream is offline"}</p>
            <div className="mt-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Uptime</p>
              <p className="font-mono text-sm">{status ? fmtTime(status.uptimeSec) : "--"}</p>
              {status && status.restarts > 0 && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">{status.restarts} restart{status.restarts === 1 ? "" : "s"}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col justify-center gap-1.5 px-5 py-5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Current Track</p>
            {np ? (
              <>
                <p className="truncate text-sm font-semibold">{np.title}</p>
                <p className="truncate text-xs text-muted-foreground">{np.artist || "Unknown artist"}</p>
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
                  <span>{fmtTime(np.elapsedInTrack)}</span>
                  <span>{fmtTime(np.duration)}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing playing</p>
            )}
          </div>

          <div className="flex flex-col justify-center gap-1.5 px-5 py-5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Next Track</p>
            {np?.next ? (
              <>
                <p className="truncate text-sm font-semibold">{np.next}</p>
                <p className="truncate text-xs text-muted-foreground">
                  Track {((np.index + 1) % np.total) + 1} of {np.total}
                </p>
                <Badge variant="secondary" className="mt-1.5 w-fit gap-1 font-mono text-[11px]">
                  <Timer className="size-3" aria-hidden />
                  Starts in {fmtTime(remainingInTrack)}
                </Badge>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">--</p>
            )}
          </div>

          <div className="flex flex-col justify-center gap-2 px-5 py-5 text-xs">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Gauge className="size-3.5" aria-hidden />
                Health
              </span>
              <span className={healthPct !== null && healthPct < 98 ? "font-mono text-destructive" : "font-mono text-foreground"}>
                {healthPct !== null ? `${healthPct}%` : "--"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <ShieldAlert className="size-3.5" aria-hidden />
                Dropped Frames
              </span>
              <span className="font-mono">{status?.progress.droppedFrames ?? "--"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Cast className="size-3.5" aria-hidden />
                Encoder
              </span>
              <span className="truncate font-mono">{encoderLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Monitor className="size-3.5" aria-hidden />
                Resolution
              </span>
              <span className="font-mono">{resolution ?? "--"}</span>
            </div>
          </div>
        </div>
      </Card>

      {/* 4 real-time metric cards with sparklines */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="CPU" value={system ? `${system.cpuPct}%` : "--"} history={cpuHistory} color="#60a5fa" />
        <MetricCard
          label="RAM"
          value={system ? `${fmtBytes(system.ramUsedBytes)} / ${fmtBytes(system.ramTotalBytes)}` : "--"}
          history={ramHistory}
          color="#a78bfa"
        />
        <MetricCard
          label="Bitrate"
          value={status?.progress.bitrate ? `${status.progress.bitrate} kbps` : "--"}
          history={bitrateHistory}
          color="#2dd4bf"
        />
        <MetricCard
          label="Storage"
          value={
            system?.diskTotalBytes && system.diskUsedBytes !== null
              ? `${fmtBytes(system.diskUsedBytes)} / ${fmtBytes(system.diskTotalBytes)}`
              : "--"
          }
          history={diskHistory}
          color="#fbbf24"
        />
      </div>

      {/* FFmpeg log tail -- this is the only place the real crash reason
          (stderr output, exit code/signal) is visible. Without it, a crash
          only ever showed the generic "FFmpeg crashed (code X); restarting"
          banner above with no way to see *why*. */}
      <LogConsole logs={logs} hasError={!!status?.lastError} />
    </div>
  )
}

function LogConsole({ logs, hasError }: { logs: string[]; hasError: boolean }) {
  const [open, setOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-open once if FFmpeg reports an error, so the reason is visible
  // without an extra click.
  useEffect(() => {
    if (hasError) setOpen(true)
  }, [hasError])

  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, open])

  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="size-4 text-muted-foreground" aria-hidden />
          FFmpeg Logs
          {logs.length > 0 && (
            <Badge variant="secondary" className="font-mono text-[11px]">
              {logs.length}
            </Badge>
          )}
        </span>
        {open ? (
          <ChevronUp className="size-4 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        )}
      </button>
      {open && (
        <CardContent className="px-4 pb-4">
          <div
            ref={scrollRef}
            className="h-64 w-full overflow-y-auto rounded-md border border-border bg-black/90 p-3 font-mono text-[11px] leading-relaxed text-green-400"
          >
            {logs.length === 0 ? (
              <p className="text-muted-foreground">No logs yet.</p>
            ) : (
              logs.map((line, i) => (
                <p key={i} className="whitespace-pre-wrap break-all">
                  {line}
                </p>
              ))
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) {
    return <div className="h-8 w-full" />
  }
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * 100
      const y = 100 - ((v - min) / range) * 100
      return `${x},${y}`
    })
    .join(" ")
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-8 w-full overflow-visible">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MetricCard({ label, value, history, color }: { label: string; value: string; history: number[]; color: string }) {
  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex flex-col gap-2 px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-lg font-semibold">{value}</p>
        <Sparkline data={history} color={color} />
      </CardContent>
    </Card>
  )
}
