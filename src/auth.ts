import type { Provider } from "./types"

export type AuthProvider = Exclude<Provider, "youtube-transcript">
export const AUTH_PROVIDERS: Array<{ id: AuthProvider, label: string, env: string }> = [
  { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY" },
  { id: "microsoft", label: "Microsoft MAI", env: "AZURE_SPEECH_KEY" },
  { id: "groq", label: "Groq", env: "GROQ_API_KEY" },
  { id: "fireworks", label: "Fireworks", env: "FIREWORKS_API_KEY" },
]
export interface SavedAuth { key?: string, endpoint?: string }
export interface AuthStatus { key: "environment" | "system wallet" | "not configured", endpoint?: string, endpointSource?: "environment" | "system wallet" | "not configured" }
export interface CredentialStore {
  name: string
  read(provider: AuthProvider): Promise<SavedAuth>
  write(provider: AuthProvider, value: SavedAuth): Promise<void>
}

type SecretCommand = (args: string[], input?: string) => Promise<{ code: number, output: string }>
const secretCommand: SecretCommand = async (args, input) => {
  // Secrets travel through pipes only, never arguments, logs, or temporary files.
  const child = Bun.spawn(args, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "ignore" })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return { code, output }
}

// Use KWallet's D-Bus API directly: some kwallet-query releases report a
// successful write without storing an entry. The helper receives JSON on stdin.
const KWALLET_HELPER = `
import dbus, json, sys
try:
    bus = dbus.SessionBus()
    service = next((name for name in ["org.kde.kwalletd6", "org.kde.kwalletd5"] if bus.name_has_owner(name)), "org.kde.kwalletd6")
    version = "6" if service.endswith("6") else "5"
    wallet = dbus.Interface(bus.get_object(service, "/modules/kwalletd" + version), "org.kde.KWallet")
    app = "transcribe-cli"
    handle = wallet.open(wallet.localWallet(), 0, app)
    if handle < 0: sys.exit(2)
    folder, entry = "transcribe-cli", "transcribe-cli:" + sys.argv[2]
    if sys.argv[1] == "read":
        if not wallet.hasFolder(handle, folder, app) or not wallet.hasEntry(handle, folder, entry, app): sys.exit(4)
        sys.stdout.write(str(wallet.readPassword(handle, folder, entry, app)))
    else:
        value = sys.stdin.read()
        if json.loads(value) == {}:
            if wallet.hasFolder(handle, folder, app) and wallet.hasEntry(handle, folder, entry, app):
                if wallet.removeEntry(handle, folder, entry, app) != 0: sys.exit(2)
        else:
            if not wallet.hasFolder(handle, folder, app):
                if not wallet.createFolder(handle, folder, app): sys.exit(2)
            if wallet.writePassword(handle, folder, entry, value, app) != 0: sys.exit(2)
except Exception:
    sys.exit(2)
`

export function systemCredentialStore(which = Bun.which, execute: SecretCommand = secretCommand): CredentialStore {
  const kwallet = which("kwallet-query") || which("kwallet6-query")
  const python = which("/usr/bin/python3") || which("python3")
  const secretTool = which("secret-tool")
  const useKWallet = Boolean(kwallet && python && (process.env.XDG_CURRENT_DESKTOP?.includes("KDE") || !secretTool))
  const name = useKWallet ? "KWallet" : "Secret Service"
  const args = (action: "read" | "write", provider: AuthProvider) => useKWallet
    ? [python!, "-c", KWALLET_HELPER, action, provider]
    : [secretTool!, action === "read" ? "lookup" : "store", ...(action === "write" ? ["--label", `transcribe-cli ${provider}`] : []), "application", "transcribe-cli", "provider", provider]
  const available = () => {
    if ((!kwallet || !python) && !secretTool) throw new Error("No system credential store is available. Install kwallet and python3-dbus (KDE) or libsecret-tools (Secret Service), or use environment variables.")
  }
  return {
    name,
    async read(provider) {
      available()
      const result = await execute(args("read", provider))
      if ((useKWallet && result.code === 4) || (!useKWallet && result.code === 1 && !result.output)) return {}
      if (result.code !== 0) throw new Error(`${name} could not read credentials. Unlock your system wallet and try again. On KDE, ensure python3-dbus is installed, or use environment variables.`)
      if (!result.output.trim()) return {}
      try {
        const value = JSON.parse(result.output)
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
        return { key: typeof value.key === "string" ? value.key : undefined, endpoint: typeof value.endpoint === "string" ? value.endpoint : undefined }
      } catch { throw new Error(`The saved ${provider} credential is invalid. Replace it in Authentication.`) }
    },
    async write(provider, value) {
      available()
      const result = !useKWallet && Object.keys(value).length === 0
        ? await execute([secretTool!, "clear", "application", "transcribe-cli", "provider", provider])
        : await execute(args("write", provider), JSON.stringify(value))
      if (result.code !== 0) throw new Error(`${name} could not save credentials. Unlock your system wallet and try again. Nothing was saved to a plaintext file.`)
    },
  }
}

export function validateEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error("Enter a valid Azure Speech resource HTTPS endpoint.") }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Use the Azure Speech resource HTTPS endpoint without a path, credentials, query, or fragment.")
  return url.origin
}

export class Authentication {
  constructor(readonly store: CredentialStore = systemCredentialStore()) {}
  async status(provider: AuthProvider): Promise<AuthStatus> {
    const env = AUTH_PROVIDERS.find((item) => item.id === provider)!.env
    const saved = await this.store.read(provider)
    const endpoint = provider === "microsoft" ? process.env.AZURE_SPEECH_ENDPOINT || saved.endpoint : undefined
    return { key: process.env[env] ? "environment" : saved.key ? "system wallet" : "not configured", ...(provider === "microsoft" ? { endpoint: endpoint ? validateEndpoint(endpoint) : undefined, endpointSource: process.env.AZURE_SPEECH_ENDPOINT ? "environment" : saved.endpoint ? "system wallet" : "not configured" } : {}) }
  }
  async key(provider: Provider): Promise<string> {
    if (provider === "youtube-transcript") throw new Error("YouTube subtitles do not require an API key.")
    const env = AUTH_PROVIDERS.find((item) => item.id === provider)?.env
    if (!env) throw new Error(`Unsupported provider: ${provider}`)
    if (process.env[env]) return process.env[env]!
    const saved = await this.store.read(provider)
    if (!saved.key) throw new Error(`${env} is not set. Add a key in Authentication or export ${env}.`)
    return saved.key
  }
  async endpoint(): Promise<string> {
    const value = process.env.AZURE_SPEECH_ENDPOINT || (await this.store.read("microsoft")).endpoint
    if (!value) throw new Error("AZURE_SPEECH_ENDPOINT is not set. Add your Azure Speech endpoint in Authentication or export AZURE_SPEECH_ENDPOINT.")
    return validateEndpoint(value)
  }
  async save(provider: AuthProvider, field: "key" | "endpoint", value: string): Promise<void> {
    value = value.trim()
    if (field === "key" && (!value || /\s/.test(value))) throw new Error("Enter a non-empty API key without whitespace.")
    if (field === "endpoint") value = validateEndpoint(value)
    const saved = await this.store.read(provider)
    await this.store.write(provider, { ...saved, [field]: value })
  }
  async remove(provider: AuthProvider): Promise<void> {
    // Empty records remove the KWallet entry or clear its stored secret.
    await this.store.write(provider, {})
  }
}
export const authentication = new Authentication()
