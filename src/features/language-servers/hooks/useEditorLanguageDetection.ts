"use client"
import { useEffect } from "react"
import {
  fileAssociation,
  getEditor,
  updateBuffer,
  useEditorStore,
  type EditorBuffer,
} from "@/features/code-editor/stores/editor.store"
import { languagePrediction } from "../helpers/languageDetection"
import { detectProjectLanguage } from "../helpers/projectLanguage"
import { contentLanguageDetection } from "../services/languageDetection.service"
import { useLanguageRegistry } from "../services/languageRegistry.service"

export function acceptLanguagePrediction(
  repository: string,
  id: string,
  snapshot: { path: string; version: number },
  prediction: ReturnType<typeof languagePrediction> & { error?: string }
) {
  updateBuffer(repository, id, (current) => {
    const session = getEditor(repository)
    if (
      current.path !== snapshot.path ||
      current.version !== snapshot.version ||
      current.language ||
      session?.associations[fileAssociation(snapshot.path)] ||
      detectProjectLanguage(
        current.path,
        current.text.split("\n", 1)[0],
        session?.entries ?? []
      ).source !== "plaintext"
    )
      return current
    return { ...current, detectedLanguage: { ...prediction, ...snapshot } }
  })
}

/** Only the displayed ambiguous buffer asks the local model for a prediction. */
export function useEditorLanguageDetection(
  repository: string,
  buffer: EditorBuffer
) {
  const registry = useLanguageRegistry((state) => state.registry)
  const entries = useEditorStore((state) => state.sessions[repository]?.entries)
  const association = useEditorStore(
    (state) =>
      state.sessions[repository]?.associations[fileAssociation(buffer.path)]
  )
  const { id, path, text, version, language } = buffer
  useEffect(() => {
    if (
      language ||
      association ||
      detectProjectLanguage(path, text.split("\n", 1)[0], entries ?? [])
        .source !== "plaintext"
    )
      return
    const controller = new AbortController()
    const apply = (
      prediction: ReturnType<typeof languagePrediction> & { error?: string }
    ) => {
      if (controller.signal.aborted) return
      acceptLanguagePrediction(repository, id, { path, version }, prediction)
    }
    const timer = setTimeout(() => {
      void contentLanguageDetection
        .detect(text, controller.signal)
        .then((results) => apply(languagePrediction(results)))
        .catch((error: unknown) =>
          apply({
            candidates: [],
            languageId: undefined,
            error:
              error instanceof Error
                ? error.message
                : "Language detection unavailable",
          })
        )
    }, 800)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [
    repository,
    id,
    path,
    text,
    version,
    language,
    association,
    registry,
    entries,
  ])
}
