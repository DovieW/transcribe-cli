import type { ChunkRecord } from "./types"

export function durationLabel(seconds: number): string {
  const value = Math.max(0, Math.ceil(seconds))
  return value >= 3600 ? `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m` : value >= 60 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${value}s`
}

export function runProgress(chunks: ChunkRecord[], elapsedSeconds: number, initialCompletedSeconds = 0) {
  const completed = chunks.filter((chunk) => chunk.status === "completed")
  const totalSeconds = chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0)
  const completedSeconds = completed.reduce((sum, chunk) => sum + chunk.durationSeconds, 0)
  const processed = completedSeconds - initialCompletedSeconds
  const remaining = Math.max(0, totalSeconds - completedSeconds)
  return {
    completed: completed.length, total: chunks.length,
    active: chunks.filter((chunk) => chunk.status === "active").length,
    fraction: totalSeconds ? completedSeconds / totalSeconds : 0,
    eta: !remaining && chunks.length ? 0 : processed > 0 && elapsedSeconds > 0 ? elapsedSeconds * remaining / processed : null,
  }
}

export function progressBar(fraction: number, width = 20): string {
  const filled = Math.floor(Math.max(0, Math.min(1, fraction)) * width)
  return `▕${"█".repeat(filled)}${"░".repeat(width - filled)}▏ ${Math.floor(fraction * 100)}%`
}
