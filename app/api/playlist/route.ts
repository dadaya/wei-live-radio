import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"
import { getOrderedPlaylist } from "@/lib/scan"
import { readState, writeState, MUSIC_DIR } from "@/lib/state"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const tracks = await getOrderedPlaylist()
  return NextResponse.json({ tracks })
}

export async function POST(req: Request) {
  const body = (await req.json()) as { order?: string[] }
  if (!Array.isArray(body.order)) {
    return NextResponse.json({ error: "order array required" }, { status: 400 })
  }
  const state = readState()
  // Only accept filenames that actually exist in the current playlist
  const existing = new Set(state.playlistOrder)
  const newOrder = body.order.filter((f) => existing.has(f))
  for (const f of state.playlistOrder) if (!newOrder.includes(f)) newOrder.push(f)
  state.playlistOrder = newOrder
  writeState(state)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const { filename } = (await req.json()) as { filename: string }
  if (!filename || filename.includes("/") || filename.includes("..")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 })
  }
  const full = path.join(MUSIC_DIR, filename)
  try {
    fs.unlinkSync(full)
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 })
  }
  const state = readState()
  state.playlistOrder = state.playlistOrder.filter((f) => f !== filename)
  writeState(state)
  return NextResponse.json({ ok: true })
}
