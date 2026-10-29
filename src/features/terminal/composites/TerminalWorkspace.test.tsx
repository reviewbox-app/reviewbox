import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TerminalWorkspace } from "./TerminalWorkspace"

test("terminal hydration snapshot matches the export even in the native runtime", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri")
  try {
    Object.defineProperty(globalThis, "isTauri", {
      value: false,
      configurable: true,
    })
    const exported = renderToStaticMarkup(<TerminalWorkspace visible={false} />)
    Object.defineProperty(globalThis, "isTauri", {
      value: true,
      configurable: true,
    })
    const native = renderToStaticMarkup(<TerminalWorkspace visible={false} />)
    expect(native).toBe(exported)
    expect(native).toContain("Terminals are available in the desktop app.")
    expect(native).not.toContain("Run commands in this project")
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "isTauri", descriptor)
    else Reflect.deleteProperty(globalThis, "isTauri")
  }
})
