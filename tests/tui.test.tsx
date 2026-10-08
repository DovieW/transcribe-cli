import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createTranscribeApp, type TuiDependencies } from "../src/tui"
import { Library } from "../src/storage"
import { normalizeSettings } from "../src/config"
import type { RunRecord } from "../src/types"

type Setup = Awaited<ReturnType<typeof testRender>>
const cleanup: Array<() => void> = []
const originalConfig = process.env.XDG_CONFIG_HOME
async function app(dependencies: TuiDependencies = {}, width = 120, height = 40) {
  const root = `/tmp/transcribe-ui-${crypto.randomUUID()}`
  mkdirSync(root, { recursive: true }); process.env.XDG_CONFIG_HOME = join(root, "config")
  const library = new Library(join(root, "state"))
  const source = library.sourceFor("local", "/tmp/example.m4a", "Example recording")
  const run = library.createRun(source, "First pass", normalizeSettings())
  library.writeTranscript(run, { schemaVersion: 1, runId: run.id, source, provider: run.provider, model: run.model, language: "en", text: "A transcript worth reading.", segments: [], usage: {}, createdAt: new Date().toISOString() })
  library.updateRun(run.id, { status: "completed" })
  const App = createTranscribeApp(library, dependencies)
  const setup = await testRender(() => <App />, { width, height, exitOnCtrlC: false })
  cleanup.push(() => { setup.renderer.destroy(); library.close(); rmSync(root, { recursive: true, force: true }) })
  await setup.flush()
  return { setup, root, library, run }
}
afterEach(() => { for (const close of cleanup.splice(0)) close(); process.env.XDG_CONFIG_HOME = originalConfig })
async function choose(setup: Setup, label: string) {
  setup.mockInput.pressKey("u", { ctrl: true }); await setup.mockInput.typeText(label); await setup.flush(); setup.mockInput.pressEnter(); await setup.flush()
}
async function command(setup: Setup, label: string) {
  setup.mockInput.pressKey("p", { ctrl: true }); await setup.flush(); await setup.mockInput.typeText(label); await setup.flush(); setup.mockInput.pressEnter(); await setup.flush()
}
async function back(setup: Setup) { setup.mockInput.pressEscape(); await Bun.sleep(40); await setup.flush() }
async function input(setup: Setup, value: string) { setup.mockInput.pressKey("u", { ctrl: true }); await setup.mockInput.typeText(value); await setup.flush() }

describe("workbench", () => {
  test("library preserves filtering, offers contextual actions, copies and views text", async () => {
    const { setup } = await app()
    await choose(setup, "library")
    expect(setup.captureCharFrame()).toContain("Library · all runs")
    await choose(setup, "First pass")
    expect(setup.captureCharFrame()).toContain("View transcript")
    expect(setup.captureCharFrame()).not.toContain("Continue incomplete chunks")
    const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true)
    await choose(setup, "Copy transcript")
    expect(copy).toHaveBeenCalledWith("A transcript worth reading.\n")
    expect(setup.captureCharFrame()).toContain("Transcript copied to clipboard")
    copy.mockReturnValue(false)
    setup.mockInput.pressEnter(); await setup.flush()
    expect(setup.captureCharFrame()).toContain("did not accept clipboard copy")
    copy.mockRestore()
    await choose(setup, "View transcript")
    await setup.mockInput.typeText("worth"); await setup.flush()
    expect(setup.captureCharFrame()).toContain("1/1")
    await back(setup); await back(setup)
    expect(setup.captureCharFrame()).toContain("Search › View transcript")
    await back(setup); await back(setup)
    expect(setup.captureCharFrame()).toContain("Library · all runs")
    expect(setup.captureCharFrame()).toContain("Search › First pass")
  })

  test("exports through the folder picker and asks before overwriting", async () => {
    const { setup, root } = await app({}, 100, 35)
    const folder = join(root, "Downloads"); mkdirSync(folder)
    writeFileSync(join(folder, "one.txt"), "existing export")
    await command(setup, "library"); await choose(setup, "First pass"); await choose(setup, "Export TXT")
    await input(setup, root + "/down"); setup.mockInput.pressEnter(); await setup.flush()
    expect(setup.captureCharFrame()).toContain("Use this folder")
    expect(setup.captureCharFrame()).not.toContain("one.txt")
    setup.mockInput.pressEnter(); await setup.flush()
    expect(setup.captureCharFrame()).toContain("First pass.txt")
    await input(setup, "one.txt"); setup.mockInput.pressEnter(); await setup.flush()
    expect(setup.captureCharFrame()).toContain("Replace existing file?")
    expect(readFileSync(join(folder, "one.txt"), "utf8")).toBe("existing export")
    setup.mockInput.pressArrow("down"); setup.mockInput.pressEnter(); await setup.flush()
    expect(readFileSync(join(folder, "one.txt"), "utf8")).toBe("A transcript worth reading.\n")
    expect(setup.captureCharFrame()).toContain("Exported to")
    await choose(setup, "Export JSON"); setup.mockInput.pressEnter(); await setup.flush()
    await input(setup, "../wrong.json"); setup.mockInput.pressEnter(); await setup.flush()
    expect(setup.captureCharFrame()).toContain("filename without folders")
    await input(setup, "one.json"); setup.mockInput.pressEnter(); await setup.flush()
    expect(JSON.parse(readFileSync(join(folder, "one.json"), "utf8")).text).toBe("A transcript worth reading.")
    expect(JSON.parse(readFileSync(join(root, "config", "transcribe", "ui.json"), "utf8")).exportDirectory).toBe(folder)
  })

  test("setup selects files with Enter, preserves edits, and exposes advanced options", async () => {
    const { setup, root } = await app()
    const folder = join(root, "Recordings"); mkdirSync(folder)
    writeFileSync(join(folder, "first.m4a"), "audio"); writeFileSync(join(folder, "second.m4a"), "audio")
    await command(setup, "New transcription"); setup.mockInput.pressEnter(); await setup.flush()
    await input(setup, root + "/rec"); setup.mockInput.pressEnter(); await setup.flush()
    expect(setup.captureCharFrame()).toContain("first.m4a")
    expect(setup.captureCharFrame()).not.toContain("New transcription · setup")
    await setup.mockInput.typeText("first"); setup.mockInput.pressEnter(); await setup.flush()
    expect(setup.captureCharFrame()).toContain("New transcription · setup")
    await choose(setup, "Name"); await input(setup, "My run"); setup.mockInput.pressEnter(); await setup.flush()
    await choose(setup, "Change file"); setup.mockInput.pressEnter(); await setup.flush()
    await input(setup, join(folder, "second")); setup.mockInput.pressEnter(); await setup.flush()
    setup.mockInput.pressKey("u", { ctrl: true }); await setup.flush()
    expect(setup.captureCharFrame()).toContain("My run")
    await choose(setup, "Advanced options"); setup.mockInput.pressKey("u", { ctrl: true }); await setup.flush()
    expect(setup.captureCharFrame()).toContain("Chunk concurrency")
    await choose(setup, "Change provider"); await choose(setup, "Microsoft")
    await choose(setup, "Change model")
    expect(setup.captureCharFrame()).toContain("MAI-Transcribe-2")
    expect(setup.captureCharFrame()).toContain("MAI Transcribe 1.5")
    await back(setup); await choose(setup, "Change provider"); await choose(setup, "OpenAI"); await choose(setup, "Change model")
    expect(setup.captureCharFrame()).toContain("gpt-transcribe")
  })

  test("auth masks secrets, saves to wallet, and allows cancellation", async () => {
    const saved: Record<string, string> = {}; let writes = 0
    const { setup } = await app({ authentication: {
      status: async (provider) => ({ key: saved[provider] ? "system wallet" : "not configured" }),
      save: async (provider, _field, value) => { saved[provider] = value; writes++ },
      remove: async (provider) => { delete saved[provider] },
    } })
    await command(setup, "Authentication"); await choose(setup, "OpenAI"); await choose(setup, "Set API key")
    await setup.mockInput.typeText("test-secret-value"); await setup.flush()
    expect(setup.captureCharFrame()).not.toContain("test-secret-value")
    expect(setup.captureCharFrame()).toContain("••••")
    setup.mockInput.pressEnter(); await setup.flush()
    expect(saved.openai).toBe("test-secret-value")
    await choose(setup, "Set API key"); await setup.mockInput.typeText("never-save"); await back(setup)
    expect(writes).toBe(1)
    await choose(setup, "Remove saved credentials"); await choose(setup, "Remove")
    expect(saved.openai).toBeUndefined()
  })

  test("layout resizes, plain icons persist, and mouse navigation works", async () => {
    const { setup, root } = await app({}, 160, 50)
    expect(setup.captureCharFrame()).toContain("WORKSPACE")
    setup.mockInput.pressKey("F6"); await setup.flush()
    await setup.mockMouse.click(9, 8); await setup.flush()
    await command(setup, "Settings"); await choose(setup, "Appearance"); await choose(setup, "Icon style")
    expect(JSON.parse(readFileSync(join(root, "config", "transcribe", "ui.json"), "utf8")).icons).toBe("plain")
    for (const [width, height] of [[80, 24], [120, 40], [160, 50]]) {
      setup.resize(width!, height!); await setup.flush()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("Appearance")
      expect(frame).toContain("^Q quit")
      expect(frame).not.toMatch(/[\uE000-\uF8FF]/)
      expect(frame.split("\n").filter(Boolean).length).toBeLessThanOrEqual(height!)
    }
    setup.resize(80, 24); await setup.flush()
    await setup.mockMouse.click(14, 2); await setup.flush()
    expect(setup.captureCharFrame()).toContain("Library · all runs")
  })

  test("multiple jobs run while browsing and completion never steals focus", async () => {
    const tasks = new Map<string, (run: RunRecord) => void>()
    let library: Library
    const { setup, root, library: target } = await app({
      requireCredential: () => "test-key",
      createRuns: async (target, location, name, settings) => [target.createRun(target.sourceFor("local", location, location), name!, settings)],
      createRunner: (_library, notify) => {
        let id = ""
        const run = (reference: string) => { id = reference; _library.updateRun(id, { status: "transcribing" }); notify({ type: "chunk", message: "Uploading", completed: 0, total: 1 }); return new Promise<RunRecord>((resolve) => tasks.set(id, resolve)) }
        return { run, restart: run, requestPause: () => { tasks.get(id)?.(_library.updateRun(id, { status: "paused" })) } }
      },
    })
    library = target
    for (const name of ["a", "b", "c"]) {
      const path = join(root, name + ".wav"); writeFileSync(path, "audio")
      await command(setup, "Quick Transcribe"); setup.mockInput.pressEnter(); await setup.flush()
      await input(setup, path); setup.mockInput.pressEnter(); await setup.flush()
    }
    expect(tasks.size).toBe(3)
    expect(setup.captureCharFrame()).toContain("3 active")
    await command(setup, "Library")
    const id = [...tasks.keys()][1]!
    tasks.get(id)!(library.updateRun(id, { status: "completed" })); await setup.flush()
    expect(setup.captureCharFrame()).toContain("Library · all runs")
    expect(setup.captureCharFrame()).toContain("2 active")
    setup.mockInput.pressKey("c", { ctrl: true }); await setup.flush()
    expect(library.listRuns().filter((run) => run.status === "paused")).toHaveLength(2)
    expect(setup.captureCharFrame()).toContain("0 active")
  })

  test("quick transcribe opens its result only while still viewing that job", async () => {
    const { setup, root, library } = await app({ requireCredential: () => "test-key", createRunner: (library) => {
      const finish = async (reference: string) => {
        const run = library.requireRun(reference), source = library.requireSource(run.sourceId)
        library.writeTranscript(run, { schemaVersion: 1, runId: run.id, source, provider: run.provider, model: run.model, language: "en", text: "Fast transcript output.", segments: [], usage: {}, createdAt: "" })
        return library.updateRun(reference, { status: "completed" })
      }
      return { run: finish, restart: finish, requestPause: () => {} }
    } })
    const path = join(root, "audio.wav"); writeFileSync(path, "audio")
    await choose(setup, "Quick Transcribe"); setup.mockInput.pressEnter(); await setup.flush()
    await input(setup, path); setup.mockInput.pressEnter(); await setup.waitForFrame((frame) => frame.includes("Fast transcript output."))
    expect(library.listRuns()).toHaveLength(2)
  })
})

test("quit with active jobs waits until the requests settle", async () => {
  let finish!: (run: RunRecord) => void
  let paused = false, running: RunRecord | undefined
  const { setup, root, library } = await app({ requireCredential: () => "test-key", createRunner: (target) => {
    const run = (id: string) => { running = target.requireRun(id); return new Promise<RunRecord>((resolve) => { finish = resolve }) }
    return { run, restart: run, requestPause: () => { paused = true } }
  } })
  const path = join(root, "quit.wav"); writeFileSync(path, "audio")
  await choose(setup, "Quick Transcribe"); setup.mockInput.pressEnter(); await setup.flush()
  await input(setup, path); setup.mockInput.pressEnter(); await setup.flush()
  setup.mockInput.pressKey("q", { ctrl: true }); await setup.flush()
  expect(setup.captureCharFrame()).toContain("Quit while jobs are active?")
  setup.mockInput.pressArrow("down"); setup.mockInput.pressEnter(); await setup.flush()
  expect(paused).toBe(true)
  expect(setup.captureCharFrame()).toContain("Waiting for active requests")
  finish(library.updateRun(running!.id, { status: "paused" }))
  await setup.flush()
  expect(library.requireRun(running!.id).status).toBe("paused")
})

test("sidebar keyboard navigation and clicking a run action use the correct pane", async () => {
  const { setup } = await app({}, 140, 35)
  setup.mockInput.pressKey("F6", { shift: true }); await setup.flush()
  setup.mockInput.pressArrow("down"); setup.mockInput.pressArrow("down"); setup.mockInput.pressEnter(); await setup.flush()
  expect(setup.captureCharFrame()).toContain("Library · all runs")
  const clickLabel = async (label: string) => {
    const lines = setup.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.indexOf(label) > 24)
    expect(y).toBeGreaterThan(0)
    await setup.mockMouse.click(lines[y]!.indexOf(label) + 2, y); await setup.flush()
  }
  await clickLabel("First pass")
  expect(setup.captureCharFrame()).toContain("View transcript")
  await clickLabel("View transcript")
  expect(setup.captureCharFrame()).toContain("A transcript worth reading.")
})

test("pasting an absolute media path replaces the remembered folder", async () => {
  const { setup, root } = await app()
  const path = join(root, "meeting notes.wav"); writeFileSync(path, "audio")
  await command(setup, "New transcription"); setup.mockInput.pressEnter(); await setup.flush()
  await setup.mockInput.pasteBracketedText(path)
  setup.mockInput.pressEnter(); await setup.flush()
  expect(setup.captureCharFrame()).toContain("New transcription · setup")
  expect(setup.captureCharFrame()).toContain("meeting notes")
})
