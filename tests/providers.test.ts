import { authentication } from "../src/auth"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeSettings } from "../src/config"
import { compareTranscripts, transcribeChunk } from "../src/providers"

const originalFetch = globalThis.fetch
const originalOpenAI = process.env.OPENAI_API_KEY
const originalGroq = process.env.GROQ_API_KEY
const originalMicrosoft = process.env.AZURE_SPEECH_KEY
const originalEndpoint = process.env.AZURE_SPEECH_ENDPOINT
const root = join("/tmp", `transcribe-provider-${crypto.randomUUID()}`)
mkdirSync(root, { recursive: true })
const audio = join(root, "audio.mp3")
writeFileSync(audio, "test")
afterEach(() => { globalThis.fetch = originalFetch; process.env.OPENAI_API_KEY = originalOpenAI; process.env.GROQ_API_KEY = originalGroq; process.env.AZURE_SPEECH_KEY = originalMicrosoft; process.env.AZURE_SPEECH_ENDPOINT = originalEndpoint })

describe("provider requests", () => {
  test("uses the documented language field for gpt-4o-transcribe", async () => {
    process.env.OPENAI_API_KEY = "test-key"
    let form: FormData | null = null
    globalThis.fetch = (async (_input: any, init: any) => { form = init.body; return new Response(JSON.stringify({ text: "hello", languages: [{ code: "en" }], usage: { total_tokens: 3 } }), { status: 200 }) }) as any
    const result = await transcribeChunk(audio, normalizeSettings({ provider: "openai", model: "gpt-4o-transcribe", language: "en" }))
    expect(form!.get("language")).toBe("en")
    expect(form!.get("languages[]")).toBeNull()
    expect(result.text).toBe("hello")
  })

  test("preserves gpt-transcribe and sends plural language hints", async () => {
    process.env.OPENAI_API_KEY = "test-key"
    let form: FormData | null = null
    globalThis.fetch = (async (_input: any, init: any) => { form = init.body; return Response.json({ text: "hello" }) }) as any
    await transcribeChunk(audio, normalizeSettings({ provider: "openai", model: "gpt-transcribe", prompt: "Names", language: "en" }), "Earlier words")
    expect(form!.get("model")).toBe("gpt-transcribe")
    expect(form!.get("language")).toBeNull()
    expect(form!.get("languages[]")).toBe("en")
    expect(form!.get("prompt")).toContain("Earlier words")
  })

  test("uses MAI enhanced mode, Azure authentication, and converts milliseconds", async () => {
    process.env.AZURE_SPEECH_KEY = "test-key"
    process.env.AZURE_SPEECH_ENDPOINT = "https://example.cognitiveservices.azure.com/"
    let url = "", request: any
    globalThis.fetch = (async (input: any, init: any) => {
      url = String(input); request = init
      return Response.json({ durationMilliseconds: 3000, combinedPhrases: [{ text: "hello" }], phrases: [{ text: "hello", offsetMilliseconds: 500, durationMilliseconds: 1500, speaker: 0 }] })
    }) as any
    const settings = normalizeSettings({ provider: "microsoft", model: "MAI-Transcribe-2", diarize: true })
    const result = await transcribeChunk(audio, settings)
    expect(settings.provider).toBe("microsoft")
    expect(url).toBe("https://example.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15")
    expect(request.headers["Ocp-Apim-Subscription-Key"]).toBe("test-key")
    expect(request.headers.Authorization).toBeUndefined()
    expect(request.body.get("file")).toBeNull()
    expect(request.body.get("audio")).not.toBeNull()
    expect(JSON.parse(request.body.get("definition"))).toEqual({ enhancedMode: { enabled: true, model: "MAI-Transcribe-2", modelOptions: { timestamps: "segment" } }, locales: ["en"], diarization: { enabled: true } })
    expect(result.text).toBe("hello")
    expect(result.segments).toEqual([{ start: 0.5, end: 2, speaker: "0", text: "hello" }])
    expect(result.usage).toEqual({ durationMilliseconds: 3000 })
  })

  test("MAI 1.5 omits unsupported options and permits automatic language detection", async () => {
    process.env.AZURE_SPEECH_KEY = "test-key"
    process.env.AZURE_SPEECH_ENDPOINT = "https://example.cognitiveservices.azure.com"
    let form: FormData | null = null
    globalThis.fetch = (async (_input: any, init: any) => { form = init.body; return Response.json({ combinedPhrases: [] }) }) as any
    const result = await transcribeChunk(audio, normalizeSettings({ provider: "microsoft", model: "MAI-Transcribe-1.5", language: "auto", prompt: "ignored" }))
    expect(JSON.parse(String(form!.get("definition")))).toEqual({ enhancedMode: { enabled: true, model: "MAI-Transcribe-1.5" } })
    expect(result.text).toBe("")
    expect(form!.get("prompt")).toBeNull()
  })

  test("requires the Microsoft resource endpoint before uploading", async () => {
    process.env.AZURE_SPEECH_KEY = "test-key"
    delete process.env.AZURE_SPEECH_ENDPOINT
    const read = spyOn(authentication.store, "read").mockResolvedValue({})
    await expect(transcribeChunk(audio, normalizeSettings({ provider: "microsoft" }))).rejects.toThrow("AZURE_SPEECH_ENDPOINT")
    read.mockRestore()
  })

  test("uses diarized_json and automatic chunking", async () => {
    process.env.OPENAI_API_KEY = "test-key"
    let form: FormData | null = null
    globalThis.fetch = (async (_input: any, init: any) => { form = init.body; return new Response(JSON.stringify({ text: "hello", segments: [{ start: 0, end: 1, speaker: "A", text: "hello" }] }), { status: 200 }) }) as any
    const result = await transcribeChunk(audio, normalizeSettings({ provider: "openai", diarize: true }))
    expect(form!.get("response_format")).toBe("diarized_json")
    expect(form!.get("chunking_strategy")).toBe("auto")
    expect(result.segments[0]?.speaker).toBe("A")
  })

  test("transcription and comparison use saved keys without environment variables", async () => {
    delete process.env.OPENAI_API_KEY
    const read = spyOn(authentication.store, "read").mockResolvedValue({ key: "test-wallet-key" })
    const headers: string[] = []
    globalThis.fetch = (async (_input: any, init: any) => { headers.push(init.headers.Authorization); return Response.json({ text: "hello", output_text: "Winner: Tie" }) }) as any
    try {
      expect((await transcribeChunk(audio, normalizeSettings({ provider: "openai" }))).text).toBe("hello")
      expect(await compareTranscripts("a", "one", "b", "two")).toBe("Winner: Tie")
      expect(headers).toEqual(["Bearer test-wallet-key", "Bearer test-wallet-key"])
    } finally { read.mockRestore() }
  })

  test("comparison is ephemeral and uses gpt-5.6-luna", async () => {
    process.env.OPENAI_API_KEY = "test-key"
    let request: any
    globalThis.fetch = (async (_input: any, init: any) => { request = JSON.parse(init.body); return new Response(JSON.stringify({ output_text: "Winner: Transcript A" }), { status: 200 }) }) as any
    expect(await compareTranscripts("a.txt", "one", "b.txt", "two")).toContain("Transcript A")
    expect(request.model).toBe("gpt-5.6-luna")
  })
})

process.on("exit", () => rmSync(root, { recursive: true, force: true }))
