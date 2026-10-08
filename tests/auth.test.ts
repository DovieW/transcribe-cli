import { afterEach, describe, expect, test } from "bun:test"
import { Authentication, systemCredentialStore, validateEndpoint, type AuthProvider, type CredentialStore, type SavedAuth } from "../src/auth"

const originals = Object.fromEntries(["OPENAI_API_KEY", "GROQ_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_ENDPOINT", "XDG_CURRENT_DESKTOP"].map((name) => [name, process.env[name]]))
afterEach(() => { for (const [name, value] of Object.entries(originals)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
function memoryStore() {
  const records = new Map<AuthProvider, SavedAuth>()
  const store: CredentialStore = { name: "test wallet", read: async (provider) => records.get(provider) || {}, write: async (provider, value) => { records.set(provider, value) } }
  return { store, records }
}

describe("system authentication", () => {
  test("saved keys persist across instances and removal preserves environment overrides", async () => {
    delete process.env.OPENAI_API_KEY
    const { store, records } = memoryStore()
    const auth = new Authentication(store)
    await auth.save("openai", "key", "test-saved-key")
    expect(await new Authentication(store).key("openai")).toBe("test-saved-key")
    expect((await auth.status("openai")).key).toBe("system wallet")
    process.env.OPENAI_API_KEY = "test-environment-key"
    expect(await auth.key("openai")).toBe("test-environment-key")
    expect((await auth.status("openai")).key).toBe("environment")
    await auth.remove("openai")
    expect(records.get("openai")).toEqual({})
    expect(await auth.key("openai")).toBe("test-environment-key")
    delete process.env.OPENAI_API_KEY
    await expect(auth.key("openai")).rejects.toThrow("Authentication")
  })

  test("environment keys work when the wallet is unavailable", async () => {
    process.env.GROQ_API_KEY = "test-environment-key"
    const auth = new Authentication({ name: "unavailable", read: async () => { throw new Error("locked") }, write: async () => { throw new Error("locked") } })
    expect(await auth.key("groq")).toBe("test-environment-key")
  })

  test("Microsoft key and endpoint edits preserve each other and have independent overrides", async () => {
    delete process.env.AZURE_SPEECH_KEY; delete process.env.AZURE_SPEECH_ENDPOINT
    const { store, records } = memoryStore(), auth = new Authentication(store)
    await auth.save("microsoft", "key", "test-mai-key")
    await auth.save("microsoft", "endpoint", "https://example.cognitiveservices.azure.com/")
    expect(records.get("microsoft")).toEqual({ key: "test-mai-key", endpoint: "https://example.cognitiveservices.azure.com" })
    expect(await auth.key("microsoft")).toBe("test-mai-key")
    expect(await auth.endpoint()).toBe("https://example.cognitiveservices.azure.com")
    process.env.AZURE_SPEECH_ENDPOINT = "https://override.cognitiveservices.azure.com"
    expect(await auth.endpoint()).toBe(process.env.AZURE_SPEECH_ENDPOINT!)
    expect(await auth.key("microsoft")).toBe("test-mai-key")
    await auth.remove("microsoft")
    expect(records.get("microsoft")).toEqual({})
  })

  test("invalid input never reaches storage", async () => {
    const { store, records } = memoryStore(), auth = new Authentication(store)
    for (const key of ["", "two words", "line\nbreak"]) await expect(auth.save("groq", "key", key)).rejects.toThrow("API key")
    for (const endpoint of ["http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?key=secret", "nonsense"]) expect(() => validateEndpoint(endpoint)).toThrow()
    expect(records.size).toBe(0)
  })

  test("KWallet sends secrets on stdin only and sanitizes tool failures", async () => {
    process.env.XDG_CURRENT_DESKTOP = "KDE"
    const calls: Array<{ args: string[], input?: string }> = []
    const store = systemCredentialStore((name) => name === "kwallet-query" || name === "/usr/bin/python3" ? name : null, async (args, input) => {
      calls.push({ args, input })
      return { code: 0, output: input === undefined ? '{"key":"test-key"}\n' : "" }
    })
    expect((await store.read("openai")).key).toBe("test-key")
    await store.write("openai", { key: "test-secret" })
    expect(calls[1]!.args.join(" ")).not.toContain("test-secret")
    expect(calls[1]!.input).toBe('{"key":"test-secret"}')
    const failing = systemCredentialStore((name) => name === "kwallet-query" || name === "/usr/bin/python3" ? name : null, async () => ({ code: 2, output: "sensitive contents" }))
    await expect(failing.read("openai")).rejects.toThrow("Unlock")
    try { await failing.write("openai", { key: "test-secret" }) } catch (error) { expect(String(error)).not.toContain("sensitive contents"); expect(String(error)).not.toContain("test-secret") }
  })

  test("Secret Service stores namespaced JSON and handles absent records", async () => {
    process.env.XDG_CURRENT_DESKTOP = "GNOME"
    let request: string[] = [], secret = ""
    const store = systemCredentialStore((name) => name === "secret-tool" ? name : null, async (args, input) => { request = args; secret = input || ""; return { code: input === undefined ? 1 : 0, output: "" } })
    expect(await store.read("fireworks")).toEqual({})
    await store.write("fireworks", { key: "test-secret" })
    expect(request).toContain("store")
    expect(request).toContain("transcribe-cli")
    expect(request).not.toContain("test-secret")
    expect(secret).toContain("test-secret")
  })

  test("missing credential tooling gives an actionable error with no file fallback", async () => {
    const store = systemCredentialStore(() => null)
    await expect(store.write("openai", { key: "test-key" })).rejects.toThrow("No system credential store")
  })
})
