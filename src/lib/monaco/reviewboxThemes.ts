import type * as Monaco from "monaco-editor"

/** Hex values of the `code/*`, `diff/*` and surface tokens (RB / Colors). */
const palettes = {
  dark: {
    background: "#222222",
    foreground: "#ffffff",
    muted: "#ffffff80",
    faint: "#ffffff1a",
    keyword: "8fb0ff",
    string: "6ee7b7",
    comment: "ffffff6b",
    type: "fcd34d",
    number: "fdba74",
    addedBg: "#4ade8012",
    addedGutter: "#4ade8029",
    removedBg: "#ff646712",
    removedGutter: "#ff646729",
    selection: "#2b7fff52",
  },
  light: {
    background: "#ffffff",
    foreground: "#181818",
    muted: "#18181880",
    faint: "#18181814",
    keyword: "1447e6",
    string: "0b7a55",
    comment: "1818186b",
    type: "9a5b00",
    number: "c2410c",
    addedBg: "#16a34a12",
    addedGutter: "#16a34a24",
    removedBg: "#e7000b0d",
    removedGutter: "#e7000b1f",
    selection: "#2b7fff3d",
  },
}

export function reviewboxTheme(dark: boolean | undefined) {
  return dark === false ? "reviewbox-light" : "reviewbox-dark"
}

export function defineReviewboxThemes(monaco: typeof Monaco) {
  for (const [name, c] of Object.entries(palettes)) {
    monaco.editor.defineTheme(`reviewbox-${name}`, {
      base: name === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: [
        { token: "", foreground: c.foreground.slice(1, 7) },
        { token: "keyword", foreground: c.keyword },
        { token: "string", foreground: c.string },
        { token: "comment", foreground: c.comment },
        { token: "attribute", foreground: c.comment },
        { token: "number", foreground: c.number },
        { token: "type", foreground: c.type },
        { token: "type.identifier", foreground: c.type },
      ],
      colors: {
        "editor.background": c.background,
        "editor.foreground": c.foreground,
        "editorGutter.background": c.background,
        "editorLineNumber.foreground": c.muted,
        "editorLineNumber.activeForeground": c.foreground,
        "editor.lineHighlightBackground": "#00000000",
        "editor.lineHighlightBorder": c.faint,
        "editor.selectionBackground": c.selection,
        "editor.inactiveSelectionBackground": c.selection,
        "editorWidget.background": c.background,
        "editorWidget.border": c.faint,
        "editorIndentGuide.background1": "#00000000",
        "scrollbarSlider.background": c.faint,
        "diffEditor.insertedLineBackground": c.addedBg,
        "diffEditor.insertedTextBackground": c.addedGutter,
        "diffEditor.removedLineBackground": c.removedBg,
        "diffEditor.removedTextBackground": c.removedGutter,
        "diffEditorGutter.insertedLineBackground": c.addedGutter,
        "diffEditorGutter.removedLineBackground": c.removedGutter,
        "diffEditor.unchangedRegionBackground": c.faint,
        "diffEditor.unchangedRegionForeground": c.muted,
        "diffEditor.border": c.faint,
      },
    })
  }
}
