import { afterEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as processTools from "../src/process"
import * as media from "../src/media"
import { JobRunner } from "../src/job"
import { inspectInput, prepareAudio } from "../src/media"
import { createRuns } from "../src/service"
import { Library } from "../src/storage"
import { normalizeSettings } from "../src/config"

const root = join("/tmp", `transcribe-media-${crypto.randomUUID()}`)
mkdirSync(root, { recursive: true })
afterEach(() => rmSync(root, { recursive: true, force: true }))

test("directories are rejected before runs, cache files, or ffmpeg preparation", async () => {
  await expect(inspectInput(root)).rejects.toThrow("Choose a media file")
  const library = new Library(join(root, "state"))
  try {
    await expect(createRuns(library, root, undefined, normalizeSettings())).rejects.toThrow("not a directory")
    expect(library.listRuns()).toEqual([])
    expect(library.listSources()).toEqual([])
    await expect(prepareAudio(root, "local", join(root, "audio-cache"))).rejects.toThrow("Choose a media file")
    expect(existsSync(join(root, "audio-cache"))).toBeFalse()
    const path = join(root, "recording.m4a")
    writeFileSync(path, "media")
    expect((await inspectInput(path)).locator).toBe(path)
  } finally { library.close() }
})


test("concurrent runs share preparation and only publish complete audio", async () => {
  mkdirSync(root, { recursive: true })
  const input = join(root, "input.wav"), cache = join(root, "cache")
  writeFileSync(input, "audio")
  let finish!: () => void, calls = 0
  const command = spyOn(processTools, "command").mockImplementation(async (args) => {
    calls++
    const target = args.at(-1)!
    writeFileSync(target, "partial")
    await new Promise<void>((resolve) => { finish = resolve })
    writeFileSync(target, "completed audio")
    return ""
  })
  try {
    const first = prepareAudio(input, "local", cache), second = prepareAudio(input, "local", cache)
    expect(calls).toBe(1)
    expect(existsSync(join(cache, "source.mp3"))).toBe(false)
    finish()
    const paths = await Promise.all([first, second])
    expect(paths[0]).toBe(paths[1])
    expect(await Bun.file(paths[0]!).text()).toBe("completed audio")
  } finally { command.mockRestore() }
})

test("pausing during preparation prevents chunk uploads and keeps the run resumable", async () => {
  mkdirSync(root, { recursive: true })
  const library = new Library(join(root, "state"))
  const source = library.sourceFor("local", "/tmp/input.wav", "Example")
  const run = library.createRun(source, "pause test", normalizeSettings())
  let finish!: (value: string) => void
  const prepare = spyOn(media, "prepareAudio").mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
  const chunks = spyOn(media, "createChunks").mockResolvedValue([])
  try {
    const runner = new JobRunner(library, () => {}, { handleSignals: false })
    const result = runner.run(run.id)
    runner.requestPause(); finish("/tmp/prepared.mp3")
    expect((await result).status).toBe("paused")
    expect(chunks).not.toHaveBeenCalled()
    expect(library.requireRun(run.id).status).toBe("paused")
  } finally { prepare.mockRestore(); chunks.mockRestore(); library.close() }
})
