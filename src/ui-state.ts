import { dirname, join } from "node:path"
import { readFileSync } from "node:fs"
import { configPath } from "./config"
import { atomicJson } from "./storage"

export interface UiPreferences {
  version: 1
  icons: "nerd" | "plain"
  mediaDirectory: string
  exportDirectory: string
  libraryView: "runs" | "sources"
}

export function loadUiPreferences(): UiPreferences {
  const defaults: UiPreferences = { version: 1, icons: "nerd", mediaDirectory: process.env.HOME || process.cwd(), exportDirectory: process.env.HOME || process.cwd(), libraryView: "runs" }
  try {
    const saved = JSON.parse(readFileSync(join(dirname(configPath()), "ui.json"), "utf8"))
    if (saved.version !== 1) return defaults
    return { ...defaults, icons: saved.icons === "plain" ? "plain" : "nerd", libraryView: saved.libraryView === "sources" ? "sources" : "runs",
      mediaDirectory: typeof saved.mediaDirectory === "string" ? saved.mediaDirectory : defaults.mediaDirectory,
      exportDirectory: typeof saved.exportDirectory === "string" ? saved.exportDirectory : defaults.exportDirectory }
  } catch { return defaults }
}

export function saveUiPreferences(preferences: UiPreferences): void {
  atomicJson(join(dirname(configPath()), "ui.json"), preferences)
}
