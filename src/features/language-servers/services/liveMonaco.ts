import type * as M from "monaco-editor/editor/editor.api"
import type * as L from "vscode-languageserver-protocol"
import { listen } from "@tauri-apps/api/event"
import { create } from "zustand"
import type {
  LiveLanguageEvent,
  LiveLanguageSession,
} from "@/lib/desktop/contracts.generated"
import { resolveLanguageId } from "@/lib/code/languages"
import { errorMessage } from "@/lib/desktop/review.commands"
import {
  dirty,
  bufferLanguage,
  getEditor,
  updateEditor,
  editBuffer,
  useEditorStore,
  type EditorBuffer,
} from "@/features/code-editor/stores/editor.store"
import { documentCapability } from "../helpers/liveCapabilities"
import { runSaveActions } from "./saveActions"
import { reportDiagnostic } from "@/lib/desktop/diagnostics"
import { replaceText } from "../helpers/lspEdits"
import { editorCommands } from "@/features/code-editor/services/editor.commands"
import { liveCommands } from "./liveLanguage.commands"

interface Binding {
  repository: string
  key: string
  model: M.editor.ITextModel
  monaco: typeof M
  session?: LiveLanguageSession
  pending?: Promise<void>
  version: number
  sendingVersion?: number
  revision: string
  path: string
  language?: string
  stopped?: boolean
  diagnosticVersion?: number
  diagnosticRequest?: symbol
  semanticChanges?: M.Emitter<void>
  saveTransaction?: boolean
  changes?: { base: number; edits: M.editor.IModelContentChange[] }
  modelListener?: M.IDisposable
  providers?: { signature: string; disposables: M.IDisposable[] }
}
export interface EditPreview {
  repository: string
  files: {
    key: string
    path: string
    version: number
    before: string
    after: string
  }[]
}
export const useLiveLanguages = create<{
  saveNotices: Record<string, string>
  sessions: Record<string, LiveLanguageSession>
  status: Record<string, string>
  capabilities: Record<string, LiveLanguageSession["capabilities"]>
  edits: EditPreview | null
}>(() => ({
  saveNotices: {},
  sessions: {},
  status: {},
  capabilities: {},
  edits: null,
}))
const bindings = new Map<string, Binding>()
const navigation = new Map<string, M.IRange | M.IPosition>()
const targets = new Map<string, { repository: string; path: string }>()
let dispose: (() => void) | undefined
let installed = false
const providerFactories: {
  capability: string
  register: (
    selector: M.languages.LanguageSelector,
    options: unknown,
    binding: Binding
  ) => M.IDisposable
}[] = []
function registerFor(
  capability: string,
  register: (
    selector: M.languages.LanguageSelector,
    options: unknown,
    binding: Binding
  ) => M.IDisposable
) {
  providerFactories.push({ capability, register })
}
function refreshProviders(b: Binding) {
  const available = providerFactories.filter(({ capability }) => {
    const value = capabilityFor(b, capability)
    return (
      !b.stopped &&
      !b.model.isDisposed() &&
      value &&
      (capability !== "semanticTokensProvider" ||
        (value as L.SemanticTokensOptions).full)
    )
  })
  const signature = JSON.stringify(
    available.map((f) => [f.capability, capabilityFor(b, f.capability)])
  )
  if (b.providers?.signature === signature) return
  b.providers?.disposables.forEach((p) => p.dispose())
  b.providers = {
    signature,
    disposables: available.map(({ register, capability }) =>
      register(
        { scheme: b.model.uri.scheme, pattern: b.model.uri.path },
        capabilityFor(b, capability),
        b
      )
    ),
  }
}
const status = (b: Binding, value: string) =>
  useLiveLanguages.setState((s) => ({
    status: { ...s.status, [b.key]: value },
  }))
const range = (r: L.Range): M.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
})
const position = (p: M.Position) => ({
  line: p.lineNumber - 1,
  character: p.column - 1,
})
const lspRange = (r: M.IRange): L.Range => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
})
function documentation(
  value: string | L.MarkupContent | undefined
): M.IMarkdownString | undefined {
  return value
    ? {
        value: typeof value === "string" ? value : value.value,
        isTrusted: false,
        supportHtml: false,
      }
    : undefined
}
function current(b: Binding) {
  return getEditor(b.repository)?.buffers.find((file) => file.id === b.key)
}
function forgetPublishedSession(b: Binding) {
  useLiveLanguages.setState((state) => {
    const sessions = { ...state.sessions }
    delete sessions[b.key]
    return { sessions }
  })
}
function capabilityFor(b: Binding, name: string) {
  const file = current(b)
  return documentCapability(
    b.session?.capabilities,
    name,
    file?.uri ?? "",
    b.language ??
      (file ? resolveLanguageId(bufferLanguage(b.repository, file)).lspId : "")
  )
}
function get(model: M.editor.ITextModel, capability: string) {
  const b = bindings.get(model.uri.toString())
  return b && capabilityFor(b, capability) ? b : undefined
}
async function sync(b: Binding, allowStart = true) {
  if (b.pending) {
    await b.pending
    return sync(b, allowStart)
  }
  const file = current(b)
  if (!file || file.readOnly || b.stopped) return
  const language = resolveLanguageId(bufferLanguage(b.repository, file))
  if (
    b.session &&
    b.path === file.path &&
    b.version === file.version &&
    b.revision === file.revision &&
    b.language === language.lspId
  )
    return
  const work = (async () => {
    if (
      b.session &&
      ((b.language && b.language !== language.lspId) ||
        (b.path && b.path !== file.path))
    ) {
      await liveCommands.close(b.session.id, b.path)
      b.session = undefined
      forgetPublishedSession(b)
      b.language = undefined
      b.version = 0
      b.path = ""
    }
    if (!b.session) {
      if (!allowStart) return
      status(b, "Starting language support…")
      b.session = await liveCommands.open(
        b.repository,
        file.path,
        language.lspId,
        getEditor(b.repository)?.servers[language.lspId] || undefined
      )
      if (!current(b) || b.model.isDisposed()) return
      useLiveLanguages.setState((s) => ({
        sessions: { ...s.sessions, [b.key]: b.session! },
        capabilities: { ...s.capabilities, [b.key]: b.session!.capabilities },
      }))
      refreshProviders(b)
    }
    if (b.path && b.path !== file.path) {
      await liveCommands.close(b.session.id, b.path)
      b.version = 0
    }
    const changes = b.changes
    b.changes = undefined
    b.sendingVersion = file.version
    await liveCommands.sync(
      b.session.id,
      {
        path: file.path,
        version: file.version,
        text: file.text,
        languageId: language.lspId,
        baseVersion: changes?.base ?? null,
        changes: (changes?.edits ?? []).map((e) => ({
          startLine: e.range.startLineNumber - 1,
          startCharacter: e.range.startColumn - 1,
          endLine: e.range.endLineNumber - 1,
          endCharacter: e.range.endColumn - 1,
          text: e.text,
        })),
      },
      b.revision !== file.revision && !dirty(file)
    )
    if (!current(b) || b.model.isDisposed()) {
      await liveCommands.close(b.session.id, file.path).catch(() => {})
      return
    }
    b.language = language.lspId
    b.path = file.path
    b.version = file.version
    b.revision = file.revision
    status(b, "Language support active")
    if (capabilityFor(b, "diagnosticProvider"))
      void pullDiagnostics(b).catch(() => {})
  })()
    .catch((error) => {
      status(b, errorMessage(error))
      throw error
    })
    .finally(() => {
      b.pending = undefined
      b.sendingVersion = undefined
    })
  b.pending = work
  return work
}
async function request<T>(
  b: Binding,
  method: string,
  params: object,
  token?: M.CancellationToken,
  allowStart = true
): Promise<T | undefined> {
  try {
    await sync(b, allowStart)
    await Promise.all(
      [...bindings.values()]
        .filter(
          (other) =>
            other !== b &&
            other.repository === b.repository &&
            other.session?.id === b.session?.id
        )
        .map((other) => sync(other, allowStart).catch(() => {}))
    )
    const file = current(b)
    if (!file || !b.session || token?.isCancellationRequested) return
    const id = crypto.randomUUID()
    const sessionId = b.session.id
    const cancellation = token?.onCancellationRequested(
      () => void liveCommands.cancel(sessionId, id).catch(() => {})
    )
    try {
      const result = await liveCommands.request<T>(
        sessionId,
        id,
        file.path,
        file.version,
        method,
        params
      )
      if (
        token?.isCancellationRequested ||
        b.session?.id !== sessionId ||
        current(b)?.version !== file.version
      )
        return
      status(b, "Language support active")
      return result
    } finally {
      cancellation?.dispose()
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : ""
    if (code !== "cancelled" && code !== "stale_document")
      status(b, errorMessage(error))
    if (!allowStart) throw error
    return
  }
}
async function materialize(b: Binding, uri: string) {
  if (!b.session) throw new Error("The language session is unavailable.")
  const file = await liveCommands.source(b.session.id, uri)
  let buffer = getEditor(b.repository).buffers.find((f) => f.path === file.path)
  if (!buffer) {
    buffer = {
      ...file,
      id: crypto.randomUUID(),
      version: 1,
      baseText: file.text,
      preview: false,
    }
    updateEditor(b.repository, (s) => ({
      ...s,
      buffers: [...s.buffers, buffer!],
    }))
  }
  const modelUri = b.monaco.Uri.parse(
    `reviewbox-editor://${b.repository}/${buffer.id}`
  )
  const model =
    b.monaco.editor.getModel(modelUri) ??
    b.monaco.editor.createModel(
      buffer.text,
      bufferLanguage(b.repository, buffer),
      modelUri
    )
  bindLiveEditor(b.monaco, model, b.repository, buffer)
  targets.set(modelUri.toString(), {
    repository: b.repository,
    path: buffer.path,
  })
  return { uri: modelUri, buffer }
}
async function locations(
  b: Binding,
  input: L.Location | L.Location[] | L.LocationLink[] | null | undefined
) {
  const items = input ? (Array.isArray(input) ? input : [input]) : []
  return Promise.all(
    items.slice(0, 200).map(async (item) => {
      const target = "targetUri" in item ? item.targetUri : item.uri
      const selection =
        "targetUri" in item ? item.targetSelectionRange : item.range
      const model = await materialize(b, target)
      return { uri: model.uri, range: range(selection) }
    })
  )
}
export async function previewWorkspaceEdit(b: Binding, edit: L.WorkspaceEdit) {
  const changes = new Map<
    string,
    { edits: L.TextEdit[]; version?: number | null }
  >()
  for (const [uri, edits] of Object.entries(edit.changes ?? {}))
    changes.set(uri, { edits })
  for (const change of edit.documentChanges ?? []) {
    if (!("textDocument" in change))
      throw new Error(
        "This refactoring includes file operations. Use the file tree to perform them explicitly."
      )
    changes.set(change.textDocument.uri, {
      edits: change.edits,
      version: change.textDocument.version,
    })
  }
  const files: EditPreview["files"] = []
  for (const [uri, change] of changes) {
    const { buffer } = await materialize(b, uri)
    if (buffer.readOnly || buffer.external !== undefined)
      throw new Error(
        "Resolve external changes before applying this refactoring."
      )
    if (change.version != null && change.version !== buffer.version)
      throw new Error("The refactoring is based on an older buffer.")
    files.push({
      key: buffer.id,
      path: buffer.path,
      version: buffer.version,
      before: buffer.text,
      after: replaceText(buffer.text, change.edits),
    })
  }
  useLiveLanguages.setState({ edits: { repository: b.repository, files } })
}
export async function applyWorkspaceEdit() {
  const preview = useLiveLanguages.getState().edits
  if (!preview) return
  for (const change of preview.files) {
    const buffer = getEditor(preview.repository)?.buffers.find(
      (b) => b.id === change.key
    )
    const disk = await editorCommands.read(preview.repository, change.path)
    if (!buffer || disk.revision !== buffer.revision || disk.readOnly)
      throw new Error(
        "A file changed on disk while the preview was open. Request the refactoring again."
      )
  }
  const session = getEditor(preview.repository)
  if (
    preview.files.some(
      (f) =>
        !session.buffers.some(
          (b) =>
            b.id === f.key &&
            b.version === f.version &&
            b.text === f.before &&
            b.external === undefined
        )
    )
  )
    throw new Error(
      "Files changed while the preview was open. Request the refactoring again."
    )
  updateEditor(preview.repository, (s) => ({
    ...s,
    buffers: s.buffers.map((b) => {
      const edit = preview.files.find((f) => f.key === b.id)
      return edit ? { ...b, text: edit.after, version: b.version + 1 } : b
    }),
  }))
  for (const binding of bindings.values()) {
    const file = preview.files.find((f) => f.key === binding.key)
    if (file && binding.model.getValue() !== file.after) {
      binding.model.pushStackElement()
      binding.model.pushEditOperations(
        [],
        [{ range: binding.model.getFullModelRange(), text: file.after }],
        () => null
      )
      binding.model.pushStackElement()
    }
  }
  useLiveLanguages.setState({ edits: null })
}

function install(monaco: typeof M) {
  if (installed) return
  installed = true
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, uri, selection) {
      const target = targets.get(uri.toString())
      if (!target) return false
      if (selection) navigation.set(uri.toString(), selection)
      updateEditor(target.repository, (s) => ({
        ...s,
        active: target.path,
        buffers: s.buffers.map((b) =>
          b.path === target.path ? { ...b, preview: false } : b
        ),
      }))
      const active = monaco.editor
        .getEditors()
        .find((e) => e.getModel()?.uri.toString() === uri.toString())
      if (active && selection) {
        active.revealPositionInCenter({
          lineNumber:
            "startLineNumber" in selection
              ? selection.startLineNumber
              : selection.lineNumber,
          column:
            "startColumn" in selection
              ? selection.startColumn
              : selection.column,
        })
        active.focus()
      }
      return true
    },
  })
  registerFor("completionProvider", (selector, options) =>
    monaco.languages.registerCompletionItemProvider(selector, {
      triggerCharacters: (options as L.CompletionOptions)?.triggerCharacters,
      async provideCompletionItems(model, p, context, token) {
        const b = get(model, "completionProvider")
        if (!b) return
        const result = await request<
          L.CompletionItem[] | L.CompletionList | null
        >(
          b,
          "textDocument/completion",
          {
            position: position(p),
            context: {
              triggerKind: context.triggerKind,
              triggerCharacter: context.triggerCharacter,
            },
          },
          token
        )
        const items = Array.isArray(result) ? result : (result?.items ?? [])
        const word = model.getWordUntilPosition(p)
        return {
          incomplete: !Array.isArray(result) && !!result?.isIncomplete,
          suggestions: items.map((item) => {
            const edit = item.textEdit
            const fallback = {
              startLineNumber: p.lineNumber,
              endLineNumber: p.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            }
            return {
              label: item.label,
              kind: completionKind(monaco, item.kind),
              insertText: edit?.newText ?? item.insertText ?? item.label,
              range: edit
                ? "range" in edit
                  ? range(edit.range)
                  : { insert: range(edit.insert), replace: range(edit.replace) }
                : fallback,
              detail: item.detail,
              documentation: documentation(item.documentation),
              sortText: item.sortText,
              filterText: item.filterText,
              preselect: item.preselect,
              insertTextRules:
                item.insertTextFormat === 2
                  ? monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet
                  : undefined,
              additionalTextEdits: item.additionalTextEdits?.map((e) => ({
                range: range(e.range),
                text: e.newText,
              })),
              lspItem: item,
              version: current(b)?.version,
              binding: b,
            }
          }),
        }
      },
      async resolveCompletionItem(item, token) {
        const owned = item as typeof item & {
          lspItem?: L.CompletionItem
          binding?: Binding
          version?: number
        }
        if (
          !owned.binding ||
          !owned.lspItem ||
          current(owned.binding)?.version !== owned.version
        )
          return item
        const provider = capabilityFor(owned.binding, "completionProvider") as
          L.CompletionOptions | undefined
        if (!provider?.resolveProvider) return item
        const result = await request<L.CompletionItem>(
          owned.binding,
          "completionItem/resolve",
          owned.lspItem,
          token
        )
        return result
          ? {
              ...item,
              detail: result.detail,
              documentation: documentation(result.documentation),
              additionalTextEdits: result.additionalTextEdits?.map((e) => ({
                range: range(e.range),
                text: e.newText,
              })),
            }
          : item
      },
    })
  )
  registerFor("hoverProvider", (selector) =>
    monaco.languages.registerHoverProvider(selector, {
      async provideHover(model, p, token) {
        const b = get(model, "hoverProvider")
        if (!b) return
        const value = await request<L.Hover | null>(
          b,
          "textDocument/hover",
          { position: position(p) },
          token
        )
        if (!value) return
        const contents = (
          Array.isArray(value.contents) ? value.contents : [value.contents]
        ).map((c) =>
          typeof c === "object" && "language" in c
            ? {
                value: `\`\`\`${c.language}\n${c.value}\n\`\`\``,
                isTrusted: false,
              }
            : documentation(c)!
        )
        return { contents, range: value.range ? range(value.range) : undefined }
      },
    })
  )
  registerFor("definitionProvider", (selector) =>
    monaco.languages.registerDefinitionProvider(selector, {
      async provideDefinition(model, p, token) {
        const b = get(model, "definitionProvider")
        return b
          ? locations(
              b,
              await request<L.Location[] | L.LocationLink[] | null>(
                b,
                "textDocument/definition",
                { position: position(p) },
                token
              )
            )
          : undefined
      },
    })
  )
  registerFor("referencesProvider", (selector) =>
    monaco.languages.registerReferenceProvider(selector, {
      async provideReferences(model, p, context, token) {
        const b = get(model, "referencesProvider")
        return b
          ? locations(
              b,
              await request<L.Location[]>(
                b,
                "textDocument/references",
                { position: position(p), context },
                token
              )
            )
          : []
      },
    })
  )
  registerFor("signatureHelpProvider", (selector, options) =>
    monaco.languages.registerSignatureHelpProvider(selector, {
      signatureHelpTriggerCharacters: (options as L.SignatureHelpOptions)
        ?.triggerCharacters,
      signatureHelpRetriggerCharacters: (options as L.SignatureHelpOptions)
        ?.retriggerCharacters,
      async provideSignatureHelp(model, p, token, context) {
        const b = get(model, "signatureHelpProvider")
        if (!b) return
        const value = await request<L.SignatureHelp | null>(
          b,
          "textDocument/signatureHelp",
          {
            position: position(p),
            context: {
              triggerKind: context.triggerKind,
              isRetrigger: context.isRetrigger,
              triggerCharacter: context.triggerCharacter,
            },
          },
          token
        )
        return value
          ? {
              value: {
                activeSignature: value.activeSignature ?? 0,
                activeParameter: value.activeParameter ?? 0,
                signatures: value.signatures.map((s) => ({
                  ...s,
                  documentation: documentation(s.documentation),
                  parameters: (s.parameters ?? []).map((p) => ({
                    ...p,
                    documentation: documentation(p.documentation),
                  })),
                })),
              },
              dispose() {},
            }
          : undefined
      },
    })
  )
  registerFor("documentSymbolProvider", (selector) =>
    monaco.languages.registerDocumentSymbolProvider(selector, {
      async provideDocumentSymbols(model, token) {
        const b = get(model, "documentSymbolProvider")
        if (!b) return []
        const symbols = await request<
          L.DocumentSymbol[] | L.SymbolInformation[]
        >(b, "textDocument/documentSymbol", {}, token)
        const convert = (
          s: L.DocumentSymbol | L.SymbolInformation
        ): M.languages.DocumentSymbol => ({
          name: s.name,
          detail: "detail" in s ? (s.detail ?? "") : "",
          kind: s.kind - 1,
          tags: [],
          range: range("range" in s ? s.range : s.location.range),
          selectionRange: range(
            "selectionRange" in s ? s.selectionRange : s.location.range
          ),
          children: "children" in s ? s.children?.map(convert) : undefined,
        })
        return symbols?.map(convert) ?? []
      },
    })
  )
  registerFor("documentFormattingProvider", (selector) =>
    monaco.languages.registerDocumentFormattingEditProvider(selector, {
      async provideDocumentFormattingEdits(model, options, token) {
        const b = get(model, "documentFormattingProvider")
        if (!b) return []
        const edits = await request<L.TextEdit[]>(
          b,
          "textDocument/formatting",
          { options },
          token
        )
        return (
          edits?.map((e) => ({ range: range(e.range), text: e.newText })) ?? []
        )
      },
    })
  )
  registerFor("renameProvider", (selector) =>
    monaco.languages.registerRenameProvider(selector, {
      async resolveRenameLocation(model, p, token) {
        const b = get(model, "renameProvider")
        const options = (b ? capabilityFor(b, "renameProvider") : undefined) as
          L.RenameOptions | undefined
        if (b && options?.prepareProvider) {
          const prepared = await request<L.PrepareRenameResult | null>(
            b,
            "textDocument/prepareRename",
            { position: position(p) },
            token
          )
          if (!prepared)
            return {
              range: new monaco.Range(
                p.lineNumber,
                p.column,
                p.lineNumber,
                p.column
              ),
              text: "",
              rejectReason: "This symbol cannot be renamed.",
            }
          if ("range" in prepared)
            return { range: range(prepared.range), text: prepared.placeholder }
          if ("start" in prepared)
            return {
              range: range(prepared),
              text: model.getValueInRange(range(prepared)),
            }
        }
        const word = model.getWordAtPosition(p)
        return {
          range: new monaco.Range(
            p.lineNumber,
            word?.startColumn ?? p.column,
            p.lineNumber,
            word?.endColumn ?? p.column
          ),
          text: word?.word ?? "",
        }
      },
      async provideRenameEdits(model, p, newName, token) {
        const b = get(model, "renameProvider")
        if (!b)
          return {
            edits: [],
            rejectReason: "Rename is unavailable for this language.",
          }
        const edit = await request<L.WorkspaceEdit>(
          b,
          "textDocument/rename",
          { position: position(p), newName },
          token
        )
        if (edit) {
          try {
            await previewWorkspaceEdit(b, edit)
          } catch (e) {
            return { edits: [], rejectReason: errorMessage(e) }
          }
        }
        return { edits: [] }
      },
    })
  )
  const applyAction = monaco.editor.registerCommand(
    "reviewbox.previewCodeAction",
    async (
      _accessor,
      modelUri: string,
      action: L.CodeAction,
      version: number
    ) => {
      const b = bindings.get(modelUri)
      if (!b) return
      if (current(b)?.version !== version) {
        status(b, "The file changed. Request code actions again.")
        return
      }
      if (
        !action.edit &&
        (capabilityFor(b, "codeActionProvider") as L.CodeActionOptions)
          ?.resolveProvider
      )
        action =
          (await request<L.CodeAction>(b, "codeAction/resolve", action)) ??
          action
      try {
        if (action.edit) await previewWorkspaceEdit(b, action.edit)
      } catch (e) {
        status(b, errorMessage(e))
      }
    }
  )
  void applyAction
  registerFor("codeActionProvider", (selector) =>
    monaco.languages.registerCodeActionProvider(selector, {
      async provideCodeActions(model, selected, context, token) {
        const b = get(model, "codeActionProvider")
        if (!b) return { actions: [], dispose() {} }
        const diagnostics = context.markers.map((m) => ({
          range: lspRange(m),
          message: m.message,
          code: typeof m.code === "object" ? m.code.value : m.code,
          source: m.source,
          severity: m.severity === monaco.MarkerSeverity.Error ? 1 : 2,
        }))
        const actions = await request<(L.CodeAction | L.Command)[]>(
          b,
          "textDocument/codeAction",
          {
            range: lspRange(selected),
            context: {
              diagnostics,
              only: context.only ? [context.only] : undefined,
            },
          },
          token
        )
        return {
          actions: (actions ?? []).map((action) => ({
            title: action.title,
            kind: "kind" in action ? action.kind : undefined,
            isPreferred: "isPreferred" in action ? action.isPreferred : false,
            disabled:
              typeof action.command === "string" || action.command
                ? "This action requires a server command that is not available in the editor."
                : "disabled" in action
                  ? action.disabled?.reason
                  : undefined,
            command: {
              id: "reviewbox.previewCodeAction",
              title: action.title,
              arguments: [model.uri.toString(), action, current(b)?.version],
            },
          })),
          dispose() {},
        }
      },
    })
  )
  // Tokens are mapped to one shared legend, as servers may use different indices.
  const tokenTypes = [
    "namespace",
    "type",
    "class",
    "enum",
    "interface",
    "struct",
    "typeParameter",
    "parameter",
    "variable",
    "property",
    "enumMember",
    "event",
    "function",
    "method",
    "macro",
    "keyword",
    "modifier",
    "comment",
    "string",
    "number",
    "regexp",
    "operator",
    "decorator",
  ]
  const tokenModifiers = [
    "declaration",
    "definition",
    "readonly",
    "static",
    "deprecated",
    "abstract",
    "async",
    "modification",
    "documentation",
    "defaultLibrary",
  ]
  registerFor("semanticTokensProvider", (selector, _options, binding) => {
    const changes = new monaco.Emitter<void>()
    binding.semanticChanges = changes
    const provider = monaco.languages.registerDocumentSemanticTokensProvider(
      selector,
      {
        onDidChange: changes.event,
        getLegend: () => ({ tokenTypes, tokenModifiers }),
        releaseDocumentSemanticTokens() {},
        async provideDocumentSemanticTokens(model, _last, token) {
          const b = get(model, "semanticTokensProvider")
          if (!b) return null
          const capabilities = capabilityFor(
            b,
            "semanticTokensProvider"
          ) as L.SemanticTokensOptions
          if (!capabilities.full) return null
          const result = await request<L.SemanticTokens>(
            b,
            "textDocument/semanticTokens/full",
            {},
            token
          )
          if (!result) return null
          const data = [...result.data]
          for (let i = 0; i < data.length; i += 5) {
            data[i + 3] = Math.max(
              0,
              tokenTypes.indexOf(capabilities.legend.tokenTypes[data[i + 3]])
            )
            const bits = data[i + 4]
            data[i + 4] = 0
            capabilities.legend.tokenModifiers.forEach((name, index) => {
              const target = tokenModifiers.indexOf(name)
              if (target >= 0 && bits & (1 << index)) data[i + 4] |= 1 << target
            })
          }
          return { data: new Uint32Array(data), resultId: result.resultId }
        },
      }
    )
    return {
      dispose() {
        provider.dispose()
        changes.dispose()
        if (binding.semanticChanges === changes)
          binding.semanticChanges = undefined
      },
    }
  })
}

export function bindLiveEditor(
  monaco: typeof M,
  model: M.editor.ITextModel,
  repository: string,
  buffer: EditorBuffer
) {
  install(monaco)
  let b = bindings.get(model.uri.toString())
  if (!b) {
    b = {
      repository,
      key: buffer.id,
      model,
      monaco,
      version: 0,
      revision: "",
      path: "",
    }
    bindings.set(model.uri.toString(), b)
    const binding = b
    binding.modelListener = model.onDidChangeContent((event) => {
      if (!binding.session || binding.stopped) {
        binding.changes = undefined
        return
      }
      if ((binding.changes?.edits.length ?? 0) + event.changes.length > 1024) {
        binding.changes = { base: -1, edits: [] }
        return
      }
      binding.changes ??= {
        base: binding.sendingVersion ?? binding.version,
        edits: [],
      }
      // Monaco ranges refer to the pre-event model; replay from bottom to top.
      binding.changes.edits.push(
        ...[...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)
      )
    })
  }
  if (!buffer.readOnly) void sync(b).catch(() => {})
  for (const other of getEditor(repository)?.buffers ?? []) {
    const uri = monaco.Uri.parse(`reviewbox-editor://${repository}/${other.id}`)
    if (bindings.has(uri.toString())) continue
    const model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(
        other.text,
        bufferLanguage(repository, other),
        uri
      )
    bindLiveEditor(monaco, model, repository, other)
  }
  if (!dispose) {
    const unlisten = listen<LiveLanguageEvent>(
      "reviewbox:live-language",
      (event) => {
        for (const b of bindings.values()) {
          if (b.session?.id !== event.payload.sessionId) continue
          if (event.payload.method === "reviewbox/reconfigure") {
            void restartLiveEditor(b.key).catch((error) =>
              status(b, errorMessage(error))
            )
            break
          } else if (event.payload.method === "reviewbox/capabilities") {
            b.session!.capabilities = event.payload
              .params as LiveLanguageSession["capabilities"]
            refreshProviders(b)
            useLiveLanguages.setState((s) => ({
              capabilities: {
                ...s.capabilities,
                [b.key]: b.session!.capabilities,
              },
            }))
          } else if (event.payload.method === "reviewbox/stopped") {
            b.stopped = true
            b.diagnosticRequest = undefined
            b.diagnosticVersion = undefined
            b.session!.capabilities = {}
            refreshProviders(b)
            b.monaco.editor.setModelMarkers(b.model, "reviewbox-lsp", [])
            status(b, "Language server stopped. Restart to reconnect.")
            useLiveLanguages.setState((s) => ({
              capabilities: { ...s.capabilities, [b.key]: {} },
            }))
          } else if (event.payload.method === "workspace/diagnostic/refresh") {
            b.diagnosticVersion = undefined
            if (!b.stopped && capabilityFor(b, "diagnosticProvider"))
              void pullDiagnostics(b).catch(() => {})
          } else if (
            event.payload.method === "workspace/semanticTokens/refresh"
          ) {
            b.semanticChanges?.fire()
          } else if (event.payload.method === "window/logMessage") {
            const log = event.payload.params as L.LogMessageParams
            if (log.type === 1)
              status(b, `Configuration required: ${log.message}`)
          } else if (
            event.payload.method === "textDocument/publishDiagnostics"
          ) {
            const data = event.payload.params as L.PublishDiagnosticsParams
            const file = current(b)
            if (
              file?.uri === data.uri &&
              (data.version == null || data.version === file.version) &&
              b.version === file.version
            )
              setDiagnostics(b, data.diagnostics ?? [])
          } else if (event.payload.method === "$/progress") {
            const data = event.payload.params as {
              value:
                | L.WorkDoneProgressBegin
                | L.WorkDoneProgressReport
                | L.WorkDoneProgressEnd
            }
            status(
              b,
              data.value.kind === "end"
                ? "Language support active"
                : `Indexing${"message" in data.value && data.value.message ? `: ${data.value.message}` : "…"}`
            )
          }
        }
      }
    )
    const unsubscribe = useEditorStore.subscribe(() => {
      for (const [uri, b] of bindings) {
        const file = current(b)
        if (!file) {
          bindings.delete(uri)
          forgetPublishedSession(b)
          b.providers?.disposables.forEach((p) => p.dispose())
          b.modelListener?.dispose()
          targets.delete(uri)
          if (b.session)
            void liveCommands.close(b.session.id, b.path).catch(() => {})
          b.model.dispose()
          continue
        }
        if (
          b.model.getValue().replace(/\r\n?/g, "\n") !==
          file.text.replace(/\r\n?/g, "\n")
        ) {
          if (!b.saveTransaction) b.model.pushStackElement()
          b.model.pushEditOperations(
            [],
            [{ range: b.model.getFullModelRange(), text: file.text }],
            () => null
          )
          if (!b.saveTransaction) b.model.pushStackElement()
        }
        const language = bufferLanguage(b.repository, file)
        const languageChanged = b.model.getLanguageId() !== language
        if (languageChanged) monaco.editor.setModelLanguage(b.model, language)
        if (languageChanged && !b.session && !b.stopped)
          void sync(b).catch(() => {})
        if (file.version !== b.version && b.session) {
          monaco.editor.setModelMarkers(b.model, "reviewbox-lsp", [])
          void sync(b).catch(() => {})
        } else if (
          (file.revision !== b.revision && b.session) ||
          (file.path !== b.path && b.session) ||
          (b.language !== resolveLanguageId(language).lspId && b.session)
        )
          void sync(b).catch(() => {})
      }
    })
    dispose = () => {
      unsubscribe()
      void unlisten.then((stop) => stop())
    }
  }
}
export async function prepareLiveSave(repository: string, key: string) {
  const b = [...bindings.values()].find(
    (b) => b.repository === repository && b.key === key
  )
  if (!b?.session || b.stopped || b.model.isDisposed()) return
  const file = current(b)
  if (!file || file.readOnly || file.external !== undefined) return
  const notice = (value: string) =>
    useLiveLanguages.setState((s) => ({
      saveNotices: { ...s.saveNotices, [key]: value },
    }))
  notice("")
  const preferences = getEditor(repository)?.saveActions
  const settings = preferences?.[bufferLanguage(repository, file)] ??
    preferences?.["*"] ?? {
      formatOnSave: true,
      organizeImportsOnSave: true,
    }
  const tokenFor = (signal: AbortSignal): M.CancellationToken => ({
    get isCancellationRequested() {
      return signal.aborted
    },
    onCancellationRequested(listener) {
      const cancel = () => listener(undefined)
      signal.addEventListener("abort", cancel, { once: true })
      return { dispose: () => signal.removeEventListener("abort", cancel) }
    },
  })
  const actions: Parameters<typeof runSaveActions>[0]["actions"] = []
  let needsPreview = false
  if (settings.organizeImportsOnSave && capabilityFor(b, "codeActionProvider"))
    actions.push(async (before, signal) => {
      const offered = await request<(L.CodeAction | L.Command)[]>(
        b,
        "textDocument/codeAction",
        {
          range: lspRange(b.model.getFullModelRange()),
          context: {
            diagnostics: [],
            only: ["source.organizeImports"],
            triggerKind: 1,
          },
        },
        tokenFor(signal),
        false
      )
      for (const item of offered ?? []) {
        if (item.command) {
          notice(
            "An imports action requires a server command. Open Code actions to inspect it."
          )
          continue
        }
        if (
          !("kind" in item) ||
          !item.kind?.startsWith("source.organizeImports") ||
          item.disabled ||
          item.command
        )
          continue
        let action = item
        if (
          !action.edit &&
          (capabilityFor(b, "codeActionProvider") as L.CodeActionOptions)
            ?.resolveProvider
        )
          action =
            (await request<L.CodeAction>(
              b,
              "codeAction/resolve",
              action,
              tokenFor(signal),
              false
            )) ?? action
        if (!action.edit || action.command) continue
        const edits: L.TextEdit[] = []
        let otherFiles = false
        for (const [uri, changes] of Object.entries(
          action.edit.changes ?? {}
        )) {
          if (uri !== current(b)?.uri) otherFiles = true
          else edits.push(...changes)
        }
        for (const change of action.edit.documentChanges ?? []) {
          if (
            !("textDocument" in change) ||
            change.textDocument.uri !== current(b)?.uri ||
            (change.textDocument.version != null &&
              change.textDocument.version !== before.version)
          )
            otherFiles = true
          else
            edits.push(
              ...change.edits.filter((e): e is L.TextEdit => "range" in e)
            )
        }
        if (!otherFiles) return replaceText(before.text, edits)
        if (!signal.aborted) {
          notice(
            "Imports affect other files. Open Code actions to review the changes before applying them."
          )
          needsPreview = true
        }
        return before.text
      }
      return before.text
    })
  if (settings.formatOnSave && capabilityFor(b, "documentFormattingProvider"))
    actions.push(async (before, signal) => {
      if (needsPreview) return before.text
      const options = b.model.getOptions()
      const edits = await request<L.TextEdit[]>(
        b,
        "textDocument/formatting",
        {
          options: {
            tabSize: options.tabSize,
            insertSpaces: options.insertSpaces,
          },
        },
        tokenFor(signal),
        false
      )
      return replaceText(before.text, edits ?? [])
    })
  if (!actions.length) return
  b.saveTransaction = true
  b.model.pushStackElement()
  try {
    await runSaveActions({
      read: () => current(b),
      apply(before, text) {
        if (current(b)?.version !== before.version || b.model.isDisposed())
          return
        editBuffer(repository, key, text)
        return current(b)
      },
      actions,
      warn(error) {
        notice(errorMessage(error))
        status(b, errorMessage(error))
        void reportDiagnostic(error, "code-editor", "save-actions")
      },
    })
  } finally {
    b.saveTransaction = false
    if (!b.model.isDisposed()) b.model.pushStackElement()
  }
}

export async function restartLiveEditor(key: string, stop = false) {
  const target = [...bindings.values()].find((b) => b.key === key)
  if (!target) return
  const sessionId = target.session?.id
  const group = [...bindings.values()].filter(
    (b) => b === target || (sessionId && b.session?.id === sessionId)
  )
  await Promise.all(group.map((b) => b.pending?.catch(() => {})))
  if (sessionId) await liveCommands.restart(sessionId)
  for (const b of group) {
    b.session = undefined
    forgetPublishedSession(b)
    b.version = 0
    b.path = ""
    b.diagnosticVersion = undefined
    b.diagnosticRequest = undefined
    b.stopped = stop
    refreshProviders(b)
    b.monaco.editor.setModelMarkers(b.model, "reviewbox-lsp", [])
    useLiveLanguages.setState((s) => ({
      capabilities: { ...s.capabilities, [b.key]: {} },
    }))
    status(b, stop ? "Language support stopped" : "Starting language support…")
  }
  if (!stop) await Promise.all(group.map((b) => sync(b)))
}
export function restoreLanguageNavigation(
  editor: M.editor.IStandaloneCodeEditor
) {
  const uri = editor.getModel()?.uri.toString()
  const selection = uri ? navigation.get(uri) : undefined
  if (!uri || !selection) return
  navigation.delete(uri)
  const p =
    "startLineNumber" in selection
      ? { lineNumber: selection.startLineNumber, column: selection.startColumn }
      : selection
  editor.setPosition(p)
  editor.revealPositionInCenter(p)
  editor.focus()
}
export async function searchWorkspaceSymbols(key: string, query: string) {
  const b = [...bindings.values()].find((b) => b.key === key)
  if (!b || !b.session?.capabilities.workspaceSymbolProvider) return []
  const results = await request<L.SymbolInformation[]>(b, "workspace/symbol", {
    query,
  })
  return results ?? []
}
export async function openWorkspaceSymbol(
  key: string,
  symbol: L.SymbolInformation
) {
  const b = [...bindings.values()].find((b) => b.key === key)
  if (!b) return
  const { buffer } = await materialize(b, symbol.location.uri)
  navigation.set(
    `reviewbox-editor://${b.repository}/${buffer.id}`,
    range(symbol.location.range)
  )
  updateEditor(b.repository, (s) => ({
    ...s,
    active: buffer.path,
    buffers: s.buffers.map((item) =>
      item.id === buffer.id ? { ...item, preview: false } : item
    ),
  }))
}

function completionKind(monaco: typeof M, kind?: number) {
  const names = [
    "Text",
    "Method",
    "Function",
    "Constructor",
    "Field",
    "Variable",
    "Class",
    "Interface",
    "Module",
    "Property",
    "Unit",
    "Value",
    "Enum",
    "Keyword",
    "Snippet",
    "Color",
    "File",
    "Reference",
    "Folder",
    "EnumMember",
    "Constant",
    "Struct",
    "Event",
    "Operator",
    "TypeParameter",
  ] as const
  return monaco.languages.CompletionItemKind[names[(kind ?? 1) - 1] ?? "Text"]
}
function setDiagnostics(b: Binding, diagnostics: L.Diagnostic[]) {
  b.monaco.editor.setModelMarkers(
    b.model,
    "reviewbox-lsp",
    diagnostics.map((d) => ({
      ...range(d.range),
      message: d.message,
      source: d.source,
      code: d.code == null ? undefined : String(d.code),
      severity:
        d.severity === 1
          ? b.monaco.MarkerSeverity.Error
          : d.severity === 2
            ? b.monaco.MarkerSeverity.Warning
            : d.severity === 3
              ? b.monaco.MarkerSeverity.Info
              : b.monaco.MarkerSeverity.Hint,
    }))
  )
}
async function pullDiagnostics(b: Binding) {
  const file = current(b)
  if (
    !file ||
    !b.session ||
    b.stopped ||
    b.model.isDisposed() ||
    b.diagnosticVersion === file.version
  )
    return
  const sessionId = b.session.id
  const request = Symbol()
  b.diagnosticRequest = request
  b.diagnosticVersion = file.version
  try {
    const result = await liveCommands.request<L.DocumentDiagnosticReport>(
      sessionId,
      crypto.randomUUID(),
      file.path,
      file.version,
      "textDocument/diagnostic",
      {}
    )
    if (
      b.diagnosticRequest === request &&
      b.session?.id === sessionId &&
      !b.stopped &&
      !b.model.isDisposed() &&
      bindings.get(b.model.uri.toString()) === b &&
      current(b)?.version === file.version &&
      result.kind === "full"
    )
      setDiagnostics(b, result.items)
  } catch (error) {
    if (b.diagnosticRequest === request && b.session?.id === sessionId)
      b.diagnosticVersion = undefined
    throw error
  }
}

export function languageDiagnostic(key: string) {
  const b = [...bindings.values()].find((b) => b.key === key)
  if (!b) return "No running language server."
  return JSON.stringify({
    status: useLiveLanguages.getState().status[key],
    server: b.session?.serverId,
    project: b.session?.rootUri,
    diagnostics: b.monaco.editor
      .getModelMarkers({ resource: b.model.uri })
      .slice(0, 20)
      .map((d) => ({
        message: d.message,
        line: d.startLineNumber,
        source: d.source,
      })),
  })
}
