import type { SelectRenderable } from "@opentui/core"
import type { SelectProps } from "@opentui/solid"
import { splitProps } from "solid-js"

/** OpenTUI's Select provides keyboard navigation; add pointer activation and scrolling. */
export function ChoiceList(props: SelectProps & { onActivate?: () => void }) {
  const [local, other] = splitProps(props, ["ref", "onActivate"])
  let list: SelectRenderable | undefined
  return <select {...other} ref={(value) => { list = value; if (typeof local.ref === "function") local.ref(value) }} onMouseDown={(event) => {
    if (!list || event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); local.onActivate?.()
    // Select centers the selected row in its viewport (OpenTUI 0.5.1).
    const rowHeight = (props.showDescription === false ? 1 : 2) + (props.itemSpacing || 0)
    const visible = Math.max(1, Math.floor(list.height / rowHeight))
    const offset = Math.max(0, Math.min(list.getSelectedIndex() - Math.floor(visible / 2), list.options.length - visible))
    const row = Math.floor((event.y - list.screenY) / rowHeight)
    const index = offset + row
    if (row < 0 || index >= list.options.length) return
    list.setSelectedIndex(index)
    list.selectCurrent()
  }} onMouseScroll={(event) => {
    if (!list || !event.scroll) return
    event.preventDefault(); event.stopPropagation(); local.onActivate?.()
    const amount = Math.max(1, Math.round(event.scroll.delta))
    if (event.scroll.direction === "up") list.moveUp(amount)
    if (event.scroll.direction === "down") list.moveDown(amount)
  }}/>
}
