#!/usr/bin/env node
// Runs automatically after `npm install` / `pnpm install` (see package.json
// "postinstall"). Makes sure a *system* ffmpeg is available and points
// FFMPEG_PATH at it.
//
// Why this exists: the bundled `ffmpeg-static` package ships a fully static
// glibc build (johnvansickle.com). Static glibc binaries are well known to
// be unable to load NSS modules for DNS resolution -- and on affected
// Linux hosts this doesn't fail gracefully, it segfaults (SIGSEGV) the
// instant FFmpeg tries to open a network destination by hostname (e.g. the
// RTMP URL). Purely local operations (reading local media, writing a local
// file) never hit that code path, so this only ever shows up on a real
// deploy, as an instant, 100%-reproducible crash-loop the moment you press
// "Start Stream" -- see getFfmpegPath() in lib/ffmpeg-args.ts for the full
// writeup and links to the upstream reports.
//
// System ffmpeg (installed via the OS package manager) is dynamically
// linked against the host's own glibc, so this class of bug doesn't apply.
// This script is best-effort and NEVER fails the install: if it can't
// detect a supported package manager, doesn't have root/sudo, or anything
// else goes sideways, it just prints instructions and exits 0. FFMPEG_PATH
// can always be set by hand afterwards (see SPEC.md).
"use strict"

const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")

function run(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim()
}

function tryRun(cmd) {
  try {
    return { ok: true, out: run(cmd) }
  } catch (err) {
    return { ok: false, err }
  }
}

function findSystemFfmpeg() {
  for (const c of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    if (fs.existsSync(c)) return c
  }
  const which = tryRun("command -v ffmpeg")
  if (which.ok && which.out) return which.out
  return null
}

function setEnvVar(projectRoot, key, value) {
  const envPath = path.join(projectRoot, ".env")
  let lines = []
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, "utf8").split("\n")
  }
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`))
  const line = `${key}=${value}`
  if (idx >= 0) {
    lines[idx] = line
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("")
    lines.push(line)
  }
  fs.writeFileSync(envPath, lines.join("\n").replace(/\n{3,}/g, "\n\n"))
}

function main() {
  const projectRoot = process.cwd()

  const existing = findSystemFfmpeg()
  if (existing) {
    console.log(`[ensure-ffmpeg] System ffmpeg already present at ${existing}. Using it (FFMPEG_PATH set).`)
    setEnvVar(projectRoot, "FFMPEG_PATH", existing)
    return
  }

  console.log("[ensure-ffmpeg] No system ffmpeg found -- attempting to install one so streaming doesn't rely on the bundled static binary...")

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0
  const sudo = isRoot ? "" : "sudo -n "

  const installers = [
    { check: "command -v apt-get", install: `${sudo}apt-get update -y && ${sudo}apt-get install -y ffmpeg` },
    { check: "command -v dnf", install: `${sudo}dnf install -y ffmpeg` },
    { check: "command -v yum", install: `${sudo}yum install -y ffmpeg` },
    { check: "command -v apk", install: `${sudo}apk add --no-cache ffmpeg` },
    { check: "command -v pacman", install: `${sudo}pacman -Sy --noconfirm ffmpeg` },
  ]

  for (const { check, install } of installers) {
    if (!tryRun(check).ok) continue
    console.log(`[ensure-ffmpeg] Detected package manager, running: ${install}`)
    const result = tryRun(install)
    if (result.ok) {
      const installed = findSystemFfmpeg()
      if (installed) {
        console.log(`[ensure-ffmpeg] Installed system ffmpeg at ${installed}. FFMPEG_PATH set in .env.`)
        setEnvVar(projectRoot, "FFMPEG_PATH", installed)
        return
      }
    }
    console.warn("[ensure-ffmpeg] Install attempt failed (likely missing sudo/root). See message below.")
    break
  }

  console.warn(
    "[ensure-ffmpeg] Could not auto-install system ffmpeg (no supported package manager reachable without a " +
      "password, or none detected). The app will fall back to the bundled ffmpeg-static binary, which is known " +
      "to crash instantly on some Linux hosts as soon as it tries to reach a network RTMP destination.\n" +
      "  Fix manually once, then re-run: npm run setup:ffmpeg (or just):\n" +
      "    sudo apt-get install -y ffmpeg   # Debian/Ubuntu\n" +
      "    sudo dnf install -y ffmpeg       # Fedora/RHEL\n" +
      "    sudo apk add ffmpeg              # Alpine\n" +
      "  Then set FFMPEG_PATH=/usr/bin/ffmpeg (or wherever it installed) in your .env / process environment.",
  )
}

try {
  main()
} catch (err) {
  // Never fail `npm install` because of this helper.
  console.warn(`[ensure-ffmpeg] Skipped (unexpected error: ${err && err.message ? err.message : err})`)
}
