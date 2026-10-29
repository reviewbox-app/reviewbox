import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CodeFileHeader } from "./CodeFileHeader"

test("shared source header keeps directory and basename contrast in a fixed compact height", () => {
  const header = renderToStaticMarkup(
    <CodeFileHeader path=".reviewbox/.gitignore">
      <button>Preview</button>
    </CodeFileHeader>
  )
  expect(header).toContain("height:36px")
  expect(header).toContain('class="opacity-50">.reviewbox/</span>')
  expect(header).toContain('class="font-medium opacity-100">.gitignore</span>')
  expect(header).toContain("Preview")
})
test("root files and renamed sources retain their exact accessible path", () => {
  const header = renderToStaticMarkup(
    <CodeFileHeader path="new.ts" previousPath="old.ts" style={{ top: 48 }} />
  )
  expect(header).toContain("old.ts → new.ts")
  expect(header).toContain("top:48px;height:36px")
  expect(header).not.toContain('class="opacity-50"')
})
