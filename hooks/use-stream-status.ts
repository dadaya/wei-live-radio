"use client"

import { useEffect, useState } from "react"

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

export interface SystemStats {
  cpuPct: number
  ramUsedBytes: number
  ramTotalBytes: number
  diskUsedBytes: number | null
  diskTotalBytes: number | null
}

interface StatusPayload {
  status: StreamStatus
  logs: string[]
  system: SystemStats
}

/** Single SSE connection delivering live engine status, log tail, and host
 * system stats. */
export function useStreamStatus() {
  const [data, setData] = useState<StatusPayload | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const es = new EventSource("/api/status")
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      try {
        setData(JSON.parse(e.data) as StatusPayload)
      } catch {
        /* malformed frame */
      }
    }
    return () => es.close()
  }, [])

  return { status: data?.status ?? null, logs: data?.logs ?? [], system: data?.system ?? null, connected }
}
