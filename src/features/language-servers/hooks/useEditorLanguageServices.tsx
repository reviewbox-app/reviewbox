"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { listen } from "@tauri-apps/api/event"
import type * as Monaco from "monaco-editor/editor/editor.api"
import type {
  LanguageDocument,
  LanguageLocation,
  LanguageMethod,
  LanguageResponse,
  LanguageSymbol,
} from "@/lib/desktop/contracts.generated"
import { resolveCodeLanguage } from "@/lib/code/languages"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import { languageSessionCommands } from "../services/languageSession.commands"
import {
  monacoRange,
  remapSemanticTokens,
  semanticTokenModifiers,
  semanticTokenTypes,
} from "../helpers/languageTokens"
import {
  SourceExplorationDialog,
  type SourceExploration,
} from "../components/SourceExplorationDialog"
import { LanguageAnalysisNote } from "../components/LanguageAnalysisNote"

type Editor =
  Monaco.editor.IStandaloneCodeEditor | Monaco.editor.IStandaloneDiffEditor
type MonacoInstance = typeof Monaco
interface Owner {
  alive: boolean
  id: string
  requests: Set<string>
  models: Set<Monaco.editor.ITextModel>
  targetDisposers: (() => void)[]
  targetKeys: Set<string>
  open: (value: SourceExploration) => void
  status: (note: string | null) => void
}
interface Binding {
  document: LanguageDocument
  model: Monaco.editor.ITextModel
  owner: Owner
}
const bindings = new Map<string, Binding>()
const targets = new Map<string, LanguageLocation>()
const installed = new WeakSet<MonacoInstance>()
let refreshSemanticTokens: (() => void) | undefined
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
let observers = 0
let changedListener: Promise<() => void> | undefined

function observeServerChanges() {
  if (!desktopAvailable()) return
  observers++
  if (!changedListener)
    changedListener = listen("reviewbox:language-servers-changed", () =>
      refreshSemanticTokens?.()
    )
  void changedListener.catch(() => {})
  return () => {
    if (--observers === 0 && changedListener) {
      void changedListener.then((dispose) => dispose()).catch(() => {})
      changedListener = undefined
    }
  }
}

function bind(
  model: Monaco.editor.ITextModel,
  document: LanguageDocument,
  owner: Owner
) {
  const timer = releaseTimers.get(document.snapshotId)
  if (timer) clearTimeout(timer)
  releaseTimers.delete(document.snapshotId)
  const binding = { model, document, owner }
  bindings.set(model.uri.toString(), binding)
  refreshSemanticTokens?.()
  return () => {
    if (bindings.get(model.uri.toString()) === binding)
      bindings.delete(model.uri.toString())
    if (
      ![...bindings.values()].some(
        (item) => item.document.snapshotId === document.snapshotId
      )
    ) {
      const pending = releaseTimers.get(document.snapshotId)
      if (pending) clearTimeout(pending)
      const timeout = setTimeout(() => {
        releaseTimers.delete(document.snapshotId)
        if (
          [...bindings.values()].some(
            (item) => item.document.snapshotId === document.snapshotId
          )
        )
          return
        void languageSessionCommands
          .release(document.snapshotId)
          .catch(() => {})
      }, 250)
      releaseTimers.set(document.snapshotId, timeout)
    }
  }
}

async function query(
  binding: Binding,
  method: LanguageMethod,
  position?: Monaco.Position,
  cancellation?: Monaco.CancellationToken
): Promise<LanguageResponse | null> {
  const { owner, model, document } = binding
  if (
    !owner.alive ||
    model.isDisposed() ||
    cancellation?.isCancellationRequested
  )
    return null
  const version = model.getVersionId()
  const requestId = crypto.randomUUID()
  owner.requests.add(requestId)
  const subscription = cancellation?.onCancellationRequested(() => {
    void languageSessionCommands.cancel(requestId).catch(() => {})
  })
  try {
    const result = await languageSessionCommands.request({
      requestId,
      document,
      method,
      line: position?.lineNumber ?? null,
      column: position?.column ?? null,
    })
    if (
      !owner.alive ||
      model.isDisposed() ||
      model.getVersionId() !== version ||
      cancellation?.isCancellationRequested ||
      bindings.get(model.uri.toString()) !== binding ||
      result.requestId !== requestId ||
      result.contentHash !== document.contentHash
    )
      return null
    owner.status(result.analysisNote)
    return result
  } catch (error) {
    if (
      owner.alive &&
      bindings.get(model.uri.toString()) === binding &&
      !cancellation?.isCancellationRequested
    )
      owner.status(errorMessage(error))
    throw error
  } finally {
    subscription?.dispose()
    owner.requests.delete(requestId)
  }
}

function targetUri(
  monaco: MonacoInstance,
  location: LanguageLocation,
  owner: Owner
) {
  return monaco.Uri.from({
    scheme: "reviewbox-language",
    authority: owner.id,
    path: `/${location.document.snapshotId}/${location.document.changeId ?? "context"}/${location.document.side ?? "current"}/${location.document.path}`,
    query: location.document.contentHash,
  })
}

async function materialize(
  monaco: MonacoInstance,
  binding: Binding,
  locations: LanguageLocation[]
) {
  const unique = new Map<string, LanguageLocation>()
  for (const location of locations)
    unique.set(targetUri(monaco, location, binding.owner).toString(), location)
  await Promise.all(
    [...unique].map(async ([key, location]) => {
      if (
        !binding.owner.alive ||
        bindings.get(binding.model.uri.toString()) !== binding
      )
        return
      targets.set(key, location)
      binding.owner.targetKeys.add(key)
      const uri = monaco.Uri.parse(key)
      if (monaco.editor.getModel(uri)) return
      const source = await languageSessionCommands.source(location.document)
      if (
        !binding.owner.alive ||
        bindings.get(binding.model.uri.toString()) !== binding
      )
        return
      // Concurrent definition/reference requests may resolve the same captured file.
      if (monaco.editor.getModel(uri)) return
      const model = monaco.editor.createModel(
        source,
        resolveCodeLanguage(location.document.path).id,
        uri
      )
      binding.owner.models.add(model)
      binding.owner.targetDisposers.push(
        bind(model, location.document, binding.owner)
      )
    })
  )
  if (
    !binding.owner.alive ||
    bindings.get(binding.model.uri.toString()) !== binding
  )
    return []
  return locations.map((location) => ({
    uri: targetUri(monaco, location, binding.owner),
    range: monacoRange(location.range),
  }))
}

function symbols(items: LanguageSymbol[]): Monaco.languages.DocumentSymbol[] {
  return items.map((item) => ({
    name: item.name,
    detail: item.detail ?? "",
    kind: Math.max(0, Math.min(25, item.kind - 1)),
    tags: [],
    range: monacoRange(item.location.range),
    selectionRange: monacoRange(item.location.range),
    children: symbols(item.children),
  }))
}

function installProviders(monaco: MonacoInstance) {
  if (installed.has(monaco)) return
  installed.add(monaco)
  const semanticChanges = new monaco.Emitter<void>()
  refreshSemanticTokens = () => semanticChanges.fire()
  monaco.languages.registerDocumentSemanticTokensProvider("*", {
    onDidChange: semanticChanges.event,
    getLegend: () => ({
      tokenTypes: semanticTokenTypes,
      tokenModifiers: semanticTokenModifiers,
    }),
    releaseDocumentSemanticTokens: () => {},
    async provideDocumentSemanticTokens(model, _lastResultId, token) {
      const binding = bindings.get(model.uri.toString())
      if (!binding) return null
      try {
        const response = await query(
          binding,
          "semanticTokens",
          undefined,
          token
        )
        if (!response?.tokens) return null
        return {
          data: remapSemanticTokens(
            response.tokens,
            model.getLinesContent().map((line) => line.length)
          ),
        }
      } catch {
        return null
      }
    },
  })
  monaco.languages.registerHoverProvider("*", {
    async provideHover(model, position, token) {
      const binding = bindings.get(model.uri.toString())
      if (!binding) return null
      try {
        const response = await query(binding, "hover", position, token)
        if (!response?.hover) return null
        return {
          contents: [
            {
              value: response.hover.markdown,
              isTrusted: false,
              supportHtml: false,
            },
          ],
          range: response.hover.range
            ? monacoRange(response.hover.range)
            : undefined,
        }
      } catch {
        return null
      }
    },
  })
  monaco.languages.registerDefinitionProvider("*", {
    async provideDefinition(model, position, token) {
      const binding = bindings.get(model.uri.toString())
      if (!binding) return null
      try {
        const response = await query(binding, "definitions", position, token)
        return response
          ? await materialize(monaco, binding, response.locations)
          : null
      } catch {
        return null
      }
    },
  })
  monaco.languages.registerReferenceProvider("*", {
    async provideReferences(model, position, _context, token) {
      const binding = bindings.get(model.uri.toString())
      if (!binding) return []
      try {
        const response = await query(binding, "references", position, token)
        return response
          ? await materialize(monaco, binding, response.locations)
          : []
      } catch {
        return []
      }
    },
  })
  monaco.languages.registerDocumentSymbolProvider("*", {
    displayName: "Captured source",
    async provideDocumentSymbols(model, token) {
      const binding = bindings.get(model.uri.toString())
      if (!binding) return []
      try {
        const response = await query(binding, "symbols", undefined, token)
        return response ? symbols(response.symbols) : []
      } catch {
        return []
      }
    },
  })
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selection) {
      const binding =
        source.getModel() && bindings.get(source.getModel()!.uri.toString())
      const location = targets.get(resource.toString())
      if (!binding || !location) return false
      const range =
        selection && "startLineNumber" in selection
          ? {
              startLine: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLine: selection.endLineNumber,
              endColumn: selection.endColumn,
            }
          : location.range
      binding.owner.open({
        id: crypto.randomUUID(),
        title: "Captured source",
        locations: [{ ...location, range }],
      })
      return true
    },
  })
}

/** One owner cancels requests and releases model bindings when its editor leaves. */
export function useEditorLanguageServices(
  document?: LanguageDocument,
  secondaryDocument?: LanguageDocument
) {
  const [exploration, setExploration] = useState<SourceExploration | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [noteTarget, setNoteTarget] = useState<HTMLElement | null>(null)
  const documents = useRef({ document, secondaryDocument })
  const refresh = useRef<(() => void) | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const key = JSON.stringify([document, secondaryDocument])
  useEffect(observeServerChanges, [])
  useEffect(() => {
    if (
      JSON.stringify([
        documents.current.document,
        documents.current.secondaryDocument,
      ]) === key
    )
      return
    documents.current = { document, secondaryDocument }
    refresh.current?.()
  }, [key, document, secondaryDocument])
  useEffect(
    () => () => {
      cleanup.current?.()
      cleanup.current = null
      refresh.current = null
    },
    []
  )
  const onMount = useCallback((editor: Editor, monaco: MonacoInstance) => {
    cleanup.current?.()
    installProviders(monaco)
    const owner: Owner = {
      alive: true,
      id: crypto.randomUUID(),
      requests: new Set(),
      models: new Set(),
      targetDisposers: [],
      targetKeys: new Set(),
      open: setExploration,
      status: setNote,
    }
    let unbind: (() => void)[] = []
    const editors =
      "getOriginalEditor" in editor
        ? [editor.getOriginalEditor(), editor.getModifiedEditor()]
        : [editor]
    const statusEditor = editors.at(-1)!
    const statusNode =
      typeof globalThis.document === "undefined"
        ? null
        : globalThis.document.createElement("div")
    if (statusNode) {
      // Monaco measures overlay height before the asynchronous note arrives.
      statusNode.style.width = "40px"
      statusNode.style.height = "40px"
      statusNode.style.pointerEvents = "none"
    }
    const statusWidget = statusNode
      ? {
          getId: () => `reviewbox.language-status.${owner.id}`,
          getDomNode: () => statusNode,
          getPosition: () => ({
            preference:
              monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER,
          }),
        }
      : null
    const positionStatus = () => {
      if (!statusNode || !statusWidget) return
      const padding = statusEditor.getOption(monaco.editor.EditorOption.padding)
      const bottom = Math.max(0, padding.bottom - 8)
      statusNode.style.height = `${40 + bottom}px`
      statusNode.style.paddingBottom = `${bottom}px`
      statusNode.style.boxSizing = "border-box"
      statusEditor.layoutOverlayWidget(statusWidget)
    }
    let statusLayout: Monaco.IDisposable | undefined
    if (statusWidget) {
      statusEditor.addOverlayWidget(statusWidget)
      positionStatus()
      statusLayout = statusEditor.onDidChangeConfiguration((event) => {
        if (event.hasChanged(monaco.editor.EditorOption.padding))
          positionStatus()
      })
      setNoteTarget(statusNode)
    }
    const connect = () => {
      setNote(null)
      for (const dispose of unbind) dispose()
      unbind = []
      for (const [index, codeEditor] of editors.entries()) {
        const current = index
          ? documents.current.secondaryDocument
          : documents.current.document
        const model = codeEditor.getModel()
        if (
          current &&
          model &&
          model.getLanguageId() !== "reviewbox-pseudocode"
        )
          unbind.push(bind(model, current, owner))
      }
    }
    refresh.current = connect
    const listeners = editors.map((codeEditor) =>
      codeEditor.onDidChangeModel(connect)
    )
    const actions = editors.flatMap((codeEditor) =>
      (["definitions", "references"] as const).map((method) =>
        codeEditor.addAction({
          id: `reviewbox.${method}`,
          label:
            method === "definitions"
              ? "Explore captured definitions"
              : "Explore captured references",
          keybindings: [
            method === "definitions"
              ? monaco.KeyCode.F12
              : monaco.KeyMod.Shift | monaco.KeyCode.F12,
          ],
          contextMenuGroupId: "navigation",
          contextMenuOrder: method === "definitions" ? 1 : 2,
          async run() {
            const model = codeEditor.getModel()
            const position = codeEditor.getPosition()
            const binding = model && bindings.get(model.uri.toString())
            if (!binding || !position) return
            const title =
              method === "definitions" ? "Definitions" : "References"
            try {
              const response = await query(binding, method, position)
              if (response)
                owner.open({
                  id: response.requestId,
                  title,
                  locations: response.locations,
                })
            } catch (error) {
              if (owner.alive)
                owner.open({
                  id: crypto.randomUUID(),
                  title,
                  locations: [],
                  error: errorMessage(error),
                })
            }
          },
        })
      )
    )
    connect()
    cleanup.current = () => {
      if (!owner.alive) return
      owner.alive = false
      if (statusWidget) statusEditor.removeOverlayWidget(statusWidget)
      statusLayout?.dispose()
      for (const listener of [...listeners, ...actions]) listener.dispose()
      for (const requestId of owner.requests)
        void languageSessionCommands.cancel(requestId).catch(() => {})
      for (const dispose of unbind) dispose()
      for (const dispose of owner.targetDisposers) dispose()
      for (const key of owner.targetKeys) targets.delete(key)
      for (const model of owner.models) {
        bindings.delete(model.uri.toString())
        targets.delete(model.uri.toString())
        model.dispose()
      }
      owner.models.clear()
    }
    return cleanup.current
  }, [])
  return {
    onMount,
    exploration: (
      <>
        {note && noteTarget
          ? createPortal(<LanguageAnalysisNote note={note} />, noteTarget)
          : null}
        {exploration ? (
          <SourceExplorationDialog
            key={exploration.id}
            value={exploration}
            onClose={() => setExploration(null)}
          />
        ) : null}
      </>
    ),
  }
}
