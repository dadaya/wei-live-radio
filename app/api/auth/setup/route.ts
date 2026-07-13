import { NextResponse } from "next/server"
import { readState, updateAuth } from "@/lib/state"
import { hashPassword, isRequestSecure, AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from "@/lib/auth"

export const runtime = "nodejs"

/**
 * First-run (or "set it up later from Settings") password setup. Only
 * usable while no password is currently configured -- once one is set,
 * changing or removing it goes through /api/auth/change instead, which
 * requires an authenticated session.
 */
export async function POST(req: Request) {
  const state = readState()
  if (state.auth.passwordHash) {
    return NextResponse.json(
      { error: "A password is already set. Use Settings > Security to change it." },
      { status: 400 },
    )
  }

  const body = (await req.json().catch(() => ({}))) as { password?: string; skip?: boolean }

  if (body.skip) {
    updateAuth({ onboardingDone: true })
    return NextResponse.json({ ok: true })
  }

  const password = (body.password || "").trim()
  if (password.length < 4) {
    return NextResponse.json({ error: "Password must be at least 4 characters." }, { status: 400 })
  }

  const passwordHash = await hashPassword(password)
  updateAuth({ passwordHash, onboardingDone: true })

  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE, passwordHash, {
    httpOnly: true,
    sameSite: "lax",
    secure: isRequestSecure(req),
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE,
  })
  return res
}
