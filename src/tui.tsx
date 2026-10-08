import { ChoiceList } from "./choice-list"
import { JobController } from "./jobs"
import { loadUiPreferences, saveUiPreferences } from "./ui-state"
import { theme, icon, actionIcon, statusIcon } from "./theme"
import { requireMediaFile } from "./media"
import { authentication, AUTH_PROVIDERS, type Authentication, type AuthProvider, type AuthStatus } from "./auth"
import { render, useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { InputRenderable, ScrollBoxRenderable, SelectOption, SelectRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { configPath, loadSettings, saveSettings, stateRoot } from "./config"
import { discoverFiles, MEDIA_EXTENSIONS, TEXT_EXTENSIONS, type FileChoice } from "./files"
import { fuzzyOptions } from "./fuzzy"
import { expandUserPath, pathSuggestions } from "./paths"
import { JobRunner, type JobEvent } from "./job"
import { modelsFor } from "./models"
import { compareTranscripts, requireCredential } from "./providers"
import { createRuns, suggestedRunName } from "./service"
import { Library } from "./storage"
import type { Provider, RunRecord, Settings, SourceRecord, TranscriptDocument } from "./types"
import { findTextMatches, formatTranscript, viewerMetadata } from "./viewer"

type Screen = "settings-group" | "library" | "jobs" | "appearance" | "setup-name" | "setup-language" | "auth" | "auth-provider" | "auth-key" | "auth-endpoint" | "auth-remove" | "home" | "quick-input" | "quick-location" | "new-input" | "new-location" | "new-provider" | "new-model" | "review" | "active" | "sources" | "runs" | "run" | "compare-mode" | "compare-source" | "compare-runs" | "compare-external-a" | "compare-external-a-input" | "compare-external-b" | "compare-external-b-input" | "compare-result" | "settings" | "setting-input" | "export-folder" | "export-name" | "help" | "message"

const { accent: blue, green, muted, red, panel } = theme

function options(entries: Array<[string, string, unknown?]>): SelectOption[] {
  return entries.map(([name, description, value]) => ({ name, description, value: value ?? name }))
}

type TuiRunner = Pick<JobRunner, "requestPause" | "run" | "restart">
export interface TuiDependencies {
  createRuns?: typeof createRuns
  createRunner?: (library: Library, notify: (event: JobEvent) => void) => TuiRunner
  authentication?: Pick<Authentication, "status" | "save" | "remove">
  requireCredential?: (provider: Provider) => unknown
}

export function createTranscribeApp(library: Library, dependencies: TuiDependencies = {}) {
  let settings = loadSettings()
  let preferences = loadUiPreferences()
  let input = "", runName = ""
  let mediaReturn: Screen = "home"
  let exportFolder = preferences.exportDirectory, exportFormat: "txt" | "json" = "txt"
  let compareA = "", compareB = "", editingKey: keyof Settings | null = null
  let editingReturn: Screen = "settings"
  let settingsReturn: Screen = "home", pickerReturn: Screen = "settings"
  let viewerReturn: Screen = "home", messageReturn: Screen = "home"
  let mediaCache: FileChoice[] | null = null, textCache: FileChoice[] | null = null
  const createRunsFor = dependencies.createRuns || createRuns
  const createRunner = dependencies.createRunner || ((target, notify) => new JobRunner(target, notify, { handleSignals: false }))
  const auth = dependencies.authentication || authentication
  const requireCredentialFor = dependencies.requireCredential || requireCredential

  function App() {
    const renderer = useRenderer()
    const dimensions = useTerminalDimensions()
    const [focus, setFocus] = createSignal<"nav" | "content" | "details">("content")
    const [preferencesVersion, setPreferencesVersion] = createSignal(0)
    const [notification, setNotification] = createSignal("")
    const [palette, setPalette] = createSignal(false)
    const [confirmation, setConfirmation] = createSignal<{ title: string, description: string, action: () => void } | null>(null)
    const [shuttingDown, setShuttingDown] = createSignal(false)
    const [hasDetails, setHasDetails] = createSignal(false)
    const [jobsVersion, setJobsVersion] = createSignal(0)
    const [clock, setClock] = createSignal(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 1000)
    const controller = new JobController((notify) => createRunner(library, notify), () => { setJobsVersion((value) => value + 1); setSourcesVersion((value) => value + 1) })
    const busyJobs = () => { jobsVersion(); return controller.active }
    const aggregateProgress = () => {
      const active = busyJobs(), total = active.reduce((sum, entry) => sum + (entry.event.total || 0), 0), done = active.reduce((sum, entry) => sum + (entry.event.completed || 0), 0)
      if (!active.length) return ""
      const filled = total ? Math.floor(done / total * 10) : 0
      return `${active.length} active  ${total ? "[" + "━".repeat(filled) + "─".repeat(10 - filled) + "] " + done + "/" + total + " chunks" : "Preparing…"}`
    }
    const jobRows = () => { jobsVersion(); return [...controller.entries.values()].reverse() }
    createEffect(() => { if ((dimensions().width < 100 && focus() === "nav") || (dimensions().width < 120 && focus() === "details")) setFocus("content") })
    const contentFocused = () => focus() === "content" && !palette() && !confirmation() && !shuttingDown()
    const glyph = (name: Parameters<typeof icon>[0]) => { preferencesVersion(); return icon(name, preferences.icons) }
    const rememberPreferences = () => { saveUiPreferences(preferences); setPreferencesVersion((value) => value + 1) }
    const shutdown = async () => {
      setShuttingDown(true); setNotification("Pausing active runs before closing…")
      await Promise.allSettled([...pendingStarts])
      await controller.shutdown()
      renderer.destroy()
    }
    const quit = () => {
      if (busyJobs().length || pendingStarts.size) setConfirmation({ title: "Quit while jobs are active?", description: "Pause all runs safely and quit, or keep working.", action: () => { void shutdown() } })
      else renderer.destroy()
    }
    const terminate = () => { void shutdown() }
    const interrupt = () => { if (controller.active.length) controller.pauseAll(); else quit() }
    process.on("SIGTERM", terminate); process.on("SIGINT", interrupt)
    onCleanup(() => { clearInterval(timer); process.off("SIGTERM", terminate); process.off("SIGINT", interrupt) })
    const pendingStarts = new Set<Promise<unknown>>()
    let navigationVersion = 0
    const viewState = new Map<string, { query: string, selected: unknown }>()
    let currentSelection: unknown = null
    const [libraryStatus, setLibraryStatus] = createSignal("all")
    const [advanced, setAdvanced] = createSignal(false)
    const [settingsGroup, setSettingsGroup] = createSignal("transcription")
    let runReturn: Screen = "library"

    const [authProvider, setAuthProvider] = createSignal<AuthProvider>("openai")
    const [authStatuses, setAuthStatuses] = createSignal<Partial<Record<AuthProvider, AuthStatus>>>({})
    const [authBusy, setAuthBusy] = createSignal(false)
    const [authNotice, setAuthNotice] = createSignal("")
    let authReturn: Screen = "home"
    const [screen, setScreen] = createSignal<Screen>("home")
    const [message, setMessage] = createSignal("")
    const [error, setError] = createSignal("")
    const [sourcesVersion, setSourcesVersion] = createSignal(0)
    const [settingsVersion, setSettingsVersion] = createSignal(0)
    const [compareSelected, setCompareSelected] = createSignal<string[]>([])
    const [menuQuery, setMenuQuery] = createSignal("")
    const [pathQuery, setPathQuery] = createSignal("")
    const [viewerQuery, setViewerQuery] = createSignal("")
    const [viewerText, setViewerText] = createSignal("")
    const [viewerRawText, setViewerRawText] = createSignal("")
    const [viewerTitle, setViewerTitle] = createSignal("viewer")
    const [viewerDocument, setViewerDocument] = createSignal<TranscriptDocument | null>(null)
    const [viewerRunId, setViewerRunId] = createSignal<string | null>(null)
    const [viewerNotice, setViewerNotice] = createSignal("")
    const [runNotice, setRunNotice] = createSignal("")
    const [selectedSource, setSelectedSource] = createSignal<SourceRecord | null>(null)
    const [selectedRun, setSelectedRun] = createSignal<RunRecord | null>(null)
    createEffect(() => { sourcesVersion(); const run = selectedRun(); if (run) { const current = library.runByReference(run.id); if (current && current.status !== run.status) setSelectedRun(current) } })
    const sources = createMemo(() => { sourcesVersion(); return library.listSources() })
    const runs = createMemo(() => { sourcesVersion(); const source = selectedSource(); return source ? library.listRunsForSource(source.id) : [] })

    const viewKey = (value: Screen) => `${value}:${value === "runs" ? selectedSource()?.id || "" : value === "run" ? selectedRun()?.id || "" : ""}`
    const go = (next: Screen) => {
      navigationVersion++
      viewState.set(viewKey(screen()), { query: menuQuery(), selected: currentSelection })
      const state = viewState.get(viewKey(next))
      setError(""); setRunNotice(""); setMenuQuery(state?.query || ""); currentSelection = state?.selected ?? null
      setPathQuery(""); if (next !== "compare-result") setViewerQuery("")
      setFocus("content"); setScreen(next)
    }
    const fail = (reason: unknown) => setError((reason as Error).message || String(reason))
    const showFailure = (reason: unknown, returnTo: Screen) => {
      messageReturn = returnTo
      setMessage("")
      go("message")
      fail(reason)
    }
    const home = () => { setCompareSelected([]); go("home") }
    const back = () => {
      if (authBusy() && screen().startsWith("auth")) return
      const parent: Partial<Record<Screen, Screen>> = {
        "quick-input": "home", "quick-location": "quick-input", "new-input": mediaReturn, "new-location": "new-input", "new-provider": pickerReturn, "new-model": pickerReturn,
        review: "home", library: "home", jobs: "home", appearance: "settings", "settings-group": "settings", "setup-name": "review", "setup-language": "review", active: "jobs", sources: "library", runs: "sources", run: runReturn,
        "compare-mode": "home", "compare-source": "compare-mode", "compare-runs": "compare-source",
        "compare-external-a": "compare-mode", "compare-external-a-input": "compare-external-a",
        "compare-external-b": "compare-external-a", "compare-external-b-input": "compare-external-b",
        "compare-result": viewerReturn, settings: settingsReturn, "setting-input": editingKey ? editingReturn : "run",
        auth: authReturn, "auth-provider": "auth", "auth-key": "auth-provider", "auth-endpoint": "auth-provider", "auth-remove": "auth-provider",
        "export-folder": "run", "export-name": "export-folder", help: "home", message: messageReturn,
      }
      const current = screen(), target = parent[current] || "home"
      if (current === "compare-runs") setCompareSelected([])
      if (current === "setting-input" && editingKey) editingKey = null
      if (target === "home") home()
      else go(target)
    }
    useKeyboard((key) => {
      if (shuttingDown()) { key.preventDefault(); key.stopPropagation(); return }
      if (key.ctrl && key.name === "q") { quit(); key.preventDefault(); key.stopPropagation(); return }
      if (key.ctrl && key.name === "c") {
        if (busyJobs().length) { controller.pauseAll(); setNotification("Pausing all active runs…") } else quit()
        key.preventDefault(); key.stopPropagation(); return
      }
      if (key.ctrl && key.name === "p" && screen() !== "auth-key") { setPalette(!palette()); key.preventDefault(); key.stopPropagation(); return }
      if ((palette() || confirmation()) && key.name !== "escape") return
      if (key.name === "f1") { go("help"); key.preventDefault(); key.stopPropagation(); return }
      if (key.name === "f6") {
        const panes = [...(dimensions().width >= 100 ? ["nav"] : []), "content", ...(hasDetails() ? ["details"] : [])] as Array<"nav" | "content" | "details">
        setFocus(panes[(panes.indexOf(focus()) + (key.shift ? panes.length - 1 : 1)) % panes.length]!)
        key.preventDefault(); key.stopPropagation(); return
      }
      if (key.name === "escape") {
        key.preventDefault(); key.stopPropagation()
        if (confirmation()) { setConfirmation(null); return }
        if (palette()) { setPalette(false); return }
        if (menuQuery() || viewerQuery()) { setMenuQuery(""); setViewerQuery(""); return }
        if (screen() !== "home") back()
      }
    })

    const refreshAuth = async () => {
      setAuthBusy(true)
      try {
        const statuses: Partial<Record<AuthProvider, AuthStatus>> = {}
        for (const provider of AUTH_PROVIDERS) statuses[provider.id] = await auth.status(provider.id)
        setAuthStatuses(statuses)
      } catch (reason) { fail(reason) }
      finally { setAuthBusy(false) }
    }
    const openAuth = (returnTo: Screen) => { authReturn = returnTo; setAuthNotice(""); go("auth"); void refreshAuth() }
    const saveAuth = async (field: "key" | "endpoint", value: string) => {
      if (authBusy()) return
      const provider = authProvider()
      setAuthBusy(true)
      try {
        await auth.save(provider, field, value)
        setAuthStatuses((previous) => ({ ...previous, [provider]: undefined }))
        if (screen() === "auth-key" || screen() === "auth-endpoint") go("auth-provider")
        setAuthNotice(field === "key" ? "Key saved in the system wallet." : "Endpoint saved in the system wallet.")
        const status = await auth.status(provider)
        setAuthStatuses((previous) => ({ ...previous, [provider]: status }))
      } catch (reason) { fail(reason) }
      finally { setAuthBusy(false) }
    }
    const removeAuth = async () => {
      if (authBusy()) return
      const provider = authProvider()
      setAuthBusy(true)
      try {
        await auth.remove(provider)
        go("auth-provider")
        setAuthNotice("Saved credentials removed. Environment variables still apply.")
        const status = await auth.status(provider)
        setAuthStatuses((previous) => ({ ...previous, [provider]: status }))
      } catch (reason) { fail(reason) }
      finally { setAuthBusy(false) }
    }
    const SecretEntry = () => {
      let secret = ""
      const [length, setLength] = createSignal(0)
      const append = (value: string) => { secret += value.replace(/[\r\n]/g, ""); setLength(secret.length) }
      onCleanup(() => { secret = "" })
      useKeyboard((key) => {
        if (!contentFocused()) return
        key.preventDefault(); key.stopPropagation()
        if (authBusy()) return
        if (key.ctrl && key.name === "u") { secret = ""; setLength(0) }
        else if (key.name === "backspace") { secret = secret.slice(0, -1); setLength(secret.length) }
        else if (["enter", "return"].includes(key.name)) { const value = secret; secret = ""; setLength(0); void saveAuth("key", value) }
        else if (!key.ctrl && !key.meta && !key.option && key.sequence.length === 1 && key.sequence >= " ") append(key.sequence)
      })
      usePaste((event) => { if (!contentFocused()) return; event.preventDefault(); if (!authBusy()) append(new TextDecoder().decode(event.bytes)) })
      return <box flexDirection="column" padding={1}><Header title="authentication · enter API key" subtitle="Paste or type your key · Enter saves · Backspace deletes · Ctrl-U clears · Esc cancels"/><ErrorLine/><text fg={muted}>Stored in your system wallet. Existing keys are never displayed.</text><text fg={blue}>{"•".repeat(Math.min(length(), 80)) || "Waiting for key…"}</text><Show when={authBusy()}><text>Saving… unlock your system wallet if prompted.</text></Show></box>
    }

    const acceptInput = (value: string) => {
      const nextInput = value.trim()
      if (!nextInput) return fail("Input cannot be blank.")
      try { if (!/^https?:\/\//i.test(nextInput)) requireMediaFile(nextInput) } catch (reason) { return fail(reason) }
      const automaticName = !runName || runName === suggestedRunName(input, settings)
      input = nextInput
      if (automaticName) runName = suggestedRunName(input, settings)
      if (!/^https?:\/\//i.test(input)) { preferences.mediaDirectory = dirname(resolve(expandUserPath(input))); rememberPreferences() }
      setSettingsVersion((value) => value + 1)
      go("review")
    }

    const prepareViewer = (title: string, text: string, run: RunRecord | null, document: TranscriptDocument | null, returnTo: Screen) => {
      viewerReturn = returnTo
      setViewerTitle(title)
      setViewerRawText(document?.text || text)
      setViewerText(document ? formatTranscript(document) : text)
      setViewerDocument(document)
      setViewerRunId(run?.id || null)
      setViewerNotice("")
      setViewerQuery("")
      go("compare-result")
    }

    const openRunViewer = (run: RunRecord, returnTo: Screen) => {
      const textPath = join(run.artifactDir, "transcript.txt")
      if (!existsSync(textPath)) throw new Error("Transcript is not available yet.")
      let document: TranscriptDocument | null = null
      const jsonPath = join(run.artifactDir, "transcript.json")
      if (existsSync(jsonPath)) {
        try { document = JSON.parse(readFileSync(jsonPath, "utf8")) as TranscriptDocument } catch {}
      }
      prepareViewer(run.name, readFileSync(textPath, "utf8"), run, document, returnTo)
    }

    const launchRun = (run: RunRecord, restart = false, showViewer = false) => {
      const id = run.id
      void controller.start(run, restart).then((completed) => {
        setNotification(`${completed.name} · ${completed.status}`)
        if (selectedRun()?.id === id) setSelectedRun(completed)
        if (showViewer && screen() === "active" && selectedRun()?.id === id && completed.status === "completed") openRunViewer(completed, "jobs")
      }).catch((reason) => { setNotification(`${run.name}: ${(reason as Error).message}`) })
    }
    const startRuns = async (showViewer = false, uniqueName = false, failureReturn: Screen = "review") => {
      const chosenInput = input, chosenName = runName, chosenSettings = structuredClone(settings)
      const requestedAt = navigationVersion
      let progressAt = -1
      const task = (async () => {
        try {
          await requireCredentialFor(chosenSettings.provider)
          if (shuttingDown()) return
          if (navigationVersion === requestedAt) { go("active"); progressAt = navigationVersion }
          const created = await createRunsFor(library, chosenInput, chosenName || undefined, chosenSettings, uniqueName)
          const stillHere = screen() === "active" && navigationVersion === progressAt
          for (const run of created) {
            if (stillHere) setSelectedRun(run)
            if (shuttingDown()) continue
            launchRun(run, false, showViewer && created.length === 1)
          }
          setSourcesVersion((value) => value + 1)
          setNotification(`Started ${created.length} run${created.length === 1 ? "" : "s"}`)
        } catch (reason) {
          if (navigationVersion === progressAt || navigationVersion === requestedAt) showFailure(reason, failureReturn)
          else setNotification((reason as Error).message)
        }
      })()
      pendingStarts.add(task)
      try { await task } finally { pendingStarts.delete(task) }
    }

    const startQuick = async (value: string) => {
      const location = expandUserPath(value.trim())
      if (!location) return fail("Choose a media file.")
      if (/^https?:\/\//i.test(location)) return fail("Quick Transcribe accepts a local media file. Use New transcription for URLs.")
      try { requireMediaFile(location) } catch (reason) { return fail(reason) }
      if (settings.provider === "youtube-transcript") return fail("Quick Transcribe requires an audio provider. Change the remembered provider in Settings.")
      try { await requireCredentialFor(settings.provider) } catch (reason) { return fail(reason) }
      input = location
      runName = suggestedRunName(location, settings)
      void startRuns(true, true, "quick-input")
    }

    const compare = async (first: string, second: string) => {
      try {
        const returnTo = screen()
        prepareViewer("comparison", "Comparing with OpenAI gpt-5.6-luna…", null, null, returnTo)
        const firstText = readFileSync(first, "utf8"), secondText = readFileSync(second, "utf8")
        const expectedTitle = viewerTitle()
        const result = await compareTranscripts(basename(first), firstText, basename(second), secondText)
        if (screen() === "compare-result" && viewerTitle() === expectedTitle) { setViewerRawText(result); setViewerText(result) }
        else setNotification("Transcript comparison finished. Open Compare to run another comparison.")
      } catch (reason) { showFailure(reason, viewerReturn) }
    }

    const settingRows = (): SelectOption[] => options([
      ["Transcription · Provider", settings.provider, "provider"], ["Model", settings.diarize && settings.provider === "openai" ? "gpt-4o-transcribe-diarize" : settings.model, "model"],
      ["Language", settings.language, "language"], ["Diarization", settings.diarize ? "on" : "off", "diarize"],
      ["YouTube subtitle cleanup", settings.cleanup ? "on" : "off", "cleanup"], ["Prompt", settings.prompt || "none", "prompt"],
      ["Processing · Chunk seconds", String(settings.chunkSeconds), "chunkSeconds"], ["Chunk overlap", String(settings.chunkOverlapSeconds), "chunkOverlapSeconds"],
      ["Continuity characters", String(settings.continuityChars), "continuityChars"], ["Chunk concurrency", String(settings.chunkConcurrency), "chunkConcurrency"],
      ["Maximum upload MB", String(settings.maxUploadMb), "maxUploadMb"], ["Maximum retries", String(settings.maxRetries), "maxRetries"],
      ["Initial retry seconds", String(settings.initialRetrySeconds), "initialRetrySeconds"], ["Keep audio", settings.keepAudio ? "yes" : "no", "keepAudio"],
      ["Keep chunks", settings.keepChunks ? "yes" : "no", "keepChunks"], ["Appearance", "Nerd Font icons or plain symbols", "appearance"], ["Authentication", "Manage saved API keys and Microsoft endpoint", "auth"], ["Save and return", "Persist these defaults", "done"],
    ])

    const editSetting = (key: keyof Settings | "done" | "auth" | "appearance") => {
      if (key === "appearance") { go("appearance"); return }
      if (key === "auth") { openAuth("settings"); return }
      if (key === "done") { try { saveSettings(settings); go(settingsReturn) } catch (reason) { fail(reason) }; return }
      if (key === "provider") { pickerReturn = screen() === "settings-group" ? "settings-group" : "settings"; go("new-provider"); return }
      if (key === "model") { pickerReturn = screen() === "settings-group" ? "settings-group" : "settings"; go("new-model"); return }
      if (["diarize", "cleanup", "keepAudio", "keepChunks"].includes(key)) {
        ;(settings as any)[key] = !(settings as any)[key]
        if (key === "diarize" && settings.diarize && settings.provider !== "microsoft") { settings.provider = "openai"; settings.model = "gpt-4o-transcribe-diarize" }
        if (key === "diarize" && !settings.diarize && settings.provider === "openai") settings.model = "gpt-4o-transcribe"
        setSettingsVersion((value) => value + 1); return
      }
      editingKey = key
      editingReturn = screen() === "review" ? "review" : screen() === "settings-group" ? "settings-group" : "settings"
      go("setting-input")
    }

    const submitSetting = (value: string) => {
      if (!editingKey) return
      if (["chunkSeconds", "chunkOverlapSeconds", "continuityChars", "chunkConcurrency", "maxUploadMb", "maxRetries", "initialRetrySeconds"].includes(editingKey)) (settings as any)[editingKey] = Number(value)
      else (settings as any)[editingKey] = value
      editingKey = null; setSettingsVersion((v) => v + 1); go(editingReturn)
    }

    const Header = (props: { title: string, subtitle?: string }) => <box flexShrink={0} flexDirection="column" marginBottom={1}><text fg={theme.text}><strong>{props.title}</strong></text><Show when={props.subtitle}><text fg={muted} wrapMode="word">{props.subtitle}</text></Show></box>
    const ErrorLine = () => <Show when={error()}><text fg={red} wrapMode="word">{glyph("failed")} {error()}</text></Show>
    const selectStyle = { backgroundColor: panel, textColor: theme.text, focusedBackgroundColor: panel, focusedTextColor: theme.text, selectedBackgroundColor: theme.selected, selectedTextColor: blue, descriptionColor: muted, selectedDescriptionColor: theme.text, showSelectionIndicator: false, showScrollIndicator: true, showDescription: false, itemSpacing: 0 }
    const previewCache = new Map<string, { updated: string, text: string }>()
    const runDescription = (run: RunRecord) => {
      const source = library.requireSource(run.sourceId)
      let preview = "No transcript yet."
      const cached = previewCache.get(run.id)
      if (cached?.updated === run.updatedAt) preview = cached.text
      else { try { preview = readFileSync(join(run.artifactDir, "transcript.txt"), "utf8").slice(0, 5000) } catch {} previewCache.set(run.id, { updated: run.updatedAt, text: preview }) }
      jobsVersion()
      const entry = controller.entries.get(run.id)
      const progress = entry ? `\n${entry.event.message}${entry.event.total ? ` · ${entry.event.completed || 0}/${entry.event.total} chunks` : ""}\n` : ""
      return `${source.title}\n${run.provider} / ${run.model}\n${run.status} · ${run.settings.language}${progress}\n\n${source.locator}\n\n${run.error ? run.error + "\n\n" : ""}${preview}`
    }
    const Menu = (props: { title: string, subtitle?: string, items: SelectOption[], select: (option: SelectOption) => void }) => {
      const [selected, setSelected] = createSignal<SelectOption | null>(null)
      let list: SelectRenderable | undefined
      const filtered = createMemo(() => fuzzyOptions(menuQuery(), props.items))
      const visible = createMemo(() => filtered().length ? filtered() : options([["No matches", "Backspace to broaden the search", "__no_match__"]]))
      const decorated = createMemo(() => visible().map((option) => ({ ...option, name: `${String(option.value).startsWith("run_") || String(option.value).startsWith("recent:") ? "" : glyph(actionIcon(option.value, option.name)) + "  "}${option.name}${["review", "settings-group", "appearance", "auth"].includes(screen()) ? "  ·  " + option.description : ""}` })))
      createEffect(() => {
        const items = visible()
        const index = Math.max(0, items.findIndex((item) => item.value === currentSelection))
        list?.setSelectedIndex(index)
        setSelected(items[index] || null)
      })
      const details = createMemo(() => {
        const item = selected()
        if (!item) return ""
        const id = String(item.value).replace(/^recent:/, "")
        if (id.startsWith("run_")) { try { return runDescription(library.requireRun(id)) } catch {} }
        return item.description
      })
      createEffect(() => setHasDetails(dimensions().width >= 120))
      onCleanup(() => setHasDetails(false))
      useKeyboard((key) => {
        if (!contentFocused()) return
        if (key.ctrl && key.name === "u") { setMenuQuery(""); key.preventDefault(); return }
        if (key.name === "backspace") { setMenuQuery((value) => [...value].slice(0, -1).join("")); key.preventDefault(); return }
        if (!key.ctrl && !key.meta && !key.option && key.sequence.length === 1 && key.sequence >= " ") {
          setMenuQuery((value) => value + key.sequence); key.preventDefault()
        }
      })
      usePaste((event) => {
        if (!contentFocused()) return
        setMenuQuery((value) => value + new TextDecoder().decode(event.bytes).replace(/\s+/g, " ")); event.preventDefault()
      })
      return <box flexDirection="column" width="100%" height="100%" padding={1}>
        <Header title={props.title} subtitle={props.subtitle}/><ErrorLine/>
        <box height={2} flexShrink={0}><text fg={blue}>{glyph("search")} Search › {menuQuery() || "type to filter…"} <span> {filtered().length} items</span></text></box>
        <box flexDirection="row" flexGrow={1} minHeight={3} gap={1}>
          <box flexDirection="column" flexGrow={1} width={dimensions().width >= 120 ? "60%" : "100%"} border borderColor={focus() === "content" ? blue : theme.border} backgroundColor={panel} padding={1} onMouseDown={() => setFocus("content")}>
            <ChoiceList onActivate={() => setFocus("content")} ref={(value) => list = value} {...selectStyle} focused={contentFocused()} width="100%" height="100%" options={decorated()} wrapSelection onChange={(_, option) => { const item = visible().find((candidate) => candidate.value === option?.value) || null; setSelected(item); currentSelection = item?.value }} onSelect={(_, option) => { const item = visible().find((candidate) => candidate.value === option?.value); if (item && item.value !== "__no_match__") props.select(item) }}/>
          </box>
          <Show when={dimensions().width >= 120}><box width="38%" flexDirection="column" border borderColor={focus() === "details" ? blue : theme.border} padding={1} onMouseDown={() => setFocus("details")}><text fg={blue}><strong>{selected()?.name || "Details"}</strong></text><scrollbox focused={focus() === "details" && !palette() && !confirmation()} flexGrow={1}><text fg={muted} wrapMode="word" selectable>{details()}</text></scrollbox></box></Show>
        </box>
        <Show when={dimensions().width < 120}><box height={2} flexShrink={0} paddingTop={1}><text fg={muted} truncate>{selected()?.description || ""}</text></box></Show>
      </box>
    }

    const PathEntry = (props: { title: string, placeholder: string, extensions: string[], submit: (value: string) => void, allowUrls?: boolean, directoriesOnly?: boolean, initialValue?: string }) => {
      if (props.initialValue) setPathQuery(props.initialValue)
      let picker: SelectRenderable | undefined, field: InputRenderable | undefined
      const suggestions = createMemo(() => pathSuggestions(pathQuery(), props.extensions).filter((item) => !props.directoriesOnly || item.directory))
      const currentFolder = createMemo(() => {
        const path = resolve(expandUserPath(pathQuery().trim() || "."))
        return existsSync(path) && statSync(path).isDirectory() ? path : null
      })
      const suggestionOptions = createMemo(() => [
        ...(props.directoriesOnly && currentFolder() ? options([["Use this folder", currentFolder()!, "__use_folder__"]]) : []),
        ...(suggestions().length ? suggestions().map((item) => ({ name: item.name, description: item.description, value: item.path }))
        : options([["No path suggestions", props.allowUrls ? "Keep typing, paste a path or URL, or press Esc" : "Keep typing, paste a local path, or press Esc", "__none__"]])),
      ])
      usePaste((event) => {
        if (!contentFocused()) return
        const pasted = new TextDecoder().decode(event.bytes).trim().replace(/^(["'])(.*)\1$/, "$2")
        if (pasted.startsWith(sep) || pasted.startsWith("~") || /^https?:\/\//i.test(pasted)) {
          event.preventDefault(); setPathQuery(pasted); field?.focus()
        }
      })
      const complete = () => {
        const selected = picker?.getSelectedOption()
        if (!selected || ["__none__", "__use_folder__"].includes(String(selected.value))) return
        setPathQuery(String(selected.value))
        field?.focus()
      }
      const submitPath = (value: string) => {
        try {
          const path = resolve(expandUserPath(value.trim()))
          if (!/^https?:\/\//i.test(value) && existsSync(path) && statSync(path).isDirectory()) {
            setError(""); setPathQuery(`${path}${sep}`); field?.focus(); return
          }
          props.submit(value)
        } catch (reason) { fail(reason) }
      }
      const acceptSelectedPath = () => {
        const selected = picker?.getSelectedOption()
        if (selected?.value === "__use_folder__") { props.submit(currentFolder()!); return }
        submitPath(selected && selected.value !== "__none__" ? String(selected.value) : pathQuery())
      }
      useKeyboard((key) => {
        if (!contentFocused()) return
        if (key.ctrl && ["h", "d", "b"].includes(key.name)) {
          const target = key.name === "h" ? process.env.HOME || "." : key.name === "d" ? join(process.env.HOME || ".", "Downloads") : dirname(resolve(expandUserPath(pathQuery() || ".")))
          setPathQuery(target + sep); key.preventDefault(); return
        }
        if (["return", "enter"].includes(key.name)) { acceptSelectedPath(); key.preventDefault(); key.stopPropagation(); return }
        if (key.ctrl && key.name === "u") { setPathQuery(""); key.preventDefault(); return }
        if (key.name === "tab") { complete(); key.preventDefault(); return }
        if (["down", "arrowdown"].includes(key.name)) { picker?.moveDown(); key.preventDefault(); return }
        if (["up", "arrowup"].includes(key.name)) { picker?.moveUp(); key.preventDefault() }
      })
      return <box flexDirection="column" width="100%" height="100%" padding={1}><Header title={props.title} subtitle={`Type or paste a ${props.allowUrls ? "path/URL" : "local path"}  Tab completes  ↑/↓ highlight  ${props.directoriesOnly ? "Enter opens folder or chooses Use this folder" : "Enter selects file or opens folder"}`}/><ErrorLine/><box height={1} flexShrink={0} flexDirection="row" gap={3}><text fg={blue} onMouseDown={() => setPathQuery((process.env.HOME || ".") + sep)}>{glyph("home")} Home ^H</text><text fg={blue} onMouseDown={() => setPathQuery(join(process.env.HOME || ".", "Downloads") + sep)}>{glyph("export")} Downloads ^D</text><text fg={blue} onMouseDown={() => setPathQuery(dirname(resolve(expandUserPath(pathQuery() || "."))) + sep)}>↑ Parent ^B</text></box><box border borderColor={blue} height={3} paddingLeft={1} paddingRight={1}><input ref={(value) => field = value} focused={contentFocused()} width="100%" value={pathQuery()} placeholder={props.placeholder} onInput={setPathQuery} onSubmit={acceptSelectedPath}/></box><box border borderColor={theme.border} backgroundColor={panel} padding={1} flexGrow={1}><ChoiceList onActivate={() => setFocus("content")} ref={(value) => picker = value} {...selectStyle} width="100%" height="100%" options={suggestionOptions().map((item) => ({ ...item, name: `${glyph(item.value === "__use_folder__" ? "completed" : item.value === "__none__" ? "info" : String(item.value).endsWith(sep) ? "folder" : "file")}  ${item.name}` }))} wrapSelection onSelect={(_, option) => { if (option?.value === "__use_folder__" && currentFolder()) props.submit(currentFolder()!); else if (option?.value && option.value !== "__none__") submitPath(String(option.value)) }}/></box></box>
    }

    const openViewerEditor = async () => {
      const runId = viewerRunId()
      if (!runId) { setViewerNotice("This result is not attached to an editable run."); return }
      const path = join(library.requireRun(runId).artifactDir, "transcript.txt")
      const editor = process.env.VISUAL || process.env.EDITOR || Bun.which("nvim") || Bun.which("vim") || Bun.which("vi")
      if (!editor) { setViewerNotice("Set $EDITOR or $VISUAL to open transcripts."); return }
      const command = typeof editor === "string" ? editor.trim().split(/\s+/).filter(Boolean) : [String(editor)]
      renderer.suspend()
      try {
        const exitCode = await Bun.spawn([...command, path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
        setViewerNotice(exitCode === 0 ? "Editor closed." : `Editor exited with status ${exitCode}.`)
      } catch (reason) { setViewerNotice(`Could not open editor: ${(reason as Error).message}`) }
      finally { renderer.resume() }
    }

    const Viewer = () => {
      let scroller: ScrollBoxRenderable | undefined
      const [matchIndex, setMatchIndex] = createSignal(0)
      const matches = createMemo(() => findTextMatches(viewerText(), viewerQuery()))
      const jump = (next: number) => {
        const available = matches()
        if (!available.length) return
        const index = (next + available.length) % available.length
        setMatchIndex(index)
        scroller?.scrollTo({ x: 0, y: Math.max(0, available[index]!.line - 2) })
      }
      createEffect(() => {
        viewerQuery()
        const available = matches()
        setMatchIndex(0)
        if (available[0]) scroller?.scrollTo({ x: 0, y: Math.max(0, available[0].line - 2) })
      })
      useKeyboard((key) => {
        if (!contentFocused()) return
        if (key.ctrl && key.name === "e") { void openViewerEditor(); key.preventDefault(); return }
        if (key.ctrl && key.name === "y") {
          const copied = renderer.copyToClipboardOSC52(viewerRawText())
          setViewerNotice(copied ? "Transcript copied to the terminal clipboard." : "This terminal did not accept clipboard copy.")
          key.preventDefault(); return
        }
        if (key.ctrl && key.name === "u") { setViewerQuery(""); key.preventDefault(); return }
        if (key.name === "backspace" && viewerQuery()) { setViewerQuery((value) => [...value].slice(0, -1).join("")); key.preventDefault(); return }
        if ((key.name === "return" || key.name === "enter") && viewerQuery()) { jump(matchIndex() + (key.shift ? -1 : 1)); key.preventDefault(); return }
        if (!key.ctrl && !key.meta && !key.option && key.sequence.length === 1 && key.sequence >= " ") {
          setViewerQuery((value) => value + key.sequence)
          key.preventDefault()
        }
      })
      usePaste((event) => {
        if (!contentFocused()) return
        setViewerQuery((value) => value + new TextDecoder().decode(event.bytes).replace(/\s+/g, " "))
        event.preventDefault()
      })
      const metadata = () => viewerMetadata(viewerRunId() ? library.requireRun(viewerRunId()!) : null, viewerDocument())
      const searchStatus = () => viewerQuery()
        ? matches().length ? `${matchIndex() + 1}/${matches().length} · line ${matches()[matchIndex()]!.line + 1}` : "no matches"
        : ""
      return <box flexDirection="column" width="100%" height="100%" padding={1}><Header title={viewerTitle()} subtitle="Type=find  Enter=next  Shift-Enter=prev  ^Y=copy  ^E=editor  Esc=back"/><box height={1}><text fg={muted}>{metadata()}</text></box><box height={2}><text fg={blue}>Find › {viewerQuery() || "type to search…"}  {searchStatus()}</text></box><Show when={viewerNotice()}><box height={1}><text fg={green}>{viewerNotice()}</text></box></Show><scrollbox ref={(value) => scroller = value} focused={contentFocused()} border borderColor={theme.border} padding={1} flexGrow={1}><text selectable>{viewerText()}</text></scrollbox></box>
    }

    const mediaChoices = () => mediaCache ??= discoverFiles(MEDIA_EXTENSIONS)
    const textChoices = () => textCache ??= discoverFiles(TEXT_EXTENSIONS)
    const fileItems = (choices: FileChoice[], manualDescription: string, manualName = "Enter an exact path or URL…"): SelectOption[] => [
      { name: manualName, description: manualDescription, value: "__manual__" },
      ...choices.map((choice) => ({ name: choice.name, description: choice.description, value: choice.path })),
    ]

    const navigation = () => options([
      ["Home", "Quick actions and recent runs", "home"], ["New transcription", "Choose a file and configure a run", "new"],
      ["Library", "Search your transcripts", "library"], ["Jobs", `${busyJobs().length} active`, "jobs"],
      ["Compare", "Compare two transcripts", "compare"], ["Authentication", "Provider keys and endpoints", "auth"], ["Settings", "Transcription and appearance", "settings"],
    ])
    const navigate = (target: string) => {
      setPalette(false)
      if (target === "home") home()
      else if (target === "new") { mediaReturn = "review"; go(input ? "review" : "new-input") }
      else if (target === "library") go(preferences.libraryView === "sources" ? "sources" : "library")
      else if (target === "auth") openAuth(screen())
      else if (target === "settings") { settingsReturn = "home"; go("settings") }
      else if (target === "compare") go("compare-mode")
      else go(target as Screen)
    }
    const section = () => screen().startsWith("auth") ? "auth" : ["library", "sources", "runs", "run", "export-folder", "export-name"].includes(screen()) ? "library" : ["jobs", "active"].includes(screen()) ? "jobs" : screen().startsWith("compare") ? "compare" : ["settings", "settings-group", "appearance", "setting-input"].includes(screen()) ? "settings" : screen() === "home" ? "home" : "new"
    const CommandPalette = () => {
      const [query, setQuery] = createSignal("")
      const commands = () => [
        ...navigation(), { name: "Quick Transcribe", description: "Start with remembered settings", value: "quick-input" },
        { name: "Help", description: "Keyboard reference", value: "help" }, { name: "Quit", description: "Close the app safely", value: "quit" },
        ...(selectedRun()?.status === "completed" && ["run", "compare-result"].includes(screen()) ? options([["Copy transcript", "Copy selected run", "copy-current"], ["Export TXT", "Export selected run", "export-current"]]) : []),
      ]
      const found = () => fuzzyOptions(query(), commands())
      useKeyboard((key) => {
        if (key.ctrl || key.meta || key.option) return
        if (key.name === "backspace") setQuery((value) => [...value].slice(0, -1).join(""))
        else if (key.sequence.length === 1 && key.sequence >= " ") setQuery((value) => value + key.sequence)
      })
      usePaste((event) => { event.preventDefault(); setQuery((value) => value + new TextDecoder().decode(event.bytes).replace(/\s+/g, " ")) })
      return <box position="absolute" top={2} left="10%" width="80%" height={Math.min(18, dimensions().height - 5)} border borderColor={blue} backgroundColor={panel} padding={1} flexDirection="column"><text fg={blue}><strong>Actions</strong>  {glyph("search")} {query() || "type to search…"}</text><ChoiceList {...selectStyle} focused options={found()} flexGrow={1} onSelect={(_, option) => {
        if (!option) return
        setPalette(false)
        if (option.value === "quit") quit()
        else if (option.value === "copy-current") {
          try { const text = readFileSync(join(selectedRun()!.artifactDir, "transcript.txt"), "utf8"); if (!renderer.copyToClipboardOSC52(text)) throw new Error("This terminal did not accept clipboard copy."); setNotification("Transcript copied to clipboard.") } catch (reason) { fail(reason) }
        } else if (option.value === "export-current") { exportFormat = "txt"; go("export-folder") }
        else navigate(String(option.value))
      }}/><text fg={muted}>Enter choose · Esc close</text></box>
    }
    const Confirmation = () => <box position="absolute" top="20%" left="10%" width="80%" border borderColor={theme.amber} backgroundColor={panel} padding={1} flexDirection="column"><text fg={theme.amber}><strong>{confirmation()!.title}</strong></text><text fg={theme.text} wrapMode="word">{confirmation()!.description}</text><ChoiceList {...selectStyle} focused height={3} options={options([["Keep working / Cancel", "", "cancel"], ["Confirm", "", "confirm"]])} onSelect={(_, option) => { const pending = confirmation(); setConfirmation(null); if (option?.value === "confirm") pending?.action() }}/></box>

    return <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      <box height={2} flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="space-between"><text fg={blue}><strong>{glyph("audio")} transcribe</strong> <span> / {section()}</span></text><text fg={busyJobs().length ? theme.amber : muted} onMouseDown={() => navigate("jobs")}>{glyph("jobs")} {busyJobs().length} active</text></box>
      <Show when={dimensions().width < 100}><box height={1} flexShrink={0} paddingLeft={1} flexDirection="row" gap={3}><text fg={blue} onMouseDown={() => navigate("home")}>{glyph("home")} Home</text><text fg={blue} onMouseDown={() => navigate("library")}>{glyph("library")} Library</text><text fg={blue} onMouseDown={() => navigate("jobs")}>{glyph("jobs")} Jobs</text><text fg={blue} onMouseDown={() => setPalette(true)}>{glyph("search")} Actions ^P</text></box></Show>
      <box flexDirection="row" flexGrow={1} minHeight={1}>
        <Show when={dimensions().width >= 100}><box width={22} flexShrink={0} border borderColor={focus() === "nav" ? blue : theme.border} padding={1} flexDirection="column" onMouseDown={() => setFocus("nav")}><text fg={muted}>WORKSPACE</text><ChoiceList onActivate={() => setFocus("nav")} {...selectStyle} focused={focus() === "nav" && !palette() && !confirmation() && !shuttingDown()} options={navigation().map((item) => ({ ...item, name: `${glyph(actionIcon(item.value, item.name))}  ${item.value === "new" ? "New run" : item.name}` }))} selectedIndex={Math.max(0, navigation().findIndex((item) => item.value === section()))} flexGrow={1} onSelect={(_, option) => option && navigate(String(option.value))}/><text fg={muted}>F6 switch pane</text><text fg={muted}>Ctrl-P actions</text></box></Show>
        <box flexGrow={1} minWidth={1} flexDirection="column">
      <Show when={screen() === "home"}><Menu title="Home" subtitle="Quick actions and recent runs" items={options([
        ["Quick Transcribe", `Choose a local file and start with ${settings.provider}/${settings.diarize && settings.provider === "openai" ? "gpt-4o-transcribe-diarize" : settings.model}`, "quick"],
        ["New transcription", "Name the run and review settings before starting", "new"], ["Library", "Browse sources and named runs", "library"],
        ["Authentication", "Manage API keys in the system wallet", "auth"], ["Compare transcripts", "Choose two library runs or text files", "compare"], ["Settings", "Remember provider, model, and job defaults", "settings"],
        ["Jobs", `${busyJobs().length} active runs`, "jobs"], ["Help", "Commands and keyboard shortcuts", "help"], ["Quit", "Return to the shell", "quit"],
        ...library.listRuns().slice(0, 6).map((run): [string, string, string] => [`${glyph(statusIcon(run.status))} ${run.name}`, `${run.status} · ${run.provider}/${run.model}`, `recent:${run.id}`]),
      ])} select={(option) => { if (String(option.value).startsWith("recent:")) { runReturn = "home"; setSelectedRun(library.requireRun(String(option.value).slice(7))); go("run") } else if (option.value === "jobs") go("jobs"); else if (option.value === "quick") go("quick-input"); else if (option.value === "new") { mediaReturn = "home"; go("new-input") } else if (option.value === "library") go(preferences.libraryView === "sources" ? "sources" : "library"); else if (option.value === "auth") openAuth("home"); else if (option.value === "compare") go("compare-mode"); else if (option.value === "settings") { settingsReturn = "home"; go("settings") } else if (option.value === "help") go("help"); else quit() }}/></Show>

      <Show when={screen() === "auth"}><Menu title="authentication" subtitle={authBusy() ? "Reading system wallet… unlock it if prompted." : "Environment variables override saved keys. Select a provider to configure it."} items={AUTH_PROVIDERS.map((provider) => ({ name: provider.label, description: `API key: ${authStatuses()[provider.id]?.key || "not loaded"}`, value: provider.id }))} select={(option) => { if (authBusy()) return; setAuthProvider(option.value as AuthProvider); setAuthNotice(""); go("auth-provider") }}/></Show>
      <Show when={screen() === "auth-provider"}><Menu title={`authentication · ${AUTH_PROVIDERS.find((provider) => provider.id === authProvider())!.label}`} subtitle={`${authNotice() ? authNotice() + " " : ""}Active API key: ${authStatuses()[authProvider()]?.key || "not loaded"}. Environment variables take precedence.`} items={options([
        ["Set API key", "Save or replace a key in the system wallet", "key"],
        ...(authProvider() === "microsoft" ? [["Set Speech endpoint", authStatuses().microsoft?.endpoint ? `${authStatuses().microsoft!.endpoint} · ${authStatuses().microsoft!.endpointSource}` : "Azure Speech resource HTTPS URL", "endpoint"] as [string, string, string]] : []),
        ["Remove saved credentials", "Clear this provider's saved key and endpoint", "remove"], ["Back", "All providers", "back"],
      ])} select={(option) => { if (authBusy()) return; if (option.value === "key") go("auth-key"); else if (option.value === "endpoint") go("auth-endpoint"); else if (option.value === "remove") go("auth-remove"); else go("auth") }}/></Show>
      <Show when={screen() === "auth-key"}><SecretEntry/></Show>
      <Show when={screen() === "auth-endpoint"}><box flexDirection="column" padding={1}><Header title="authentication · Microsoft Speech endpoint" subtitle="Use the resource HTTPS URL without a path. Enter saves; Esc cancels."/><ErrorLine/><input focused={contentFocused()} placeholder="https://YOUR-RESOURCE.cognitiveservices.azure.com" onSubmit={(value) => { void saveAuth("endpoint", String(value)) }}/><Show when={authBusy()}><text>Saving…</text></Show></box></Show>
      <Show when={screen() === "auth-remove"}><Menu title="remove saved credentials?" subtitle="Environment variables remain available." items={options([["Cancel", "Keep saved credentials", "cancel"], ["Remove", "Clear this provider's saved key and endpoint", "remove"]])} select={(option) => { if (option.value === "remove") void removeAuth(); else if (!authBusy()) go("auth-provider") }}/></Show>

      <Show when={screen() === "quick-input"}><Menu title="quick transcribe · choose media" subtitle={`Starts immediately with ${settings.provider}/${settings.diarize && settings.provider === "openai" ? "gpt-4o-transcribe-diarize" : settings.model} · ${settings.language}`} items={fileItems(mediaChoices(), "Enter a local media path not listed below", "Enter an exact local path…")} select={(option) => option.value === "__manual__" ? go("quick-location") : startQuick(String(option.value))}/></Show>
      <Show when={screen() === "quick-location"}><PathEntry title="quick transcribe · exact path" placeholder="local media path" extensions={MEDIA_EXTENSIONS} initialValue={`${preferences.mediaDirectory}${sep}`} submit={startQuick}/></Show>
      <Show when={screen() === "new-input"}><Menu title="new transcription · media" items={fileItems(mediaChoices(), "Use this for a YouTube URL or a file not listed below")} select={(option) => option.value === "__manual__" ? go("new-location") : acceptInput(String(option.value))}/></Show>
      <Show when={screen() === "new-location"}><PathEntry title="new transcription · exact location" placeholder="path or URL" extensions={MEDIA_EXTENSIONS} initialValue={`${preferences.mediaDirectory}${sep}`} submit={acceptInput} allowUrls/></Show>
      <Show when={screen() === "new-provider"}><Menu title="provider" items={options([
        ["OpenAI", "GPT transcription models", "openai"], ["Microsoft", "MAI transcription models", "microsoft"], ["Groq", "Whisper Large v3", "groq"], ["Fireworks", "Whisper v3", "fireworks"], ["YouTube transcript", "Use existing English subtitles", "youtube-transcript"],
      ])} select={(option) => { settings.provider = option.value as Provider; settings.diarize = false; settings.model = modelsFor(settings.provider).find((model) => model.default)?.id || "youtube"; setSettingsVersion((value) => value + 1); go(pickerReturn) }}/></Show>
      <Show when={screen() === "new-model"}><Menu title="model" items={settings.provider === "youtube-transcript" ? options([["YouTube subtitles", "Use the best available English subtitles", "youtube"]]) : modelsFor(settings.provider).map((model) => ({ name: model.label, description: `${model.id}${model.diarization ? " · speaker labels" : ""}`, value: model.id }))} select={(option) => { settings.model = String(option.value); settings.diarize = settings.model === "gpt-4o-transcribe-diarize"; setSettingsVersion((value) => value + 1); go(pickerReturn) }}/></Show>
      <Show when={screen() === "review"}><Menu title="New transcription · setup" subtitle="Choose a file and adjust the settings below. Changes stay in this draft." items={(settingsVersion(), options([
        ["Start transcription", input ? `${settings.provider} / ${settings.model}` : "Choose a file first", "start"],
        ["Change file", input || "No file selected", "file"], ["Name", runName || "Suggested after choosing a file", "name"],
        ["Change provider", settings.provider, "provider"], ["Change model", settings.model, "model"],
        ["Language", settings.language, "language"], ["Diarization", settings.diarize ? "On · speaker labels" : "Off", "diarize"],
        [advanced() ? "Hide advanced options" : "Advanced options", "Chunking, retries, prompts, and artifacts", "advanced"],
        ...(advanced() ? settingRows().filter((row) => !["provider", "model", "language", "diarize", "done", "auth", "appearance"].includes(String(row.value))).map((row): [string, string, unknown] => [row.name, row.description, row.value]) : []),
        ["Cancel", "Return home; keep this draft", "cancel"],
      ]))} select={(option) => {
        const key = String(option.value)
        if (key === "start") { if (!input) return fail("Choose a media file first."); void startRuns() }
        else if (key === "file") { mediaReturn = "review"; mediaCache = null; go("new-input") }
        else if (key === "name") go("setup-name")
        else if (key === "language") go("setup-language")
        else if (key === "provider" || key === "model") { pickerReturn = "review"; go(key === "provider" ? "new-provider" : "new-model") }
        else if (key === "advanced") setAdvanced(!advanced())
        else if (key === "cancel") home()
        else { settingsReturn = "review"; editSetting(key as keyof Settings) }
      }}/></Show>
      <Show when={screen() === "setup-name" || screen() === "setup-language"}><box padding={1} flexDirection="column"><Header title={screen() === "setup-name" ? "Run name" : "Language"} subtitle="Enter saves · Esc returns to setup"/><input focused={contentFocused()} value={screen() === "setup-name" ? runName : settings.language} onSubmit={(value) => {
        const trimmed = String(value).trim()
        if (!trimmed) return fail("Enter a value.")
        if (screen() === "setup-name") runName = trimmed; else settings.language = trimmed
        setSettingsVersion((v) => v + 1); go("review")
      }}/><ErrorLine/></box></Show>
      <Show when={screen() === "active"}><Menu title="Run progress" subtitle={selectedRun()?.name || "Creating runs…"} items={options([
        ...(selectedRun() ? [[controller.isActive(selectedRun()!.id) ? "Pause this run" : "Open run", (() => { jobsVersion(); return controller.entries.get(selectedRun()!.id)?.event.message || "Starting…" })(), "current"] as [string, string, string]] : []),
        ["All jobs", `${busyJobs().length} active runs`, "jobs"], ["New transcription", "Start another run while these continue", "new"], ["Library", "Browse, copy, and export", "library"],
      ])} select={(option) => {
        if (option.value === "current" && selectedRun()) { if (controller.isActive(selectedRun()!.id)) controller.pause(selectedRun()!.id); else { runReturn = "jobs"; go("run") } }
        else navigate(String(option.value))
      }}/></Show>
      <Show when={screen() === "jobs"}><Menu title="Jobs" subtitle={`${busyJobs().length} active · starts are unrestricted`} items={options([
        ["New transcription", "Start another run", "new"],
        ...(busyJobs().length ? [["Pause all", "Finish current work and pause each active run", "pause-all"] as [string, string, string]] : []),
        ...jobRows().map((entry): [string, string, string] => {
          const seconds = Math.floor(((entry.endedAt || clock()) - entry.startedAt) / 1000)
          const progress = entry.event.total ? ` · ${entry.event.completed || 0}/${entry.event.total} chunks` : ""
          return [`${glyph(statusIcon(entry.busy ? entry.pausing ? "pausing" : "transcribing" : entry.run.status))} ${entry.run.name}`, `${entry.event.message}${progress} · ${seconds}s`, entry.run.id]
        }),
        ...(!jobRows().length ? [["No jobs this session", "Your past runs are in Library", "library"] as [string, string, string]] : []),
      ])} select={(option) => {
        if (option.value === "pause-all") controller.pauseAll()
        else if (String(option.value).startsWith("run_")) { runReturn = "jobs"; setSelectedRun(library.requireRun(String(option.value))); go("run") }
        else navigate(String(option.value))
      }}/></Show>
      <Show when={screen() === "library"}><Menu title="Library · all runs" subtitle="Recent runs first · select a run to view its transcript and actions" items={(sourcesVersion(), options([
        [`Status: ${libraryStatus()}`, "Cycle all, completed, paused, failed, and active", "filter-status"],
        ["Group by source", "Browse recordings and their alternate runs", "sources"],
        ...library.listRuns().filter((run) => libraryStatus() === "all" || (libraryStatus() === "active" ? controller.isActive(run.id) : run.status === libraryStatus())).map((run): [string, string, string] => [`${glyph(statusIcon(run.status))} ${run.name}`, `${run.status} · ${run.provider}/${run.model}`, run.id]),
      ]))} select={(option) => {
        if (option.value === "filter-status") { const statuses = ["all", "completed", "paused", "failed", "active"]; setLibraryStatus(statuses[(statuses.indexOf(libraryStatus()) + 1) % statuses.length]!); setMenuQuery("") }
        else if (option.value === "sources") { preferences.libraryView = "sources"; rememberPreferences(); go("sources") }
        else { runReturn = "library"; setSelectedRun(library.requireRun(String(option.value))); go("run") }
      }}/></Show>
      <Show when={screen() === "sources"}><Menu title="Library · sources" items={[{ name: "All runs", description: "Browse every transcription", value: "__all__" }, ...(sources().length ? sources().map((source) => ({ name: source.title, description: `${source.kind} · ${library.listRunsForSource(source.id).length} run(s)`, value: source.id })) : options([["No sources yet", "Create a transcription first", "none"]]))]} select={(option) => { if (option.value === "__all__") { preferences.libraryView = "runs"; rememberPreferences(); go("library"); return } if (option.value === "none") return; setSelectedSource(library.requireSource(String(option.value))); go("runs") }}/></Show>
      <Show when={screen() === "runs"}><Menu title={`library · ${selectedSource()?.title || "runs"}`} items={runs().length ? runs().map((run) => ({ name: run.name, description: `${run.status} · ${run.provider}/${run.model}`, value: run.id })) : options([["No runs", "This source has no runs", "none"]])} select={(option) => { if (option.value === "none") return; runReturn = "runs"; setSelectedRun(library.requireRun(String(option.value))); go("run") }}/></Show>
      <Show when={screen() === "run" && selectedRun()}><Menu title={selectedRun()?.name || "run"} subtitle={`${selectedRun()?.status} · ${selectedRun()?.provider}/${selectedRun()?.model}${runNotice() ? `\n${runNotice()}` : ""}`} items={(jobsVersion(), sourcesVersion(), options([
        ...(selectedRun()?.status === "completed" ? [["View transcript", "Read the transcript", "view"], ["Copy transcript", "Copy entire transcript to clipboard", "copy"], ["Export TXT", "Choose a folder and filename", "export-txt"], ["Export JSON", "Export the structured transcript", "export-json"], ["Compare transcripts", "Choose a second transcript", "compare-run"]] as Array<[string, string, string]> : []),
        ...(controller.isActive(selectedRun()!.id) ? [["Pause this run", controller.entries.get(selectedRun()!.id)?.event.message || "Active", "pause"]] as Array<[string, string, string]> : ["draft", "failed", "paused", "cancelled", "preparing", "transcribing", "pausing"].includes(selectedRun()!.status) ? [["Resume", "Continue incomplete chunks", "resume"]] as Array<[string, string, string]> : []),
        ["Duplicate settings", "Create a separate run", "duplicate"], ["Rename", "Change display name", "rename"],
        ...(!controller.isActive(selectedRun()!.id) ? [["Restart", "Replace this transcript and transcribe again", "restart"], ["Delete permanently", "Requires exact run-name confirmation", "delete"]] as Array<[string, string, string]> : []),
        ["Back", "Return to previous list", "back"],
      ]))} select={(option) => {
        const run = selectedRun()!
        if (option.value === "view") { try { openRunViewer(run, "run") } catch (reason) { fail(reason) } }
        else if (option.value === "copy") {
          setError(""); setRunNotice("")
          try {
            const path = join(run.artifactDir, "transcript.txt")
            if (!existsSync(path)) throw new Error("Transcript is not available yet.")
            if (!renderer.copyToClipboardOSC52(readFileSync(path, "utf8"))) throw new Error("This terminal did not accept clipboard copy.")
            setRunNotice("Transcript copied to clipboard.")
          } catch (reason) { fail(reason) }
        }
        else if (option.value === "pause") controller.pause(run.id)
        else if (option.value === "compare-run") { setSelectedSource(library.requireSource(run.sourceId)); setCompareSelected([run.id]); go("compare-runs") }
        else if (option.value === "resume" || option.value === "restart") {
          if (controller.isActive(run.id)) return fail("This run is already active.")
          const start = () => { setSelectedRun(run); go("active"); launchRun(run, option.value === "restart") }
          if (option.value === "restart") setConfirmation({ title: "Restart transcription?", description: "This replaces the existing transcript and starts a new provider request.", action: start })
          else start()
        }
        else if (option.value === "export-txt" || option.value === "export-json") { exportFormat = option.value === "export-txt" ? "txt" : "json"; go("export-folder") }
        else if (["duplicate", "rename", "delete"].includes(String(option.value))) { editingKey = null; setMessage(String(option.value)); go("setting-input") }
        else go(runReturn)
      }}/></Show>

      <Show when={screen() === "export-folder"}><PathEntry title={`export ${exportFormat.toUpperCase()} · choose folder`} placeholder="folder path" extensions={[]} directoriesOnly initialValue={`${exportFolder}${sep}`} submit={(value) => {
        try {
          const folder = resolve(expandUserPath(value.trim()))
          if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error("Choose an existing folder for export.")
          exportFolder = folder; preferences.exportDirectory = folder; rememberPreferences(); go("export-name")
        } catch (reason) { fail(reason) }
      }}/></Show>
      <Show when={screen() === "export-name"}><box flexDirection="column" padding={1}><Header title={`export ${exportFormat.toUpperCase()} · filename`} subtitle={`Folder: ${exportFolder}`}/><text fg={muted}>Enter a filename and press Enter to export. Esc changes the folder.</text><input focused={contentFocused()} value={`${selectedRun()!.name.replace(/[\\/]/g, "-")}.${exportFormat}`} onSubmit={(submitted) => {
        try {
          const name = String(submitted).trim()
          if (!name || name === "." || name === ".." || /[\\/]/.test(name)) throw new Error("Enter a filename without folders.")
          const target = join(exportFolder, name), run = selectedRun()!, format = exportFormat
          const save = () => {
            try { const destination = library.exportRun(run.id, format, target); go("run"); setRunNotice(`Exported to ${destination}`); setNotification(`Exported to ${destination}`) } catch (reason) { fail(reason) }
          }
          if (existsSync(target)) setConfirmation({ title: "Replace existing file?", description: target, action: save })
          else save()
        } catch (reason) { fail(reason) }
      }}/><ErrorLine/></box></Show>

      <Show when={screen() === "appearance"}><Menu title="Appearance" subtitle="Nerd Font icons use your terminal font. Plain symbols work without a patched font." items={(preferencesVersion(), options([["Icon style", preferences.icons === "nerd" ? "Nerd Font" : "Plain symbols", "icons"], ["Back", "Settings", "back"]]))} select={(option) => { if (option.value === "icons") { preferences.icons = preferences.icons === "nerd" ? "plain" : "nerd"; rememberPreferences() } else go("settings") }}/></Show>
      <Show when={screen() === "settings"}><Menu title="Settings" subtitle="Defaults for new transcriptions" items={options([
        ["Transcription", `${settings.provider} / ${settings.model} · language and speaker labels`, "transcription"],
        ["Processing", "Chunks, concurrency, retries, and continuity", "processing"],
        ["Output", "Audio retention and subtitle cleanup", "output"],
        ["Appearance", "Nerd Font icons or plain symbols", "appearance"], ["Authentication", "System wallet and provider endpoints", "auth"],
        ["Save and return", "Persist these defaults", "done"],
      ])} select={(option) => {
        if (["transcription", "processing", "output"].includes(String(option.value))) { setSettingsGroup(String(option.value)); go("settings-group") }
        else editSetting(option.value as "appearance" | "auth" | "done")
      }}/></Show>
      <Show when={screen() === "settings-group"}><Menu title={`Settings · ${settingsGroup()}`} subtitle="Change defaults, then Save and return in Settings" items={(settingsVersion(), settingRows().filter((item) => {
        const groups: Record<string, string[]> = { transcription: ["provider", "model", "language", "diarize", "prompt"], processing: ["chunkSeconds", "chunkOverlapSeconds", "continuityChars", "chunkConcurrency", "maxUploadMb", "maxRetries", "initialRetrySeconds"], output: ["cleanup", "keepAudio", "keepChunks"] }
        return groups[settingsGroup()]!.includes(String(item.value))
      }))} select={(option) => editSetting(option.value as keyof Settings)}/></Show>
      <Show when={screen() === "setting-input"}><box flexDirection="column" padding={1}><Header title={editingKey ? `edit ${String(editingKey)}` : message()} subtitle={message() === "delete" ? `Type exactly: ${selectedRun()?.name}` : "Enter a value and press Enter"}/><input focused={contentFocused()} value={editingKey ? String((settings as any)[editingKey] ?? "") : ""} onSubmit={(submitted) => {
        try {
          const value = String(submitted)
          if (editingKey) return submitSetting(value)
          const action = message(), run = selectedRun()!
          if (action === "duplicate") setSelectedRun(library.duplicateRun(run.id, value))
          else if (action === "rename") setSelectedRun(library.updateRun(run.id, { name: value }))
          else if (action === "delete") { if (controller.isActive(run.id)) throw new Error("Pause the run before deleting it."); if (value !== run.name) throw new Error("Confirmation did not match the run name."); library.deleteRun(run.id); setSelectedRun(null); setSourcesVersion((v) => v + 1); return go("library") }
          setSourcesVersion((v) => v + 1); go("run")
        } catch (reason) { fail(reason) }
      }}/><ErrorLine/></box></Show>

      <Show when={screen() === "compare-mode"}><Menu title="compare transcripts" items={options([["Library runs", "Choose a source, then exactly two completed runs", "library"], ["External TXT files", "Enter two text-file paths", "external"]])} select={(option) => go(option.value === "library" ? "compare-source" : "compare-external-a")}/></Show>
      <Show when={screen() === "compare-source"}><Menu title="compare · source" items={sources().filter((source) => source.kind !== "playlist" && library.listRunsForSource(source.id).filter((run) => run.status === "completed").length >= 2).map((source) => ({ name: source.title, description: `${library.listRunsForSource(source.id).filter((run) => run.status === "completed").length} completed runs`, value: source.id }))} select={(option) => { setSelectedSource(library.requireSource(String(option.value))); go("compare-runs") }}/></Show>
      <Show when={screen() === "compare-runs"}><Menu title={`compare · ${selectedSource()?.title || "runs"}`} subtitle={`Select two runs (${compareSelected().length}/2 selected)`} items={(selectedSource() ? library.listRunsForSource(selectedSource()!.id) : []).filter((run) => run.status === "completed").map((run) => ({ name: `${compareSelected().includes(run.id) ? "✓ " : ""}${run.name}`, description: `${run.provider}/${run.model}`, value: run.id }))} select={(option) => {
        const runId = String(option.value), current = compareSelected(), next = current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId]
        setCompareSelected(next)
        if (next.length === 2) { const [a, b] = next.map((id) => library.requireRun(id)); void compare(join(a!.artifactDir, "transcript.txt"), join(b!.artifactDir, "transcript.txt")) }
      }}/></Show>
      <Show when={screen() === "compare-external-a"}><Menu title="compare · transcript A" items={fileItems(textChoices(), "Enter a text file not listed below")} select={(option) => { if (option.value === "__manual__") go("compare-external-a-input"); else { compareA = String(option.value); go("compare-external-b") } }}/></Show>
      <Show when={screen() === "compare-external-a-input"}><PathEntry title="compare · transcript A · exact path" placeholder="first.txt" extensions={TEXT_EXTENSIONS} submit={(value) => { compareA = value; go("compare-external-b") }}/></Show>
      <Show when={screen() === "compare-external-b"}><Menu title="compare · transcript B" items={fileItems(textChoices().filter((choice) => choice.path !== compareA), "Enter a text file not listed below")} select={(option) => { if (option.value === "__manual__") go("compare-external-b-input"); else { compareB = String(option.value); void compare(compareA, compareB) } }}/></Show>
      <Show when={screen() === "compare-external-b-input"}><PathEntry title="compare · transcript B · exact path" placeholder="second.txt" extensions={TEXT_EXTENSIONS} submit={(value) => { compareB = value; void compare(compareA, compareB) }}/></Show>
      <Show when={screen() === "compare-result"}><Viewer/></Show>
      <Show when={screen() === "help"}><box flexDirection="column" padding={1}><Header title="help"/><scrollbox focused={contentFocused()} border padding={1} flexGrow={1}><text selectable>{`transcribe is a central, resumable transcription library.\n\nQuick Transcribe\n  Choose a local media file and start immediately with remembered settings.\n  The completed transcript opens directly in the viewer and remains in the library.\n\nMenus\n  Type  fuzzy-find the active menu\n  ↑/↓  move\n  Enter choose\n  Esc   clear list search, then go back\n  Ctrl-U clear search\n  Ctrl-C pause all active jobs (quit when idle)\n  Ctrl-Q quit safely\n  Ctrl-P action palette\n  F6 / Shift-F6 switch panes\n  F1 help\n\nJobs\n  Start multiple runs without a concurrency limit. Each run keeps its chunk concurrency and retries. Browse the app while work continues; Jobs shows each run and pause controls. Quitting pauses runs before closing.\n\nPickers\n  Enter opens folders or selects files; export uses Use this folder then a filename. Ctrl-H Home, Ctrl-D Downloads, Ctrl-B parent, Tab completes.\n\nAppearance\n  Settings > Appearance toggles Nerd Font icons and plain symbols.\n\nViewer\n  Type        search transcript\n  Enter       next match\n  Shift-Enter previous match\n  Ctrl-Y      copy entire transcript\n  Ctrl-E      open transcript in $EDITOR\n\nCredentials\n  Use Authentication to save keys in the system wallet. Environment variables override saved keys. Microsoft also requires a Speech endpoint.\n\nStorage\n  Config: ${configPath()}\n  Library: ${stateRoot()}\n\nCLI\n  transcribe run INPUT --name NAME\n  transcribe resume RUN\n  transcribe restart RUN\n  transcribe compare LEFT RIGHT\n  transcribe export RUN --format txt|json --output PATH\n  transcribe doctor`}</text></scrollbox></box></Show>
      <Show when={screen() === "message"}><box flexDirection="column" padding={1}><Header title="Message"/><ErrorLine/><text>{message()}</text><text fg={muted}>Press Esc to go back.</text></box></Show>
        </box>
      </box>
      <box height={3} flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="column"><text fg={notification().includes("failed") ? red : green} truncate>{busyJobs().length ? aggregateProgress() + " · Ctrl-C pauses all" : notification() || "Ready"}</text><text fg={muted} truncate>{screen().includes("location") || screen() === "export-folder" ? "Enter select · Tab complete · ^H Home · ^D Downloads · ^B parent · Esc back" : "↑↓ move · Enter choose · F6 pane · ^P actions · F1 help · Esc back · ^Q quit"}</text><Show when={shuttingDown()}><text fg={theme.amber}>Waiting for active requests to settle…</text></Show></box>
      <Show when={palette()}><CommandPalette/></Show>
      <Show when={confirmation()}><Confirmation/></Show>
    </box>
  }
  return App
}

export async function runTui(library: Library): Promise<void> {
  const App = createTranscribeApp(library)
  await new Promise<void>((resolve, reject) => {
    void render(() => <App />, { exitOnCtrlC: false, onDestroy: resolve }).catch(reject)
  })
}
