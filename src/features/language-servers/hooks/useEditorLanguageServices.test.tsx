import { afterEach, expect, spyOn, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type * as Monaco from "monaco-editor/editor/editor.api"
import type {
  LanguageDocument,
  LanguageResponse,
} from "@/lib/desktop/contracts.generated"
import { useEditorLanguageServices } from "./useEditorLanguageServices"
import { languageSessionCommands } from "../services/languageSession.commands"

const document: LanguageDocument = {
  snapshotId: "snapshot",
  path: "src/main.ts",
  changeId: "change",
  side: "before",
  contentHash: "captured-before-hash",
}
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

function fixture(language = "typescript") {
  let services: ReturnType<typeof useEditorLanguageServices> | undefined
  function Probe() {
    services = useEditorLanguageServices(document)
    return null
  }
  renderToStaticMarkup(<Probe />)
  const provider: {
    semantic?: Monaco.languages.DocumentSemanticTokensProvider
    hover?: Monaco.languages.HoverProvider
    definitions?: Monaco.languages.DefinitionProvider
  } = {}
  let version = 1
  const model = {
    uri: { toString: () => `reviewbox://${crypto.randomUUID()}` },
    getVersionId: () => version,
    isDisposed: () => false,
    getLanguageId: () => language,
    getLinesContent: () => ["const value = 42"],
  }
  const uri = `reviewbox://${crypto.randomUUID()}`
  model.uri.toString = () => uri
  const noopDispose = () => ({ dispose() {} })
  const editor = {
    getModel: () => model,
    onDidChangeModel: noopDispose,
    addAction: noopDispose,
  }
  class Emitter {
    event = () => ({ dispose() {} })
    fire() {}
  }
  const created: {
    uri: Monaco.Uri
    source: string
    language: string
    disposed: boolean
  }[] = []
  const models = new Map<string, object>()
  const makeUri = (text: string) => ({ toString: () => text })
  const monaco = {
    Emitter,
    Uri: {
      from: (parts: object) => makeUri(JSON.stringify(parts)),
      parse: makeUri,
    },
    KeyCode: { F12: 12 },
    KeyMod: { Shift: 1024 },
    languages: {
      registerDocumentSemanticTokensProvider: (
        _selector: string,
        value: Monaco.languages.DocumentSemanticTokensProvider
      ) => {
        provider.semantic = value
      },
      registerHoverProvider: (
        _selector: string,
        value: Monaco.languages.HoverProvider
      ) => {
        provider.hover = value
      },
      registerDefinitionProvider(
        _selector: string,
        value: Monaco.languages.DefinitionProvider
      ) {
        provider.definitions = value
      },
      registerReferenceProvider() {},
      registerDocumentSymbolProvider() {},
    },
    editor: {
      registerEditorOpener() {},
      getModel(uri: Monaco.Uri) {
        return models.get(uri.toString())
      },
      createModel(source: string, language: string, uri: Monaco.Uri) {
        const data = { source, language, uri, disposed: false }
        created.push(data)
        const model = {
          uri,
          isDisposed: () => data.disposed,
          dispose() {
            data.disposed = true
            models.delete(uri.toString())
          },
        }
        models.set(uri.toString(), model)
        return model
      },
    },
  }
  const dispose = services!.onMount(
    editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    monaco as unknown as typeof Monaco
  )
  disposers.push(dispose)
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: noopDispose,
  }
  return {
    model: model as unknown as Monaco.editor.ITextModel,
    provider,
    token,
    dispose,
    created,
    changeVersion: () => version++,
  }
}

function response(requestId: string): LanguageResponse {
  return {
    requestId,
    contentHash: document.contentHash,
    serverId: "typescript",
    analysisNote: null,
    capabilities: {
      semanticTokens: true,
      hover: true,
      definitions: true,
      references: true,
      symbols: true,
    },
    tokens: {
      tokenTypes: ["variable"],
      tokenModifiers: [],
      data: [0, 6, 5, 0, 0],
    },
    locations: [],
    symbols: [],
    hover: { markdown: "**Captured value**", range: null },
  }
}

test("semantic requests use the captured side and reject a changed model or wrong content hash", async () => {
  const f = fixture()
  let finish: ((value: LanguageResponse) => void) | undefined
  let id = ""
  const request = spyOn(languageSessionCommands, "request").mockImplementation(
    (value) => {
      expect(value.document).toEqual(document)
      id = value.requestId
      return new Promise((resolve) => {
        finish = resolve
      })
    }
  )
  try {
    const pending = f.provider.semantic!.provideDocumentSemanticTokens(
      f.model,
      null,
      f.token
    )
    f.changeVersion()
    finish!(response(id))
    expect(await pending).toBeNull()
    const next = f.provider.semantic!.provideDocumentSemanticTokens(
      f.model,
      null,
      f.token
    )
    finish!({ ...response(id), contentHash: "different" })
    expect(await next).toBeNull()
  } finally {
    request.mockRestore()
  }
})

test("multiple definition targets load exact captured sources and release only their owned models", async () => {
  const f = fixture()
  const locations = ["src/first.ts", "src/second.ts"].map((path) => ({
    document: { ...document, path, contentHash: `${path}-captured` },
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 7 },
  }))
  const request = spyOn(languageSessionCommands, "request").mockImplementation(
    async (value) => ({ ...response(value.requestId), locations })
  )
  const source = spyOn(languageSessionCommands, "source").mockImplementation(
    async (value) =>
      `export const captured = ${JSON.stringify(value.contentHash)}`
  )
  try {
    const results = await f.provider.definitions!.provideDefinition(
      f.model,
      { lineNumber: 1, column: 7 } as Monaco.Position,
      f.token
    )
    expect(Array.isArray(results) && results.length).toBe(2)
    expect(source.mock.calls.map(([value]) => value)).toEqual(
      locations.map((location) => location.document)
    )
    expect(f.created.map((model) => model.language)).toEqual([
      "typescript",
      "typescript",
    ])
    expect(f.created[0].uri.toString()).toContain("/change/before/src/first.ts")
    expect(f.created.every((model) => !model.disposed)).toBe(true)
    f.dispose()
    expect(f.created.every((model) => model.disposed)).toBe(true)
    expect(f.model.isDisposed()).toBe(false)
  } finally {
    request.mockRestore()
    source.mockRestore()
  }
})

test("disposing an editor cancels native work and prevents a late result", async () => {
  const f = fixture()
  let finish: ((value: LanguageResponse) => void) | undefined
  let id = ""
  const request = spyOn(languageSessionCommands, "request").mockImplementation(
    (value) => {
      id = value.requestId
      return new Promise((resolve) => {
        finish = resolve
      })
    }
  )
  const cancel = spyOn(languageSessionCommands, "cancel").mockResolvedValue(
    undefined
  )
  try {
    const pending = f.provider.semantic!.provideDocumentSemanticTokens(
      f.model,
      null,
      f.token
    )
    f.dispose()
    expect(cancel).toHaveBeenCalledWith(id)
    finish!(response(id))
    expect(await pending).toBeNull()
  } finally {
    request.mockRestore()
    cancel.mockRestore()
  }
})

test("hover Markdown stays untrusted and pseudo-code never invokes a source language server", async () => {
  const f = fixture()
  const request = spyOn(languageSessionCommands, "request").mockImplementation(
    async (value) => response(value.requestId)
  )
  try {
    const hover = await f.provider.hover!.provideHover(
      f.model,
      { lineNumber: 1, column: 7 } as Monaco.Position,
      f.token
    )
    expect(hover?.contents[0]).toEqual({
      value: "**Captured value**",
      isTrusted: false,
      supportHtml: false,
    })
    const pseudo = fixture("reviewbox-pseudocode")
    const count = request.mock.calls.length
    expect(
      await pseudo.provider.semantic!.provideDocumentSemanticTokens(
        pseudo.model,
        null,
        pseudo.token
      )
    ).toBeNull()
    expect(request.mock.calls).toHaveLength(count)
  } finally {
    request.mockRestore()
  }
})
