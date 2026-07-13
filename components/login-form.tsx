"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { RadioTower, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setError(body.error || "Incorrect password")
        setBusy(false)
        return
      }
      router.replace(params.get("next") || "/")
      router.refresh()
    } catch {
      setError("Network error")
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <span className="mb-2 flex size-10 items-center justify-center rounded-md bg-primary">
            <RadioTower className="size-5 text-primary-foreground" aria-hidden />
          </span>
          <CardTitle className="text-lg">WeiRadio</CardTitle>
          <CardDescription>Enter the dashboard password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy || !password} className="gap-2">
              <Lock className="size-4" aria-hidden />
              {busy ? "Checking..." : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
