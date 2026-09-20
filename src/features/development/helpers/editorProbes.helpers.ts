import type * as Monaco from "monaco-editor"
import type { editor } from "monaco-editor"

let probeSequence = 0

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

async function waitForFormatting(
  action: editor.IEditorAction,
  language: string,
  signal: AbortSignal
): Promise<void> {
  if (action.isSupported()) return

  let interval: ReturnType<typeof setInterval> | undefined
  try {
    await waitForProbe(
      new Promise<void>((resolve) => {
        interval = setInterval(() => {
          if (action.isSupported()) resolve()
        }, 25)
      }),
      `Chargement du formateur ${language}`,
      signal
    )
  } finally {
    clearInterval(interval)
  }
}

export async function probeLanguageWorkers(
  monaco: typeof Monaco,
  codeEditor: editor.IStandaloneCodeEditor,
  signal: AbortSignal
): Promise<string[]> {
  signal.throwIfAborted()
  const originalModel = codeEditor.getModel()
  const results: string[] = []
  const models: editor.ITextModel[] = []
  let editorDisposed = false
  const disposal = codeEditor.onDidDispose(() => {
    editorDisposed = true
  })

  try {
    const tsModel = monaco.editor.createModel(
      'const reviewCount: number = "invalid";',
      "typescript",
      monaco.Uri.parse(
        `inmemory://reviewbox-validation/${++probeSequence}/probe.ts`
      )
    )
    models.push(tsModel)
    const getWorker = await waitForProbe(
      monaco.typescript.getTypeScriptWorker(),
      "Chargement TypeScript",
      signal
    )
    const worker = await waitForProbe(
      getWorker(tsModel.uri),
      "Worker TypeScript",
      signal
    )
    const diagnostics = await waitForProbe(
      worker.getSemanticDiagnostics(tsModel.uri.toString()),
      "Diagnostic TypeScript",
      signal
    )
    if (!diagnostics.some((diagnostic) => diagnostic.code === 2322)) {
      throw new Error(
        "Le worker TypeScript ne retourne pas le diagnostic attendu."
      )
    }
    results.push("TypeScript : diagnostic 2322 reçu")

    const fixtures = [
      ["json", '{"review":true,"count":2}'],
      ["css", ".review{color:red;margin:0}"],
      ["html", "<html><body><div>ReviewBox</div></body></html>"],
    ] as const

    for (const [language, value] of fixtures) {
      signal.throwIfAborted()
      if (editorDisposed)
        throw new Error("L’éditeur a été démonté pendant la vérification.")
      const model = monaco.editor.createModel(value, language)
      models.push(model)
      codeEditor.setModel(model)
      const action = codeEditor.getAction("editor.action.formatDocument")
      if (!action) throw new Error(`Formatage ${language} indisponible`)

      // Language services register asynchronously after their first model appears.
      await waitForFormatting(action, language, signal)
      await waitForProbe(action.run(), `Formatage ${language}`, signal)
      signal.throwIfAborted()
      if (model.getValue() === value || !model.getValue().includes("\n")) {
        throw new Error(`Le worker ${language} n’a pas formaté le document.`)
      }
      results.push(`${language.toUpperCase()} : document formaté`)
    }
  } finally {
    disposal.dispose()
    if (!editorDisposed) {
      codeEditor.setModel(originalModel?.isDisposed() ? null : originalModel)
    } else {
      // The React wrapper can only dispose the temporary model active at unmount.
      originalModel?.dispose()
    }
    models.forEach((model) => model.dispose())
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
