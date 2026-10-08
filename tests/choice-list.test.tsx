import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ChoiceList } from "../src/choice-list"

test("mouse scrolling and clicking activate the visible row after scrolling", async () => {
  let chosen = ""
  const items = Array.from({ length: 30 }, (_, i) => ({ name: `Item ${String(i).padStart(2, "0")}`, description: "", value: String(i) }))
  const setup = await testRender(() => <ChoiceList width={30} height={8} options={items} showDescription={false} focused onSelect={(_, option) => { chosen = String(option?.value) }}/>, { width: 30, height: 8, exitOnCtrlC: false })
  try {
    await setup.flush()
    for (let i = 0; i < 10; i++) await setup.mockMouse.scroll(4, 3, "down")
    await setup.flush()
    const visible = setup.captureCharFrame().split("\n")[0]!
    const name = visible.match(/Item (\d+)/)![1]!
    expect(Number(name)).toBeGreaterThan(0)
    await setup.mockMouse.click(4, 0); await setup.flush()
    expect(chosen).toBe(String(Number(name)))
  } finally { setup.renderer.destroy() }
})
