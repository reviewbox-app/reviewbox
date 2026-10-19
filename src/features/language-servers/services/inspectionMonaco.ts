import type * as M from "monaco-editor/editor/editor.api"
import type * as L from "vscode-languageserver-protocol"
import type { LiveLanguageSession } from "@/lib/desktop/contracts.generated"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import { liveCommands } from "./liveLanguage.commands"

export type InspectionDocument = { repositoryId: string; path: string }
export type InspectionTarget = {
  sessionId: string
  uri: string
  range: L.Range
}
type Binding = {
  model: M.editor.ITextModel
  document: InspectionDocument
  ready?: Promise<LiveLanguageSession>
  session?: LiveLanguageSession
  requests: Set<string>
  alive: boolean
  version: number
  syncing: Promise<void>
  targets: Set<M.editor.ITextModel>
  open: (target: InspectionTarget) => void
  error: (message: string) => void
}
const bindings = new Map<string, Binding>()
const installed = new WeakSet<typeof M>()
const range = (r: L.Range): M.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
})
async function request<T>(
  b: Binding,
  method: string,
  params: object,
  token?: M.CancellationToken
): Promise<T | undefined> {
  if (!b.alive || token?.isCancellationRequested) return
  const version = b.model.getVersionId()
  const id = crypto.randomUUID()
  let cancel: M.IDisposable | undefined
  try {
    b.ready ??= liveCommands
      .open(
        b.document.repositoryId,
        b.document.path,
        b.model.getLanguageId(),
        undefined,
        crypto.randomUUID()
      )
      .then(async (session) => {
        b.session = session
        if (!b.alive) {
          await liveCommands.close(session.id, b.document.path)
          throw new Error("Inspection closed")
        }
        return session
      })
      .catch((error) => {
        b.ready = undefined
        throw error
      })
    const session = await b.ready
    if (
      !b.alive ||
      token?.isCancellationRequested ||
      b.model.getVersionId() !== version
    )
      return
    const text = b.model.getValue()
    b.syncing = b.syncing
      .catch(() => {})
      .then(async () => {
        if (
          !b.alive ||
          b.model.getVersionId() !== version ||
          b.version === version
        )
          return
        await liveCommands.sync(
          session.id,
          {
            path: b.document.path,
            version,
            text,
            languageId: b.model.getLanguageId(),
            baseVersion: null,
            changes: [],
          },
          false
        )
        b.version = version
      })
    await b.syncing
    if (
      !b.alive ||
      token?.isCancellationRequested ||
      b.model.getVersionId() !== version
    )
      return
    b.requests.add(id)
    cancel = token?.onCancellationRequested(() => {
      void liveCommands.cancel(session.id, id).catch(() => {})
    })
    const result = await liveCommands.request<T>(
      session.id,
      id,
      b.document.path,
      version,
      method,
      params
    )
    return b.alive &&
      !token?.isCancellationRequested &&
      b.model.getVersionId() === version
      ? result
      : undefined
  } catch (error) {
    if (b.alive && !token?.isCancellationRequested) b.error(errorMessage(error))
  } finally {
    cancel?.dispose()
    b.requests.delete(id)
  }
}
async function locations(
  b: Binding,
  method: string,
  position: M.Position,
  token?: M.CancellationToken
) {
  const result = await request<
    L.Location | (L.Location | L.LocationLink)[] | null
  >(
    b,
    method,
    {
      position: {
        line: position.lineNumber - 1,
        character: position.column - 1,
      },
      ...(method.endsWith("references")
        ? { context: { includeDeclaration: true } }
        : {}),
    },
    token
  )
  return (Array.isArray(result) ? result : result ? [result] : []).map(
    (item) =>
      "targetUri" in item
        ? { uri: item.targetUri, range: item.targetSelectionRange }
        : item
  )
}
/** Separate native sessions never replace Code Editor's unsaved documents. No write providers. */
export function bindInspection(
  monaco: typeof M,
  model: M.editor.ITextModel,
  document: InspectionDocument,
  open: Binding["open"],
  error: Binding["error"]
) {
  if (!desktopAvailable()) return { dispose() {} }
  const b: Binding = {
    model,
    document,
    open,
    error,
    requests: new Set(),
    alive: true,
    version: 0,
    syncing: Promise.resolve(),
    targets: new Set(),
  }
  bindings.set(model.uri.toString(), b)
  if (!installed.has(monaco)) {
    installed.add(monaco)
    const selector = [{ scheme: "reviewbox" }, { scheme: "reviewbox-local" }]
    monaco.languages.registerHoverProvider(selector, {
      async provideHover(model, position, token) {
        const binding = bindings.get(model.uri.toString())
        if (!binding) return null
        const result = await request<L.Hover>(
          binding,
          "textDocument/hover",
          {
            position: {
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
          },
          token
        )
        if (!result) return null
        const values = Array.isArray(result.contents)
          ? result.contents
          : [result.contents]
        return {
          range: result.range ? range(result.range) : undefined,
          contents: values.map((value) => ({
            value: typeof value === "string" ? value : value.value,
          })),
        }
      },
    })
    // Use native Monaco actions (F12 / Shift+F12 / Cmd-click) and a read-only source dialog.
    for (const method of ["definition", "references"] as const) {
      const provide = async (
        model: M.editor.ITextModel,
        position: M.Position,
        token: M.CancellationToken
      ) => {
        const binding = bindings.get(model.uri.toString())
        if (!binding) return []
        const values = await locations(
          binding,
          `textDocument/${method}`,
          position,
          token
        )
        return Promise.all(
          values.map(async (value) => {
            const uri = monaco.Uri.from({
              scheme: "reviewbox-inspection",
              authority: model.id,
              path: new URL(value.uri).pathname,
              query: JSON.stringify({
                uri: value.uri,
                owner: model.uri.toString(),
              }),
            })
            if (!monaco.editor.getModel(uri) && binding.session) {
              try {
                const source = await liveCommands.source(
                  binding.session.id,
                  value.uri
                )
                if (!binding.alive || token.isCancellationRequested) return null
                if (!monaco.editor.getModel(uri))
                  binding.targets.add(
                    monaco.editor.createModel(source.text, undefined, uri)
                  )
              } catch (error) {
                if (binding.alive) binding.error(errorMessage(error))
                return null
              }
            }
            return { uri, range: range(value.range) }
          })
        ).then((results) =>
          results.filter(
            (item): item is NonNullable<typeof item> => item !== null
          )
        )
      }
      if (method === "definition")
        monaco.languages.registerDefinitionProvider(selector, {
          provideDefinition: provide,
        })
      else
        monaco.languages.registerReferenceProvider(selector, {
          provideReferences: (m, p, _c, t) => provide(m, p, t),
        })
    }
    monaco.editor.registerEditorOpener({
      openCodeEditor(_editor, uri, selection) {
        if (uri.scheme !== "reviewbox-inspection") return false
        const target = JSON.parse(uri.query) as L.Location & { owner: string }
        const binding = bindings.get(target.owner)
        if (!binding?.alive || !binding.session) return false
        binding.open({
          sessionId: binding.session.id,
          uri: target.uri,
          range:
            selection && "startLineNumber" in selection
              ? {
                  start: {
                    line: selection.startLineNumber - 1,
                    character: selection.startColumn - 1,
                  },
                  end: {
                    line: selection.endLineNumber - 1,
                    character: selection.endColumn - 1,
                  },
                }
              : {
                  start: {
                    line: (selection?.lineNumber ?? 1) - 1,
                    character: (selection?.column ?? 1) - 1,
                  },
                  end: {
                    line: (selection?.lineNumber ?? 1) - 1,
                    character: (selection?.column ?? 1) - 1,
                  },
                },
        })
        return true
      },
    })
  }
  return {
    dispose() {
      b.alive = false
      for (const target of b.targets) target.dispose()
      b.targets.clear()
      if (bindings.get(model.uri.toString()) === b)
        bindings.delete(model.uri.toString())
      if (b.session) {
        for (const id of b.requests)
          void liveCommands.cancel(b.session.id, id).catch(() => {})
        void liveCommands.close(b.session.id, document.path).catch(() => {})
      }
    },
  }
}
