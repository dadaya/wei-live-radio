import { NextResponse } from "next/server"
import { readState } from "@/lib/state"
import { hashPassword, isRequestSecure, AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from "@/lib/auth"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const state = readState()
  const passwordHash = state.auth.passwordHash
  if (!passwordHash) {
    // Nothing configured server-side -- nothing to unlock.
    return NextResponse.json({ ok: true })
  }

  const { password } = (await req.json().catch(() => ({}))) as { password?: string }
  if (!password || (await hashPassword(password)) !== passwordHash) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 })
  }

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
