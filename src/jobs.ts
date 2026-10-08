import type { JobEvent, JobRunner } from "./job"
import type { RunRecord } from "./types"

export type Runner = Pick<JobRunner, "run" | "restart" | "requestPause">
export interface JobEntry {
  run: RunRecord
  event: JobEvent
  startedAt: number
  endedAt?: number
  busy: boolean
  pausing: boolean
  runner: Runner
  settled: Promise<RunRecord>
}

/** Owns job lifetime independently of the screen or selected library item. */
export class JobController {
  readonly entries = new Map<string, JobEntry>()
  closing = false
  constructor(private factory: (notify: (event: JobEvent) => void) => Runner, private changed: () => void = () => {}) {}
  isActive(id: string): boolean { return this.entries.get(id)?.busy === true }
  get active(): JobEntry[] { return [...this.entries.values()].filter((entry) => entry.busy) }
  start(run: RunRecord, restart = false): Promise<RunRecord> {
    if (this.closing) return Promise.reject(new Error("The app is shutting down."))
    if (this.isActive(run.id)) return Promise.reject(new Error("This run is already active."))
    const runner = this.factory((event) => {
      const entry = this.entries.get(run.id)
      if (entry) { entry.event = event; this.changed() }
    })
    const entry: JobEntry = { run: structuredClone(run), event: { type: "status", message: "Starting…" }, startedAt: Date.now(), busy: true, pausing: false, runner, settled: Promise.resolve(run) }
    this.entries.set(run.id, entry)
    let work: Promise<RunRecord>
    try { work = restart ? runner.restart(run.id) : runner.run(run.id) } catch (reason) { work = Promise.reject(reason) }
    entry.settled = work.then((result) => {
      entry.run = result
      return result
    }).catch((reason) => {
      entry.run = { ...entry.run, status: entry.pausing ? "paused" : "failed", error: String(reason instanceof Error ? reason.message : reason) }
      entry.event = { type: "error", message: entry.run.error! }
      throw reason
    }).finally(() => { entry.busy = false; entry.endedAt = Date.now(); this.changed() })
    this.changed()
    return entry.settled
  }
  pause(id: string): void {
    const entry = this.entries.get(id)
    if (!entry?.busy) return
    entry.pausing = true
    entry.event = { ...entry.event, message: "Pausing after current work finishes…" }
    entry.runner.requestPause()
    this.changed()
  }
  pauseAll(): void { for (const entry of this.active) this.pause(entry.run.id) }
  async shutdown(): Promise<void> {
    this.closing = true
    this.pauseAll()
    await Promise.allSettled(this.active.map((entry) => entry.settled))
  }
}
