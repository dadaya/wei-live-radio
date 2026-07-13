/**
 * Browser-side upload helper shared by the playlist manager (music) and the
 * settings form (background video).
 *
 * Each file is sent as its own request with the raw bytes as the body (see
 * app/api/upload/route.ts) so the server can stream it to disk with constant
 * memory, and so one bad file never takes down the others. XMLHttpRequest is
 * used instead of fetch because fetch still has no portable upload-progress
 * events -- and real progress is non-negotiable for multi-hundred-MB audio
 * uploads on slow links.
 */

export type UploadKind = "music" | "video"

export class UploadError extends Error {
  /** True when retrying the exact same file might succeed (network blips,
   * server hiccups) -- false for things like an unsupported extension. */
  readonly retryable: boolean
  readonly status: number | null

  constructor(message: string, opts: { retryable: boolean; status?: number | null }) {
    super(message)
    this.name = "UploadError"
    this.retryable = opts.retryable
    this.status = opts.status ?? null
  }
}

function messageForStatus(status: number, serverMessage: string | undefined): { message: string; retryable: boolean } {
  if (serverMessage) {
    // The route returns human-readable errors; trust them. Type/size
    // problems won't fix themselves on retry, everything else might.
    const permanent = status === 415 || status === 413 || status === 400
    return { message: serverMessage, retryable: !permanent }
  }
  if (status === 413) return { message: "File is larger than the server allows.", retryable: false }
  if (status === 401) return { message: "Session expired. Reload the page and log in again.", retryable: true }
  if (status === 507) return { message: "The server is out of disk space.", retryable: true }
  return { message: `Server error (HTTP ${status}).`, retryable: true }
}

export interface UploadOptions {
  /** Called with 0..1 as the browser pushes bytes to the server. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** Uploads one file; resolves with the saved (sanitized) filename. */
export function uploadFile(file: File, kind: UploadKind, opts: UploadOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const url = `/api/upload?kind=${kind}&filename=${encodeURIComponent(file.name)}`
    xhr.open("POST", url)
    xhr.responseType = "json"

    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new UploadError("Upload canceled.", { retryable: true }))
        return
      }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true })
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(e.total ? e.loaded / e.total : 0)
    }

    xhr.onload = () => {
      const body = (xhr.response ?? null) as { saved?: string[]; error?: string } | null
      if (xhr.status >= 200 && xhr.status < 300 && body?.saved?.length) {
        opts.onProgress?.(1)
        resolve(body.saved[0])
        return
      }
      const { message, retryable } = messageForStatus(xhr.status, body?.error)
      reject(new UploadError(message, { retryable, status: xhr.status }))
    }

    // Fires on network-level failures: connection dropped mid-upload,
    // server restarted, reverse proxy cut the request off, etc.
    xhr.onerror = () =>
      reject(
        new UploadError("Network error -- the connection to the server was lost mid-upload.", {
          retryable: true,
        }),
      )
    xhr.onabort = () => reject(new UploadError("Upload canceled.", { retryable: true }))

    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.send(file)
  })
}
