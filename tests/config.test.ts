import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { configPath, loadSettings, normalizeSettings, stateRoot } from "../src/config"
import { effectiveModel, modelsFor, validateSettings } from "../src/models"

const roots: string[] = []
const originalConfigHome = process.env.XDG_CONFIG_HOME
const originalStateHome = process.env.XDG_STATE_HOME
const originalConfigDir = process.env.TRANSCRIBE_CONFIG_DIR
const originalStateDir = process.env.TRANSCRIBE_STATE_DIR

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  setEnvironment("XDG_CONFIG_HOME", originalConfigHome)
  setEnvironment("XDG_STATE_HOME", originalStateHome)
  setEnvironment("TRANSCRIBE_CONFIG_DIR", originalConfigDir)
  setEnvironment("TRANSCRIBE_STATE_DIR", originalStateDir)
})

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function temporary(): string {
  const root = join("/tmp", `transcribe-config-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

describe("settings and model capabilities", () => {
  test("migrates legacy snake-case settings", () => {
    const settings = normalizeSettings({ provider: "openai", model: "gpt-transcribe", chunk_seconds: 200, chunk_overlap_seconds: 2, chunk_concurrency: 2 })
    expect(settings.schemaVersion).toBe(2)
    expect(settings.model).toBe("gpt-4o-transcribe")
    expect(settings.chunkSeconds).toBe(200)
    expect(settings.chunkOverlapSeconds).toBe(2)
    expect(settings.chunkConcurrency).toBe(2)
  })

  test("contains every promised OpenAI and Groq model", () => {
    expect(modelsFor("openai").map((model) => model.id)).toEqual([
      "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1", "gpt-4o-transcribe-diarize",
    ])
    expect(modelsFor("groq").map((model) => model.id)).toEqual(["whisper-large-v3-turbo", "whisper-large-v3"])
  })

  test("diarization is a first-class specialized model", () => {
    const settings = normalizeSettings({ provider: "openai", diarize: true })
    expect(effectiveModel(settings).id).toBe("gpt-4o-transcribe-diarize")
    expect(effectiveModel(settings).diarization).toBeTrue()
  })

  test("rejects unsafe chunk settings", () => {
    const settings = normalizeSettings({ chunk_seconds: 20, chunk_overlap_seconds: 20 })
    expect(validateSettings(settings)).toContain("Chunk overlap must be non-negative and shorter than the chunk.")
  })

  test("uses standalone XDG paths and explicit overrides", () => {
    const root = temporary()
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_STATE_HOME = join(root, "state")
    expect(configPath()).toBe(join(root, "config", "transcribe", "config.json"))
    expect(stateRoot()).toBe(join(root, "state", "transcribe"))

    process.env.TRANSCRIBE_CONFIG_DIR = join(root, "custom-config")
    process.env.TRANSCRIBE_STATE_DIR = join(root, "custom-state")
    expect(configPath()).toBe(join(root, "custom-config", "config.json"))
    expect(stateRoot()).toBe(join(root, "custom-state"))
  })

  test("adopts legacy dotfiles settings and library without losing data", () => {
    const root = temporary()
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_STATE_HOME = join(root, "state")
    delete process.env.TRANSCRIBE_CONFIG_DIR
    delete process.env.TRANSCRIBE_STATE_DIR
    const legacyConfig = join(root, "config", "dotfiles", "transcribe", "config.json")
    const legacyState = join(root, "state", "dotfiles", "transcribe")
    mkdirSync(legacyState, { recursive: true })
    mkdirSync(join(root, "config", "dotfiles", "transcribe"), { recursive: true })
    writeFileSync(legacyConfig, JSON.stringify({ provider: "openai", model: "gpt-transcribe", language: "en" }))

    expect(stateRoot()).toBe(legacyState)
    expect(loadSettings().model).toBe("gpt-4o-transcribe")
    expect(existsSync(configPath())).toBeTrue()
  })
})
