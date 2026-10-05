import { expect, spyOn, test } from "bun:test"
import * as events from "@tauri-apps/api/event"
import type * as Monaco from "monaco-editor/editor/editor.api"
import type * as L from "vscode-languageserver-protocol"
import type { LiveLanguageEvent } from "@/lib/desktop/contracts.generated"
import {
  updateBuffer,
  updateEditor,
  useEditorStore,
  type EditorBuffer,
} from "@/features/code-editor/stores/editor.store"
import {
  bindLiveEditor,
  restartLiveEditor,
  useLiveLanguages,
} from "./liveMonaco"
import { liveCommands } from "./liveLanguage.commands"

let onNativeEvent: events.EventCallback<LiveLanguageEvent> | undefined
const markers = new Map<string, Monaco.editor.IMarkerData[]>()
const tokenRefreshes = new Map<string, number>()
const monaco = {
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  Emitter: class<T> {
    listeners = new Set<(value: T) => void>()
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener)
      return { dispose: () => this.listeners.delete(listener) }
    }
    fire(value: T) {
      for (const listener of this.listeners) listener(value)
    }
    dispose() {
      this.listeners.clear()
    }
  },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  editor: {
    registerEditorOpener() {},
    registerCommand() {},
    setModelLanguage: (
      model: { setLanguage(value: string): void },
      value: string
    ) => model.setLanguage(value),
    setModelMarkers(
      model: Monaco.editor.ITextModel,
      _owner: string,
      value: Monaco.editor.IMarkerData[]
    ) {
      markers.set(model.uri.toString(), value)
    },
  },
  languages: {
    registerDocumentSemanticTokensProvider(
      selector: { pattern: string },
      provider: Monaco.languages.DocumentSemanticTokensProvider
    ) {
      const subscription = provider.onDidChange?.(() =>
        tokenRefreshes.set(
          selector.pattern,
          (tokenRefreshes.get(selector.pattern) ?? 0) + 1
        )
      )
      return {
        dispose() {
          subscription?.dispose()
        },
      }
    },
  },
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const listenForEvents = () =>
  spyOn(events, "listen").mockImplementation(async (_name, handler) => {
    onNativeEvent = handler as events.EventCallback<LiveLanguageEvent>
    return () => {}
  })

test("detecting an initially unknown file starts its language session without requiring Restart", async () => {
  const repository = `live-detection-${crypto.randomUUID()}`
  const buffer: EditorBuffer = {
    id: "file",
    path: "script",
    uri: `file:///${repository}/script`,
    text: "from pathlib import Path",
    baseText: "from pathlib import Path",
    version: 1,
    revision: "revision",
    readOnly: false,
    reason: null,
    preview: false,
  }
  const listen = listenForEvents()
  const open = spyOn(liveCommands, "open").mockImplementation(
    async (_, __, language) => {
      if (language === "plaintext") throw new Error("No server for plain text")
      return {
        id: `${repository}-session`,
        serverId: "python",
        rootUri: `file:///${repository}`,
        capabilities: {},
        context: {
          rootUri: `file:///${repository}`,
          configurationFiles: [],
          environment: {},
          missing: [],
          signature: "context",
        },
      }
    }
  )
  const sync = spyOn(liveCommands, "sync").mockResolvedValue(undefined)
  const close = spyOn(liveCommands, "close").mockResolvedValue(undefined)
  let language = "plaintext"
  let disposed = false
  const model = {
    uri: {
      scheme: "reviewbox-editor",
      path: "/file",
      toString: () => `reviewbox-editor://${repository}/file`,
    },
    getLanguageId: () => language,
    setLanguage: (value: string) => {
      language = value
    },
    getValue: () => buffer.text,
    isDisposed: () => disposed,
    onDidChangeContent: () => ({ dispose() {} }),
    dispose: () => {
      disposed = true
    },
  }
  try {
    updateEditor(repository, (s) => ({ ...s, ready: true, buffers: [buffer] }))
    bindLiveEditor(
      monaco as unknown as typeof Monaco,
      model as unknown as Monaco.editor.ITextModel,
      repository,
      buffer
    )
    await settle()
    expect(open.mock.calls.map((args) => args[2])).toEqual(["plaintext"])
    expect(sync).not.toHaveBeenCalled()
    updateBuffer(repository, buffer.id, (b) => ({
      ...b,
      detectedLanguage: {
        path: b.path,
        version: b.version,
        languageId: "python",
        candidates: [],
      },
    }))
    await settle()
    expect(language).toBe("python")
    expect(open.mock.calls.map((args) => args[2])).toEqual([
      "plaintext",
      "python",
    ])
    expect(sync.mock.calls[0]?.[1]).toMatchObject({
      languageId: "python",
      text: buffer.text,
      version: 1,
    })
    expect(useLiveLanguages.getState().status[buffer.id]).toBe(
      "Language support active"
    )
  } finally {
    useEditorStore.setState((s) => ({
      sessions: Object.fromEntries(
        Object.entries(s.sessions).filter(([id]) => id !== repository)
      ),
    }))
    await settle()
    listen.mockRestore()
    open.mockRestore()
    sync.mockRestore()
    close.mockRestore()
  }
})

test("server refreshes stay scoped and old diagnostics cannot overwrite a refreshed or restarted session", async () => {
  const listen = listenForEvents()
  let generation = 0
  const pending: {
    session: string
    resolve: (value: L.DocumentDiagnosticReport) => void
    reject: (error: Error) => void
  }[] = []
  const request = spyOn(liveCommands, "request").mockImplementation(
    (session) =>
      new Promise<L.DocumentDiagnosticReport>((resolve, reject) =>
        pending.push({ session, resolve, reject })
      ) as never
  )
  const open = spyOn(liveCommands, "open").mockImplementation(
    async (repository) => ({
      id: `${repository}-${generation}`,
      serverId: "typescript",
      rootUri: `file:///${repository}`,
      capabilities: {
        diagnosticProvider: {},
        semanticTokensProvider: {
          full: true,
          legend: { tokenTypes: [], tokenModifiers: [] },
        },
      },
      context: {
        rootUri: `file:///${repository}`,
        configurationFiles: [],
        environment: {},
        missing: [],
        signature: "test",
      },
    })
  )
  const sync = spyOn(liveCommands, "sync").mockResolvedValue(undefined)
  const close = spyOn(liveCommands, "close").mockResolvedValue(undefined)
  const restart = spyOn(liveCommands, "restart").mockImplementation(
    async () => {
      generation++
    }
  )
  const fixtures = ["a", "b"].map((name) => {
    const repository = `analysis-${name}-${crypto.randomUUID()}`
    const id = crypto.randomUUID()
    const buffer: EditorBuffer = {
      id,
      path: "main.ts",
      uri: `file:///${repository}/main.ts`,
      text: "const value = 1",
      baseText: "const value = 1",
      version: 1,
      revision: "disk",
      readOnly: false,
      reason: null,
      preview: false,
    }
    let disposed = false
    const model = {
      uri: {
        scheme: "reviewbox-editor",
        path: `/${id}`,
        toString: () => `reviewbox-editor://${repository}/${id}`,
      },
      getLanguageId: () => "typescript",
      getValue: () => buffer.text,
      isDisposed: () => disposed,
      onDidChangeContent: () => ({ dispose() {} }),
      dispose() {
        disposed = true
      },
    }
    return { repository, buffer, model }
  })
  const emit = (sessionId: string, method: string) =>
    onNativeEvent?.({
      event: "reviewbox:live-language",
      id: 1,
      payload: { sessionId, method, params: {} },
    })
  const report = (message: string): L.DocumentDiagnosticReport => ({
    kind: "full",
    items: [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        message,
      },
    ],
  })
  try {
    for (const f of fixtures) {
      updateEditor(f.repository, (s) => ({
        ...s,
        ready: true,
        buffers: [f.buffer],
      }))
      bindLiveEditor(
        monaco as unknown as typeof Monaco,
        f.model as unknown as Monaco.editor.ITextModel,
        f.repository,
        f.buffer
      )
      await settle()
    }
    const [a, b] = fixtures
    const session = useLiveLanguages.getState().sessions[a.buffer.id].id
    expect(pending).toHaveLength(2)
    emit(session, "workspace/semanticTokens/refresh")
    expect(tokenRefreshes.get(a.model.uri.path)).toBe(1)
    expect(tokenRefreshes.get(b.model.uri.path)).toBeUndefined()
    emit(session, "workspace/diagnostic/refresh")
    expect(pending).toHaveLength(3)
    pending[2].resolve(report("fresh"))
    await settle()
    pending[0].resolve(report("stale before refresh"))
    await settle()
    expect(markers.get(a.model.uri.toString())?.[0].message).toBe("fresh")
    emit(session, "workspace/diagnostic/refresh")
    pending[3].reject(new Error("temporary failure"))
    await settle()
    emit(session, "workspace/diagnostic/refresh")
    expect(pending).toHaveLength(5)
    const stale = pending[4]
    await restartLiveEditor(a.buffer.id)
    const restarted = useLiveLanguages.getState().sessions[a.buffer.id].id
    expect(restarted).not.toBe(session)
    expect(pending.at(-1)?.session).toBe(restarted)
    pending.at(-1)!.resolve(report("new generation"))
    await settle()
    stale.resolve(report("stale generation"))
    await settle()
    expect(markers.get(a.model.uri.toString())?.[0].message).toBe(
      "new generation"
    )
    emit(session, "workspace/diagnostic/refresh")
    expect(pending).toHaveLength(6)
    pending[1].resolve(report("other project"))
    await settle()
    expect(markers.get(b.model.uri.toString())?.[0].message).toBe(
      "other project"
    )
    open.mockRejectedValue(new Error("Server could not restart"))
    await expect(restartLiveEditor(a.buffer.id)).rejects.toThrow(
      "Server could not restart"
    )
    expect(useLiveLanguages.getState().sessions[a.buffer.id]).toBeUndefined()
  } finally {
    const repositories = new Set(fixtures.map((f) => f.repository))
    useEditorStore.setState((s) => ({
      sessions: Object.fromEntries(
        Object.entries(s.sessions).filter(([id]) => !repositories.has(id))
      ),
    }))
    await settle()
    for (const spy of [listen, request, open, sync, close, restart])
      spy.mockRestore()
    for (const fixture of fixtures)
      expect(
        useLiveLanguages.getState().sessions[fixture.buffer.id]
      ).toBeUndefined()
  }
})
