/** Shared password-hashing helper for the optional dashboard login. Uses
 * the Web Crypto API (available in both the Node.js and Edge runtimes) so
 * this file works the same from route handlers as from proxy.ts without
 * extra runtime pinning. Only the SHA-256 digest is ever persisted or put
 * in a cookie -- the plaintext password itself is never stored. */
export async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export const AUTH_COOKIE = "weiradio_auth"
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

/**
 * Whether to mark the auth cookie `Secure`. This must reflect the actual
 * connection the browser made, not just NODE_ENV -- a *lot* of self-hosted
 * deployments (a bare VPS by IP, or behind a reverse proxy without TLS yet)
 * run `next start` in production without HTTPS in front of them. Browsers
 * silently refuse to store a `Secure` cookie set over a plain HTTP
 * response, so `secure: process.env.NODE_ENV === "production"` -- which
 * always evaluates true for a deployed build -- meant the login/setup
 * cookie was routinely dropped on the client with zero error surfaced: the
 * POST to /api/login still returns 200, so the login form's "Checking..."
 * flips to a redirect that immediately bounces back to /login because the
 * cookie was never actually saved, over and over. Detecting the real
 * scheme (via the reverse proxy's X-Forwarded-Proto header, falling back
 * to the request URL) fixes that for both plain-HTTP and TLS-terminated
 * deployments.
 */
export function isRequestSecure(req: Request): boolean {
  const forwardedProto = req.headers.get("x-forwarded-proto")
  if (forwardedProto) return forwardedProto.split(",")[0].trim().toLowerCase() === "https"
  try {
    return new URL(req.url).protocol === "https:"
  } catch {
    return false
  }
}
