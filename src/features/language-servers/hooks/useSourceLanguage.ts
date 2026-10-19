import { useEffect, useState } from "react"
import { detectCodeLanguage } from "@/lib/code/languages"
import { useLanguageRegistry } from "../services/languageRegistry.service"
import { contentLanguageDetection } from "../services/languageDetection.service"
import { languagePrediction } from "../helpers/languageDetection"

/** Read-only sources use the same registry, shebang rules and local detector. */
export function useSourceLanguage(
  path: string | undefined,
  text: string,
  fallback: string | undefined
) {
  useLanguageRegistry((state) => state.registry)
  const decision = path
    ? detectCodeLanguage(path, text.split("\n", 1)[0])
    : undefined
  const sample = text.slice(0, 100_000)
  const [prediction, setPrediction] = useState<{
    path: string
    sample: string
    language?: string
  }>()
  const needsDetection = !!path && decision?.source === "plaintext"
  useEffect(() => {
    if (!path || !needsDetection) return
    const controller = new AbortController()
    void contentLanguageDetection
      .detect(sample, controller.signal)
      .then((results) => {
        if (!controller.signal.aborted)
          setPrediction({
            path,
            sample,
            language: languagePrediction(results).languageId,
          })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [path, sample, needsDetection])
  if (!path) return fallback
  if (!needsDetection) return decision?.language.id ?? fallback
  return prediction?.path === path && prediction.sample === sample
    ? (prediction.language ?? "plaintext")
    : "plaintext"
}
