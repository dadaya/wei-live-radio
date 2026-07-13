import { NextResponse } from "next/server"
import { updateAuth } from "@/lib/state"
import { hashPassword, AUTH_COOKIE, AUTH_COOKIE_MAX_AGE } from "@/lib/auth"

export const runtime = "nodejs"

/**
 * Change or remove an already-configured password. Reached only while
 * authenticated -- proxy.ts doesn't put this path on its public allowlist,
 * so a valid session cookie is required to get here at all.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { newPassword?: string }
  const newPassword = (body.newPassword || "").trim()

  if (!newPassword) {
    updateAuth({ passwordHash: null })
    const res = NextResponse.json({ ok: true })
    res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 })
    return res
  }

  if (newPassword.length < 4) {
    return NextResponse.json({ error: "Password must be at least 4 characters." }, { status: 400 })
  }

  const passwordHash = await hashPassword(newPassword)
  updateAuth({ passwordHash })

  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE, passwordHash, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE,
  })
  return res
}
