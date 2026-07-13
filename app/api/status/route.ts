import { getStreamer } from "@/lib/streamer"
import { getSystemStats } from "@/lib/system-stats"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const streamer = getStreamer()
  const encoder = new TextEncoder()

  let interval: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        const payload = JSON.stringify({
          status: streamer.getStatus(),
          logs: streamer.getLogs().slice(-60),
          system: getSystemStats(),
        })
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
        } catch {
          cleanup()
        }
      }
      const cleanup = () => {
        if (interval) clearInterval(interval)
        interval = null
        unsubscribe?.()
        unsubscribe = null
      }
      send()
      interval = setInterval(send, 2000)
      unsubscribe = streamer.onUpdate(send)
    },
    cancel() {
      if (interval) clearInterval(interval)
      unsubscribe?.()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
