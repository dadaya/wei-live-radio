"use client"

import { useState } from "react"
import useSWR from "swr"
import { ShieldCheck, ShieldOff, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function SecurityForm() {
  const { data, mutate } = useSWR<{ hasPassword: boolean }>("/api/auth/status", fetcher)
  const [newPassword, setNewPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasPassword = data?.hasPassword ?? false

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMsg(null)
    if (newPassword.length < 4) {
      setError("Password must be at least 4 characters.")
      return
    }
    if (newPassword !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setBusy(true)
    const endpoint = hasPassword ? "/api/auth/change" : "/api/auth/setup"
    const body = hasPassword ? { newPassword } : { password: newPassword }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const data = (await res.json()) as { error?: string }
      setError(data.error || "Something went wrong")
    } else {
      setNewPassword("")
      setConfirm("")
      setMsg(hasPassword ? "Password changed." : "Password set. The dashboard is now protected.")
      await mutate()
    }
    setBusy(false)
  }

  async function removePassword() {
    setBusy(true)
    setError(null)
    setMsg(null)
    const res = await fetch("/api/auth/change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: "" }),
    })
    if (!res.ok) {
      const data = (await res.json()) as { error?: string }
      setError(data.error || "Something went wrong")
    } else {
      setMsg("Password protection removed.")
      await mutate()
    }
    setBusy(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {hasPassword ? (
            <ShieldCheck className="size-4 text-primary" aria-hidden />
          ) : (
            <ShieldOff className="size-4 text-muted-foreground" aria-hidden />
          )}
          Security
        </CardTitle>
        <CardDescription>
          {hasPassword
            ? "The dashboard is password-protected. Anyone without the password is redirected to a login screen."
            : "The dashboard is currently open to anyone who can reach it. Set a password before exposing it to the internet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(msg || error) && (
          <p
            className={`rounded-md border px-3 py-2 text-sm ${
              error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-card text-muted-foreground"
            }`}
          >
            {error || msg}
          </p>
        )}
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-password">{hasPassword ? "New password" : "Password"}</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password">Confirm</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy} className="gap-2">
              <KeyRound className="size-4" aria-hidden />
              {hasPassword ? "Change password" : "Set password"}
            </Button>
            {hasPassword && (
              <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={removePassword}>
                Remove password
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
