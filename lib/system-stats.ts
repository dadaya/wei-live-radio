import os from "os"
import fs from "fs"
import { MUSIC_DIR } from "./state"

export interface SystemStats {
  cpuPct: number
  ramUsedBytes: number
  ramTotalBytes: number
  diskUsedBytes: number | null
  diskTotalBytes: number | null
}

/**
 * Real host system stats (not fabricated placeholders) for the dashboard's
 * CPU/RAM/Storage cards. Samples on its own fixed interval (independent of
 * how many browser tabs are connected via SSE) so the CPU delta calculation
 * stays meaningful even with multiple simultaneous dashboard viewers.
 */
class SystemStatsSampler {
  private lastCpuInfo: os.CpuInfo[] = os.cpus()
  private cached: SystemStats
  private timer: ReturnType<typeof setInterval>

  constructor() {
    this.cached = this.sample()
    this.timer = setInterval(() => {
      this.cached = this.sample()
    }, 2000)
    this.timer.unref?.()
  }

  private sample(): SystemStats {
    const cpus = os.cpus()
    let idleDelta = 0
    let totalDelta = 0
    for (let i = 0; i < cpus.length; i++) {
      const prev = this.lastCpuInfo[i]?.times
      const curr = cpus[i].times
      if (!prev) continue
      const idle = curr.idle - prev.idle
      const total = curr.user - prev.user + curr.nice - prev.nice + curr.sys - prev.sys + curr.irq - prev.irq + idle
      idleDelta += idle
      totalDelta += total
    }
    this.lastCpuInfo = cpus

    let cpuPct: number
    if (totalDelta > 0) {
      cpuPct = Math.min(100, Math.max(0, Math.round((1 - idleDelta / totalDelta) * 100)))
    } else {
      // First sample (no prior snapshot to diff against yet) -- fall back
      // to the 1-minute load average as a rough approximation.
      const load = os.loadavg()[0]
      cpuPct = Math.min(100, Math.round((load / Math.max(1, cpus.length)) * 100))
    }

    const totalMem = os.totalmem()
    const freeMem = os.freemem()

    let diskUsedBytes: number | null = null
    let diskTotalBytes: number | null = null
    try {
      const stat = fs.statfsSync(MUSIC_DIR)
      diskTotalBytes = stat.blocks * stat.bsize
      diskUsedBytes = diskTotalBytes - stat.bfree * stat.bsize
    } catch {
      // statfs unsupported on this platform/path -- the storage card just
      // hides itself when totals are null.
    }

    return {
      cpuPct,
      ramUsedBytes: totalMem - freeMem,
      ramTotalBytes: totalMem,
      diskUsedBytes,
      diskTotalBytes,
    }
  }

  getStats(): SystemStats {
    return this.cached
  }
}

const SINGLETON_KEY = "__weiRadioSystemStats_v1"
const globalForStats = globalThis as unknown as Record<string, SystemStatsSampler | undefined>

export function getSystemStats(): SystemStats {
  if (!globalForStats[SINGLETON_KEY]) {
    globalForStats[SINGLETON_KEY] = new SystemStatsSampler()
  }
  return globalForStats[SINGLETON_KEY]!.getStats()
}
