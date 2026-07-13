"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { RadioTower, ListMusic, Settings2, LogOut } from "lucide-react"
import { cn } from "@/lib/utils"

const NAV = [
  { href: "/", label: "Dashboard", icon: RadioTower },
  { href: "/playlist", label: "Playlist", icon: ListMusic },
  { href: "/settings", label: "Settings", icon: Settings2 },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()

  async function logout() {
    await fetch("/api/logout", { method: "POST" })
    router.replace("/login")
    router.refresh()
  }

  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="flex w-full shrink-0 flex-row items-center gap-1 border-b border-border bg-sidebar px-4 py-3 md:min-h-svh md:w-52 md:flex-col md:items-stretch md:border-b-0 md:border-r md:px-3 md:py-6">
        <div className="mr-4 flex items-center gap-2 md:mr-0 md:mb-8 md:px-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary">
            <RadioTower className="size-4 text-primary-foreground" aria-hidden />
          </span>
          <span className="text-sm font-semibold tracking-tight">WeiRadio</span>
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-row gap-1 md:flex-none md:flex-col">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                pathname === href
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden />
              <span className="hidden sm:inline">{label}</span>
            </Link>
          ))}
        </nav>
        <p className="mt-auto hidden px-3 text-xs text-muted-foreground md:block">
          24/7 radio streamer
        </p>
        <button
          type="button"
          onClick={logout}
          className="hidden items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground md:flex"
        >
          <LogOut className="size-3.5" aria-hidden />
          Log out
        </button>
      </aside>
      <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  )
}
