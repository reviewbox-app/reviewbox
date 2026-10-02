import type { ThemeRegistration } from "shiki"
import storm from "./themes/tokyo-night-storm.json"
import light from "./themes/tokyo-night-light.json"
import type { PseudoTokenKind } from "./pseudocode"

export function editorSurfaceColors(dark: boolean) {
  const background = dark ? "#222222" : "#ffffff"
  const foreground = dark ? "#ffffff" : "#181818"
  const muted = dark ? "#ffffff80" : "#18181880"
  const faint = dark ? "#ffffff1a" : "#18181814"
  const selection = dark ? "#2b7fff52" : "#2b7fff3d"
  return {
    "editor.background": background,
    "editor.foreground": foreground,
    "editorGutter.background": background,
    "editorLineNumber.foreground": muted,
    "editorLineNumber.activeForeground": foreground,
    "editor.lineHighlightBackground": "#00000000",
    "editor.lineHighlightBorder": faint,
    "editor.selectionBackground": selection,
    "editor.inactiveSelectionBackground": selection,
    "editorWidget.background": background,
    "editorWidget.border": faint,
    "editorStickyScroll.shadow": dark ? "#00000026" : "#00000014",
    "scrollbar.shadow": dark ? "#00000026" : "#00000014",
    "editorIndentGuide.background1": "#00000000",
    "scrollbarSlider.background": faint,
    "diffEditor.insertedLineBackground": dark ? "#4ade8012" : "#16a34a12",
    "diffEditor.insertedTextBackground": dark ? "#4ade8029" : "#16a34a24",
    "diffEditor.removedLineBackground": dark ? "#ff646712" : "#e7000b0d",
    "diffEditor.removedTextBackground": dark ? "#ff646729" : "#e7000b1f",
    "diffEditorGutter.insertedLineBackground": dark ? "#4ade8029" : "#16a34a24",
    "diffEditorGutter.removedLineBackground": dark ? "#ff646729" : "#e7000b1f",
    "diffEditor.unchangedRegionBackground": faint,
    "diffEditor.unchangedRegionForeground": muted,
    "diffEditor.border": faint,
  }
}

export function pseudoPalette(theme: string): Record<PseudoTokenKind, string> {
  const dark = theme.endsWith("dark")
  const tokyo = theme.startsWith("tokyo-night")
  return {
    plain: dark ? "#a9b1d6" : "#343b59",
    comment: dark ? "#737c9e" : "#747c9c",
    string: tokyo
      ? dark
        ? "#9ece6a"
        : "#485e30"
      : dark
        ? "#6ee7b7"
        : "#0b7a55",
    number: tokyo
      ? dark
        ? "#ff9e64"
        : "#965027"
      : dark
        ? "#fdba74"
        : "#c2410c",
    boolean: dark ? "#ff9e64" : "#965027",
    "keyword.control": tokyo
      ? dark
        ? "#bb9af7"
        : "#5a4a78"
      : dark
        ? "#8fb0ff"
        : "#1447e6",
    "keyword.action": dark ? "#7dcfff" : "#0f4b6e",
    operator: dark ? "#89ddff" : "#006c86",
    punctuation: dark ? "#9aa5ce" : "#565a6e",
    function: dark ? "#7aa2f7" : "#2959aa",
    parameter: dark ? "#e0af68" : "#8f5e15",
    type: dark ? "#2ac3de" : "#006c86",
    property: dark ? "#73daca" : "#33635c",
    variable: dark ? "#c0caf5" : "#343b59",
    constant: dark ? "#ff9e64" : "#965027",
  }
}

export const codeThemes: ThemeRegistration[] = [true, false].flatMap((dark) => {
  const mode = dark ? "dark" : "light"
  const theme = dark ? storm : light
  const tokyoName = `tokyo-night-${mode}`
  const reviewboxName = `reviewbox-${mode}`
  const common = { type: mode, colors: editorSurfaceColors(dark) } as const
  const pseudoRules = (name: string) =>
    Object.entries(pseudoPalette(name)).map(([kind, foreground]) => ({
      scope: `pseudo.${kind}`,
      settings: { foreground },
    }))
  return [
    {
      ...common,
      name: tokyoName,
      tokenColors: [...theme.tokenColors, ...pseudoRules(tokyoName)],
    },
    {
      ...common,
      name: reviewboxName,
      tokenColors: [
        {
          scope: ["keyword", "storage"],
          settings: { foreground: dark ? "#8fb0ff" : "#1447e6" },
        },
        {
          scope: "string",
          settings: { foreground: dark ? "#6ee7b7" : "#0b7a55" },
        },
        {
          scope: "comment",
          settings: { foreground: dark ? "#888888" : "#707070" },
        },
        {
          scope: ["entity.name.type", "support.type", "entity.name.class"],
          settings: { foreground: dark ? "#fcd34d" : "#9a5b00" },
        },
        {
          scope: ["constant", "constant.numeric"],
          settings: { foreground: dark ? "#fdba74" : "#c2410c" },
        },
        ...pseudoRules(reviewboxName),
      ],
    },
  ]
})

/** Monaco semantic-token legends use these names, in addition to TextMate scopes. */
export function semanticThemeRules(theme: string) {
  const palette = pseudoPalette(theme)
  const rules = Object.entries({
    keyword: "keyword.control",
    string: "string",
    comment: "comment",
    number: "number",
    decorator: "function",
    class: "type",
    interface: "type",
    type: "type",
    enum: "type",
    struct: "type",
    function: "function",
    method: "function",
    parameter: "parameter",
    property: "property",
    variable: "variable",
    enumMember: "constant",
    namespace: "type",
    typeParameter: "type",
    event: "function",
    macro: "function",
    modifier: "keyword.control",
    regexp: "string",
    operator: "operator",
  } as const).map(([token, kind]) => ({
    token,
    foreground: palette[kind].slice(1),
  }))
  if (theme.startsWith("tokyo-night")) {
    const original = theme.endsWith("dark") ? storm : light
    for (const [token, value] of Object.entries(original.semanticTokenColors)) {
      rules.push({ token, foreground: value.foreground.slice(1) })
    }
  }
  return rules
}
