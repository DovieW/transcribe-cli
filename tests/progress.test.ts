import { expect, test } from "bun:test"
import { durationLabel, progressBar, runProgress } from "../src/progress"
import type { ChunkRecord } from "../src/types"
const chunk = (durationSeconds: number, status: ChunkRecord["status"]) => ({ durationSeconds, status }) as ChunkRecord

test("ETA weights audio duration and excludes previously completed audio on resume", () => {
  const chunks = [chunk(200, "completed"), chunk(200, "completed"), chunk(100, "active"), chunk(100, "pending")]
  expect(runProgress(chunks, 60, 200)).toEqual({ completed: 2, total: 4, active: 1, fraction: 2 / 3, eta: 60 })
  expect(runProgress(chunks, 60, 400).eta).toBeNull()
  expect(runProgress([chunk(100, "completed")], 60).eta).toBe(0)
  expect(runProgress([], 60).eta).toBeNull()
})
test("progress uses solid blocks and readable durations", () => {
  expect(progressBar(0.5, 4)).toBe("▕██░░▏ 50%")
  expect(durationLabel(125)).toBe("2m 5s")
  expect(durationLabel(3660)).toBe("1h 1m")
})
