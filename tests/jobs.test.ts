import { describe, expect, test } from "bun:test"
import { JobController } from "../src/jobs"
import { normalizeSettings } from "../src/config"
import type { RunRecord } from "../src/types"

const record = (id: string): RunRecord => ({ id, sourceId: "source", name: id, status: "draft", provider: "microsoft", model: "MAI-Transcribe-2", settings: normalizeSettings({ provider: "microsoft" }), artifactDir: "/tmp/unused", error: null, createdAt: "", updatedAt: "", completedAt: null })
function harness() {
  const tasks = new Map<string, { finish: (run: RunRecord) => void, fail: (error: Error) => void, paused: boolean }>()
  const controller = new JobController((notify) => {
    let current = ""
    const run = (id: string) => {
      current = id
      notify({ type: "chunk", message: id, completed: 0, total: 2 })
      return new Promise<RunRecord>((finish, fail) => tasks.set(id, { finish, fail, paused: false }))
    }
    return { run, restart: run, requestPause: () => { tasks.get(current)!.paused = true } }
  })
  return { controller, tasks }
}

describe("concurrent jobs", () => {
  test("starts every run immediately, isolates state, and completes out of order", async () => {
    const { controller, tasks } = harness()
    const input = record("a")
    const first = controller.start(input), second = controller.start(record("b")), third = controller.start(record("c"))
    input.settings.language = "he"
    expect(tasks.size).toBe(3)
    expect(controller.entries.get("a")!.run.settings.language).toBe("en")
    expect(controller.entries.get("b")!.event.message).toBe("b")
    await expect(controller.start(record("a"))).rejects.toThrow("already active")
    tasks.get("b")!.finish({ ...record("b"), status: "completed" })
    await second
    expect(controller.isActive("a")).toBe(true)
    expect(controller.isActive("b")).toBe(false)
    tasks.get("c")!.fail(new Error("provider failed"))
    await expect(third).rejects.toThrow("provider failed")
    expect(controller.entries.get("c")!.run.status).toBe("failed")
    expect(controller.isActive("a")).toBe(true)
    controller.pause("a")
    expect(tasks.get("a")!.paused).toBe(true)
    tasks.get("a")!.finish({ ...record("a"), status: "paused" }); await first
    expect(controller.active).toHaveLength(0)
  })

  test("shutdown pauses and waits for all runs before closing", async () => {
    const { controller, tasks } = harness()
    const a = controller.start(record("a")), b = controller.start(record("b"))
    let closed = false
    const shutdown = controller.shutdown().then(() => { closed = true })
    expect(tasks.get("a")!.paused).toBe(true)
    expect(tasks.get("b")!.paused).toBe(true)
    await expect(controller.start(record("c"))).rejects.toThrow("shutting down")
    tasks.get("a")!.finish({ ...record("a"), status: "paused" }); await a
    expect(closed).toBe(false)
    tasks.get("b")!.finish({ ...record("b"), status: "paused" }); await b; await shutdown
    expect(closed).toBe(true)
  })
})
