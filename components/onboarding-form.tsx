"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { RadioTower, ShieldCheck, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export function OnboardingForm() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function finish(body: { password?: string; skip?: boolean }) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        setError(data.error || "Something went wrong")
        setBusy(false)
        return
      }
      router.replace("/")
      router.refresh()
    } catch {
      setError("Network error")
      setBusy(false)
    }
  }

  function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 4) {
      setError("Password must be at least 4 characters.")
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    void finish({ password })
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <span className="mb-2 flex size-11 items-center justify-center rounded-md bg-primary">
            <RadioTower className="size-5 text-primary-foreground" aria-hidden />
          </span>
          <CardTitle className="text-lg">Welcome to WeiRadio</CardTitle>
          <CardDescription>
            Protect your dashboard with a password before exposing it to the internet -- it can start/stop the
            stream, change your RTMP key, and manage media. You can also set this up later from Settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitPassword} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="onb-password">Password</Label>
              <Input
                id="onb-password"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="onb-confirm">Confirm password</Label>
              <Input
                id="onb-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={busy} className="gap-2 sm:flex-1">
                <ShieldCheck className="size-4" aria-hidden />
                Set password
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                className="gap-2 sm:flex-1"
                onClick={() => void finish({ skip: true })}
              >
                Skip for now
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
