import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
