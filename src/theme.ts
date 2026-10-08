export const theme = {
  background: "#0b121b", panel: "#111c29", border: "#28394b", accent: "#67d8ce",
  text: "#dfebf5", muted: "#9bafc3", selected: "#183e49", green: "#93d9a3",
  red: "#f28b91", amber: "#eac584",
}

const glyphs = {
  home: ["\uf015", "⌂"], new: ["\uf067", "+"], quick: ["\uf0e7", ">"], library: ["\uf02d", "≡"],
  jobs: ["\uf085", "↻"], compare: ["\uf0ec", "⇄"], auth: ["\uf084", "*"], settings: ["\uf013", "⚙"],
  help: ["\uf059", "?"], folder: ["\uf07b", "/"], file: ["\uf15b", "·"], audio: ["\uf001", "♪"],
  video: ["\uf03d", ">"], view: ["\uf15c", "≡"], copy: ["\uf0c5", "="], export: ["\uf019", "↓"],
  completed: ["\uf00c", "✓"], failed: ["\uf071", "!"], paused: ["\uf04c", "Ⅱ"], active: ["\uf110", "↻"],
  resume: ["\uf04b", ">"], back: ["\uf060", "←"], delete: ["\uf1f8", "×"], rename: ["\uf040", "~"],
  search: ["\uf002", "/"], quit: ["\uf011", "×"], provider: ["\uf0c2", "◇"], info: ["\uf05a", "i"],
} as const
export type IconName = keyof typeof glyphs
export function icon(name: IconName, style: "nerd" | "plain"): string { return glyphs[name][style === "nerd" ? 0 : 1] }
export function actionIcon(value: unknown, name: string): IconName {
  const id = String(value)
  if (id.startsWith("export")) return "export"
  if (id in glyphs) return id as IconName
  if (/folder|directory/i.test(name)) return "folder"
  if (/provider|model/i.test(name)) return "provider"
  if (/pause/i.test(name)) return "paused"
  if (/restart/i.test(name)) return "resume"
  if (/duplicate/i.test(name)) return "copy"
  if (/save|use this/i.test(name)) return "completed"
  if (/back|cancel|parent/i.test(name)) return "back"
  return "file"
}
export function statusIcon(status: string): IconName {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : status === "paused" || status === "pausing" ? "paused" : ["preparing", "transcribing"].includes(status) ? "active" : "file"
}
