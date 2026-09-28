import type * as Monaco from "monaco-editor/editor/editor.api"
import type { editor } from "monaco-editor"

import { ensureCodeLanguage, highlightCode } from "@/lib/code/highlighter"

export function waitForProbe<T>(
  operation: PromiseLike<T>,
  label: string,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted()

  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
    }

    function onAbort() {
      cleanup()
      reject(signal.reason)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`${label} : aucune réponse après 15 secondes.`))
    }, 15_000)

    signal.addEventListener("abort", onAbort, { once: true })
    Promise.resolve(operation).then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

export async function probeLanguageHighlighting(
  monaco: typeof Monaco,
  codeEditor: editor.IStandaloneCodeEditor,
  signal: AbortSignal
): Promise<string[]> {
  const results: string[] = []
  const originalModel = codeEditor.getModel()
  const fixtures = [
    [
      "tsx",
      "const Label = ({value}: {value: string}) => <button title={value}>{value}</button>",
    ],
    ["json", '{"review":true,"count":2}'],
    ["css", ".review{color:red;margin:0}"],
    ["html", "<html><body><div>ReviewBox</div></body></html>"],
  ] as const
  for (const [language, value] of fixtures) {
    signal.throwIfAborted()
    await waitForProbe(
      ensureCodeLanguage(language),
      `Grammaire ${language}`,
      signal
    )
    const lines = await waitForProbe(
      highlightCode(value, language, "tokyo-night-dark"),
      `Coloration ${language}`,
      signal
    )
    if (
      lines
        .flat()
        .map((token) => token.content)
        .join("") !== value ||
      new Set(lines.flat().map((token) => token.color)).size < 3
    ) {
      throw new Error(
        `La grammaire ${language} ne distingue pas les éléments attendus.`
      )
    }
    results.push(`${language.toUpperCase()} : coloration TextMate vérifiée`)
  }
  if (
    codeEditor.getModel() !== originalModel ||
    !monaco.languages.getLanguages().some((language) => language.id === "tsx")
  ) {
    throw new Error("La vérification ne doit pas remplacer le modèle actif.")
  }
  return results
}

export async function probeDiff(
  diffEditor: editor.IStandaloneDiffEditor,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  if (diffEditor.getLineChanges()?.length) return "Diff : changements calculés"

  let check = () => {}
  const subscription = diffEditor.onDidUpdateDiff(() => check())
  try {
    return await waitForProbe(
      new Promise<string>((resolve) => {
        check = () => {
          if (diffEditor.getLineChanges()?.length)
            resolve("Diff : changements calculés")
        }
        check()
      }),
      "Calcul du diff",
      signal
    )
  } finally {
    subscription.dispose()
  }
}
