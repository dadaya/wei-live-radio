import { NextResponse, type NextRequest } from "next/server"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import { MUSIC_DIR, VIDEO_DIR, ensureDirs, readState } from "@/lib/state"
import { isAudioFile, isVideoFile } from "@/lib/scan"
import { AUTH_COOKIE } from "@/lib/auth"

export const runtime = "nodejs"

/**
 * Upload endpoint, rebuilt for large media files.
 *
 * The old implementation was `await req.formData()` + `file.arrayBuffer()` +
 * `fs.writeFileSync`: every uploaded file (and with multi-select, ALL files
 * of one request combined) was buffered fully in RAM, twice, on a server
 * that is explicitly speced to run on a weak 1-vCPU VPS with ~80 MB of
 * panel RAM. A single long DJ mix -- let alone several at once -- blew the
 * process memory, the request died mid-flight and the client surfaced a
 * generic "Upload failed." with no way to tell what happened.
 *
 * New protocol (used by lib/upload-client.ts):
 *   POST /api/upload?kind=music&filename=<name>
 *   body: the raw file bytes (application/octet-stream)
 *
 * One file per request, streamed straight from the socket to disk with
 * constant memory usage, written to a temp file and renamed into place only
 * on success (so a dropped connection never leaves a half-written track for
 * the FFmpeg playlist to trip over). The legacy multipart form path is kept
 * for compatibility, but also streams to disk now.
 *
 * NOTE: this route is deliberately excluded from proxy.ts's matcher --
 * Next 16's proxy buffers the whole request body in memory before the
 * route ever sees it (capped by `proxyClientMaxBodySize`), which would
 * defeat the streaming. Because the proxy no longer guards it, this route
 * performs the same auth check itself (see requireAuth below).
 */

// Per-file cap. Generous for audio/video, but prevents one bad request
// from filling the disk. Override with MAX_UPLOAD_MB if you need more.
const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 4096) * 1024 * 1024

function sanitize(name: string): string {
  // Allow unicode letters/digits (cyrillic track names etc.) -- the concat
  // playlist escapes paths, so they are safe for FFmpeg. Strip path
  // separators and anything else exotic.
  return path.basename(name).replace(/[^\p{L}\p{N}._\- ()\[\]]/gu, "_")
}

/** Same gate proxy.ts applies to every other route (see note above). */
function requireAuth(req: NextRequest): NextResponse | null {
  const { passwordHash, onboardingDone } = readState().auth
  if (!onboardingDone) {
    return NextResponse.json({ error: "Setup required" }, { status: 428 })
  }
  if (!passwordHash) return null
  const cookie = req.cookies.get(AUTH_COOKIE)?.value
  if (cookie && cookie === passwordHash) return null
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

class TooLargeError extends Error {
  constructor() {
    super("File exceeds the upload size limit")
  }
}

/** Streams `source` to `<dir>/<name>` via a temp file; atomic on success. */
async function streamToFile(source: Readable, dir: string, name: string): Promise<void> {
  const tmp = path.join(dir, `.upload-${crypto.randomBytes(8).toString("hex")}.part`)
  let received = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) cb(new TooLargeError())
      else cb(null, chunk)
    },
  })
  try {
    await pipeline(source, limiter, fs.createWriteStream(tmp))
    fs.renameSync(tmp, path.join(dir, name))
  } catch (err) {
    // Never leave partial files behind -- media/music is scanned blindly.
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

function kindConfig(kind: string | null) {
  if (kind === "music") return { dir: MUSIC_DIR, validate: isAudioFile, hint: ".mp3 .flac .ogg .wav .m4a .aac" }
  if (kind === "video") return { dir: VIDEO_DIR, validate: isVideoFile, hint: ".mp4 .mkv .webm .mov .gif" }
  return null
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof TooLargeError) {
    return NextResponse.json(
      { error: `File is larger than the server limit (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB). Raise MAX_UPLOAD_MB to allow bigger files.` },
      { status: 413 },
    )
  }
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === "ENOSPC") {
    return NextResponse.json({ error: "The server is out of disk space." }, { status: 507 })
  }
  const message = (err as Error)?.message ?? ""
  if (
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ECONNRESET" ||
    (err as Error)?.name === "AbortError" ||
    message === "aborted"
  ) {
    // Client went away mid-upload; nothing useful to report back.
    return NextResponse.json({ error: "Upload connection was interrupted." }, { status: 400 })
  }
  console.error("[upload] failed:", err)
  return NextResponse.json({ error: "Upload failed on the server. Check the server logs." }, { status: 500 })
}

export async function POST(req: NextRequest) {
  const denied = requireAuth(req)
  if (denied) return denied
  ensureDirs()

  const contentType = req.headers.get("content-type") || ""
  if (contentType.includes("multipart/form-data")) {
    return handleMultipart(req)
  }

  // --- Streaming path: one raw file body per request ---
  const cfg = kindConfig(req.nextUrl.searchParams.get("kind"))
  if (!cfg) return NextResponse.json({ error: "kind must be music or video" }, { status: 400 })

  const rawName = req.nextUrl.searchParams.get("filename") || ""
  const name = sanitize(rawName)
  if (!name || name === "." || name === "..") {
    return NextResponse.json({ error: "filename query parameter is required" }, { status: 400 })
  }
  if (!cfg.validate(name)) {
    return NextResponse.json(
      { error: `Unsupported file type "${path.extname(name) || "?"}". Supported: ${cfg.hint}` },
      { status: 415 },
    )
  }
  if (!req.body) return NextResponse.json({ error: "Empty request body" }, { status: 400 })

  // Reject oversized uploads up front when the browser declared a length,
  // instead of streaming gigabytes just to fail at the cap.
  const declared = Number(req.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return errorResponse(new TooLargeError())
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await streamToFile(Readable.fromWeb(req.body as any), cfg.dir, name)
    return NextResponse.json({ saved: [name], rejected: [] })
  } catch (err) {
    return errorResponse(err)
  }
}

/** Legacy multipart path (kept for compatibility); streams files to disk. */
async function handleMultipart(req: NextRequest) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json(
      { error: "Could not parse the upload request (it may have been cut off in transit)." },
      { status: 400 },
    )
  }
  const cfg = kindConfig(form.get("kind") as string)
  if (!cfg) return NextResponse.json({ error: "kind must be music or video" }, { status: 400 })

  const files = form.getAll("files") as File[]
  if (!files.length) return NextResponse.json({ error: "No files provided" }, { status: 400 })

  const saved: string[] = []
  const rejected: string[] = []
  for (const file of files) {
    const name = sanitize(file.name)
    if (!cfg.validate(name)) {
      rejected.push(file.name)
      continue
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await streamToFile(Readable.fromWeb(file.stream() as any), cfg.dir, name)
      saved.push(name)
    } catch (err) {
      return errorResponse(err)
    }
  }
  return NextResponse.json({ saved, rejected })
}
