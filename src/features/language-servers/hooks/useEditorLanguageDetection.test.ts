import { afterEach, expect, test } from "bun:test"
import {
  bufferLanguageDecision,
  getEditor,
  updateBuffer,
  updateEditor,
  useEditorStore,
  type EditorBuffer,
} from "@/features/code-editor/stores/editor.store"
import { acceptLanguagePrediction } from "./useEditorLanguageDetection"

const repository = "language-prediction-test"
const buffer: EditorBuffer = {
  id: "file",
  path: "script",
  uri: "file:///project/script",
  text: "from pathlib import Path",
  baseText: "from pathlib import Path",
  revision: "revision",
  version: 1,
  readOnly: false,
  reason: null,
  preview: false,
}
const prediction = {
  languageId: "python",
  candidates: [{ languageId: "python", confidence: 0.9 }],
}
afterEach(() =>
  useEditorStore.setState((s) => ({
    sessions: Object.fromEntries(
      Object.entries(s.sessions).filter(([id]) => id !== repository)
    ),
  }))
)
function setup() {
  updateEditor(repository, (s) => ({ ...s, buffers: [buffer] }))
}
function accept() {
  acceptLanguagePrediction(
    repository,
    buffer.id,
    { path: buffer.path, version: buffer.version },
    prediction
  )
}

test("a current content prediction applies but never overwrites a manual or associated language", () => {
  setup()
  accept()
  expect(
    bufferLanguageDecision(repository, getEditor(repository).buffers[0])
  ).toMatchObject({ source: "content", language: { id: "python" } })
  updateBuffer(repository, buffer.id, (b) => ({
    ...b,
    language: "plaintext",
    detectedLanguage: undefined,
  }))
  accept()
  expect(getEditor(repository).buffers[0].detectedLanguage).toBeUndefined()
  expect(
    bufferLanguageDecision(repository, getEditor(repository).buffers[0])
  ).toMatchObject({ source: "manual", language: { id: "plaintext" } })
  updateBuffer(repository, buffer.id, (b) => ({ ...b, language: undefined }))
  updateEditor(repository, (s) => ({
    ...s,
    associations: { script: "javascript" },
  }))
  accept()
  expect(getEditor(repository).buffers[0].detectedLanguage).toBeUndefined()
  expect(
    bufferLanguageDecision(repository, getEditor(repository).buffers[0])
  ).toMatchObject({ source: "association", language: { id: "javascript" } })
})

test("late predictions are ignored after edits, rename or close", () => {
  setup()
  updateBuffer(repository, buffer.id, (b) => ({
    ...b,
    version: 2,
    text: "new content",
  }))
  accept()
  expect(getEditor(repository).buffers[0].detectedLanguage).toBeUndefined()
  updateBuffer(repository, buffer.id, (b) => ({
    ...b,
    version: 1,
    path: "renamed",
  }))
  accept()
  expect(getEditor(repository).buffers[0].detectedLanguage).toBeUndefined()
  updateEditor(repository, (s) => ({ ...s, buffers: [] }))
  accept()
  expect(getEditor(repository).buffers).toEqual([])
})

test("project hints preserve explicit choices and reject a late content prediction", () => {
  setup()
  updateBuffer(repository, buffer.id, (b) => ({ ...b, path: "include/api.h" }))
  updateEditor(repository, (s) => ({
    ...s,
    entries: [{ path: "src/main.c", directory: false, revision: "1" }],
  }))
  const current = () => getEditor(repository).buffers[0]
  expect(bufferLanguageDecision(repository, current())).toMatchObject({
    source: "project",
    language: { id: "c" },
  })
  acceptLanguagePrediction(
    repository,
    buffer.id,
    { path: current().path, version: current().version },
    { languageId: "cpp", candidates: [{ languageId: "cpp", confidence: 0.9 }] }
  )
  expect(current().detectedLanguage).toBeUndefined()
  updateBuffer(repository, buffer.id, (b) => ({ ...b, language: "cpp" }))
  expect(bufferLanguageDecision(repository, current())).toMatchObject({
    source: "manual",
    language: { id: "cpp" },
  })
  updateBuffer(repository, buffer.id, (b) => ({ ...b, language: undefined }))
  updateEditor(repository, (s) => ({
    ...s,
    associations: { "*.h": "cpp" },
  }))
  expect(bufferLanguageDecision(repository, current())).toMatchObject({
    source: "association",
    language: { id: "cpp" },
  })
})
