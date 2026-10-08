import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeSettings } from "../src/config"
import { nextAvailableRunName } from "../src/service"
import { Library } from "../src/storage"

const roots: string[] = []
function temporary(): string { const path = join("/tmp", `transcribe-test-${crypto.randomUUID()}`); mkdirSync(path, { recursive: true }); roots.push(path); return path }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("library", () => {
  test("exports TXT and JSON to home paths and rejects empty paths or directories", () => {
    const root = temporary(), home = process.env.HOME
    const library = new Library(join(root, "state"))
    const source = library.sourceFor("local", "/tmp/example.m4a", "Example")
    const run = library.createRun(source, "export", normalizeSettings())
    library.updateRun(run.id, { status: "completed" })
    writeFileSync(join(run.artifactDir, "transcript.txt"), "hello\n")
    writeFileSync(join(run.artifactDir, "transcript.json"), JSON.stringify({ text: "hello" }))
    process.env.HOME = join(root, "home")
    try {
      for (const format of ["txt", "json"] as const) {
        const destination = join(root, "home", "Downloads", `one.${format}`)
        expect(library.exportRun(run.id, format, ` ~/Downloads/one.${format} `)).toBe(destination)
        expect(readFileSync(destination, "utf8")).toBe(readFileSync(join(run.artifactDir, `transcript.${format}`), "utf8"))
      }
      expect(existsSync(join(root, "~"))).toBe(false)
      expect(() => library.exportRun(run.id, "txt", "  ")).toThrow("Enter an export file path.")
      expect(() => library.exportRun(run.id, "txt", "~/Downloads")).toThrow("not a directory")
    } finally { process.env.HOME = home; library.close() }
  })

  test("chooses a stable suffix for repeated quick runs", () => {
    expect(nextAvailableRunName("meeting — gpt-4o-transcribe", ["meeting — gpt-4o-transcribe", "meeting — gpt-4o-transcribe (2)"])).toBe("meeting — gpt-4o-transcribe (3)")
  })

  test("creates, resolves, renames, duplicates, and deletes runs", () => {
    const library = new Library(temporary())
    expect(statSync(join(library.root, "library.sqlite3")).mode & 0o777).toBe(0o600)
    const source = library.sourceFor("local", "/tmp/example.m4a", "Example")
    const run = library.createRun(source, "first", normalizeSettings())
    expect(library.runByReference(run.id.slice(0, 12))?.name).toBe("first")
    expect(library.updateRun(run.id, { name: "renamed" }).name).toBe("renamed")
    const duplicate = library.duplicateRun(run.id, "second")
    expect(duplicate.settings).toEqual(run.settings)
    library.deleteRun(duplicate.id)
    expect(library.runByReference(duplicate.id)).toBeNull()
    library.close()
  })

  test("imports legacy manifests idempotently", () => {
    const root = temporary(), legacy = join(root, "legacy", "source", "runs", "groq-v3")
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "run.json"), JSON.stringify({ source: "/tmp/source.m4a", provider: "groq", model: "whisper-large-v3", language: "en", chunk_seconds: 200 }))
    writeFileSync(join(legacy, "transcript.txt"), "hello\n")
    const library = new Library(join(root, "state"))
    expect(library.migrateLegacy([join(root, "legacy")])).toEqual({ sources: 1, runs: 1 })
    expect(library.migrateLegacy([join(root, "legacy")])).toEqual({ sources: 0, runs: 0 })
    expect(library.listRuns()[0]?.status).toBe("completed")
    expect(library.listRuns()[0]?.model).toBe("whisper-large-v3")
    library.close()
  })
})
