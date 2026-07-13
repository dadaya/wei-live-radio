import { NextResponse, type NextRequest } from "next/server"
import { readState } from "@/lib/state"
import { AUTH_COOKIE } from "@/lib/auth"

// Reachable no matter what auth/onboarding state we're in.
const ALWAYS_PUBLIC = new Set(["/api/auth/status", "/api/auth/setup", "/api/login", "/api/logout"])

/**
 * Gates the whole dashboard behind an optional password.
 *
 * First run always lands on /onboarding so the user can set a password (or
 * explicitly skip it via /api/auth/setup). If they skip, the dashboard
 * stays open and a password can be added later from Settings > Security --
 * that's why this check is state-driven (data/state.json) rather than a
 * one-time env var: it has to be toggleable from inside the running app.
 *
 * Runs on the Node.js runtime by default in Next.js 16, so a plain
 * `readState()` (which uses `fs`) works fine here.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (ALWAYS_PUBLIC.has(pathname)) return NextResponse.next()

  const state = readState()
  const { passwordHash, onboardingDone } = state.auth

  if (!onboardingDone) {
    if (pathname === "/onboarding") return NextResponse.next()
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Setup required" }, { status: 428 })
    }
    return NextResponse.redirect(new URL("/onboarding", req.url))
  }

  if (!passwordHash) {
    // Onboarding resolved with no password chosen: dashboard stays open.
    if (pathname === "/login" || pathname === "/onboarding") {
      return NextResponse.redirect(new URL("/", req.url))
    }
    return NextResponse.next()
  }

  if (pathname === "/onboarding") {
    return NextResponse.redirect(new URL("/", req.url))
  }
  if (pathname === "/login") return NextResponse.next()

  const cookie = req.cookies.get(AUTH_COOKIE)?.value
  if (cookie && cookie === passwordHash) return NextResponse.next()

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const loginUrl = new URL("/login", req.url)
  loginUrl.searchParams.set("next", pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // /api/upload is deliberately NOT matched: Next 16's proxy buffers the
  // whole request body in memory before forwarding (capped by
  // `proxyClientMaxBodySize`), which both breaks streaming uploads of large
  // media files and can OOM a weak server. The upload route performs the
  // exact same auth check itself (see app/api/upload/route.ts).
  matcher: ["/((?!api/upload|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|gif)$).*)"],
}
