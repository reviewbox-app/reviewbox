import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { bundledLanguages, type BundledLanguage } from "shiki/langs"
import type * as Monaco from "monaco-editor/editor/editor.api"
import { shikiToMonaco, textmateThemeToMonacoTheme } from "@shikijs/monaco"
import { codeThemes, semanticThemeRules } from "./themes"
import { codeLanguages, resolveLanguageId } from "./languages"
import { tokenizePseudoLine, type PseudoState } from "./pseudocode"

let highlighter: Promise<HighlighterCore> | undefined
const languages = new Map<string, Promise<void>>()
let refreshMonaco: (() => void) | undefined
let restoreMonacoTheme: (() => void) | undefined

export function getCodeHighlighter() {
  highlighter ??= createHighlighterCore({
    themes: codeThemes,
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }).catch((error: unknown) => {
    highlighter = undefined
    throw error
  })
  return highlighter
}

export async function ensureCodeLanguage(input: string | undefined) {
  const id = resolveLanguageId(input).id
  if (id === "plaintext" || id === "reviewbox-pseudocode") return id
  let loading = languages.get(id)
  if (!loading) {
    loading = (async () => {
      const engine = await getCodeHighlighter()
      await engine.loadLanguage(bundledLanguages[id as BundledLanguage])
      refreshMonaco?.()
    })().catch((error: unknown) => {
      languages.delete(id)
      throw error
    })
    languages.set(id, loading)
  }
  await loading
  return id
}

export async function highlightCode(
  source: string,
  input: string | undefined,
  theme: string
) {
  const language = await ensureCodeLanguage(input)
  const engine = await getCodeHighlighter()
  const result = engine.codeToTokens(source, {
    lang: language === "plaintext" ? "text" : language,
    theme,
    tokenizeMaxLineLength: 20_000,
    tokenizeTimeLimit: 2_000,
  }).tokens
  // TextMate has one active theme. Static snippets must not change Monaco's palette.
  restoreMonacoTheme?.()
  return result
}

class PseudocodeState implements Monaco.languages.IState {
  constructor(readonly value: PseudoState = { blockComment: false }) {}
  clone() {
    return new PseudocodeState({ ...this.value })
  }
  equals(other: Monaco.languages.IState) {
    return (
      other instanceof PseudocodeState &&
      other.value.blockComment === this.value.blockComment
    )
  }
}

export function registerPseudoLanguage(monaco: typeof Monaco) {
  const id = "reviewbox-pseudocode"
  if (monaco.languages.getLanguages().some((item) => item.id === id)) return
  monaco.languages.register({ id })
  monaco.languages.setLanguageConfiguration(id, {
    wordPattern: /[$\w]+/g,
    comments: { lineComment: "#", blockComment: ["/*", "*/"] },
    brackets: [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ],
  })
  monaco.languages.setTokensProvider(id, {
    getInitialState: () => new PseudocodeState(),
    tokenize(line, state) {
      const result = tokenizePseudoLine(
        line,
        state instanceof PseudocodeState ? state.value : undefined
      )
      return {
        endState: new PseudocodeState(result.state),
        tokens: result.tokens.map((token) => ({
          startIndex: token.start,
          scopes: `pseudo.${token.kind}`,
        })),
      }
    },
  })
}

/** Local lazy TextMate grammars; Monaco instances and models remain owned by React. */
export async function initializeCodeHighlighting(monaco: typeof Monaco) {
  if (refreshMonaco) return
  const engine = await getCodeHighlighter()
  const originalSetTheme = monaco.editor.setTheme.bind(monaco.editor)
  const originalCreate = monaco.editor.create.bind(monaco.editor)
  let selectedTheme = "tokyo-night-dark"
  refreshMonaco = () => {
    const selected = selectedTheme
    // The official adapter wraps these methods. Restore them before refreshing
    // newly loaded grammars so wrappers never accumulate across file changes.
    monaco.editor.setTheme = originalSetTheme
    monaco.editor.create = originalCreate
    shikiToMonaco(engine, monaco, {
      tokenizeMaxLineLength: 20_000,
      tokenizeTimeLimit: 2_000,
    })
    for (const name of engine.getLoadedThemes()) {
      // The adapter references Monaco's former core type path; its runtime shape is unchanged.
      const theme = textmateThemeToMonacoTheme(
        engine.getTheme(name)
      ) as Monaco.editor.IStandaloneThemeData
      monaco.editor.defineTheme(name, {
        ...theme,
        rules: [...theme.rules, ...semanticThemeRules(name)],
      })
    }
    const adaptedSetTheme = monaco.editor.setTheme.bind(monaco.editor)
    monaco.editor.setTheme = (name) => {
      selectedTheme = name
      adaptedSetTheme(name)
    }
    monaco.editor.setTheme(selected)
  }
  restoreMonacoTheme = () => monaco.editor.setTheme(selectedTheme)
  const registered = new Set(
    monaco.languages.getLanguages().map((item) => item.id)
  )
  for (const language of codeLanguages) {
    if (!registered.has(language.id))
      monaco.languages.register({
        id: language.id,
        extensions: language.extensions.map((extension) => `.${extension}`),
        aliases: [language.name],
      })
    monaco.languages.onLanguage(language.id, () => {
      // Loading failure keeps the readable built-in/plain syntax; opening code never fails.
      void ensureCodeLanguage(language.id).catch(() => {})
    })
  }
  refreshMonaco()
  registerPseudoLanguage(monaco)
}
