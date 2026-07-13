import { NextResponse } from "next/server"
import { readState } from "@/lib/state"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const state = readState()
  return NextResponse.json({
    hasPassword: !!state.auth.passwordHash,
    onboardingDone: state.auth.onboardingDone,
  })
}
