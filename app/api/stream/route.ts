import { NextResponse } from "next/server"
import { getStreamer } from "@/lib/streamer"

export const runtime = "nodejs"

export async function POST(req: Request) {
  try {
    const { action } = (await req.json()) as { action: "start" | "stop" | "restart" }
    const streamer = getStreamer()

    if (action === "start") {
      const result = await streamer.start()
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      return NextResponse.json({ ok: true })
    }
    if (action === "stop") {
      streamer.stop()
      return NextResponse.json({ ok: true })
    }
    if (action === "restart") {
      const result = await streamer.restart()
      if (result && !result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
