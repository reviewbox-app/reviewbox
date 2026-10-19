"use client"

import { bindSelectionSearch } from "../services/selectionSearch"
import { useSourceInspection } from "@/features/language-servers/hooks/useSourceInspection"
import Editor from "@monaco-editor/react"
import { useEffect, useLayoutEffect, useRef } from "react"
import styles from "./editor-surface.module.css"
import { useTheme } from "next-themes"
import { useCodeTheme, codeEditorOptions } from "@/lib/code/codeAppearance"
import { ensureCodeLanguage } from "@/lib/code/highlighter"
import { useEditorLanguageServices } from "@/features/language-servers/hooks/useEditorLanguageServices"

import { bindReadOnlyFeatures } from "@/features/editor-extensions/services/readOnlyFeatures"
import { bindChangeDecorations } from "../services/changeDecorations"
import "./change-decorations.css"

import { useSourceLanguage } from "@/features/language-servers/hooks/useSourceLanguage"

import type { CodeEditorProps } from "../contracts/codeEditor.types"

export function CodeEditorRuntime(props: CodeEditorProps) {
  const {
    languageDocument,
    inspectionDocument,
    changeBaseline,
    sourcePath,
    overlayTop = 0,
    ...editorProps
  } = props
  const selectionSearch = useRef<{ dispose(): void } | null>(null)
  useEffect(() => () => selectionSearch.current?.dispose(), [])
  const readFeatures = useRef<ReturnType<typeof bindReadOnlyFeatures> | null>(
    null
  )
  useEffect(() => () => readFeatures.current?.dispose(), [])
  const baseline = useRef(changeBaseline)
  const changes = useRef<ReturnType<typeof bindChangeDecorations> | null>(null)
  useLayoutEffect(() => {
    baseline.current = changeBaseline
    changes.current?.refresh()
  }, [changeBaseline])
  useEffect(() => () => changes.current?.dispose(), [])
  const language = useSourceLanguage(
    sourcePath ?? languageDocument?.path,
    props.value ?? "",
    props.language
  )
  const inspection = useSourceInspection(inspectionDocument)
  const services = useEditorLanguageServices(languageDocument)
  const { resolvedTheme } = useTheme()
  const theme = useCodeTheme(
    props.theme ? !props.theme.endsWith("light") : resolvedTheme !== "light"
  )
  useEffect(() => {
    void ensureCodeLanguage(language).catch(() => {})
  }, [language])
  return (
    <>
      <div
        className={styles.surface}
        style={{
          height: props.height ?? 320,
          width: props.width ?? "100%",
          paddingTop: overlayTop,
          boxSizing: "border-box",
        }}
      >
        <Editor
          {...editorProps}
          language={language}
          height="100%"
          width="100%"
          theme={theme}
          options={{
            ...props.options,
            ...codeEditorOptions(),
            // The viewport starts below the glass bars, so sticky-scroll and
            // reveal/find calculations share the same visible upper boundary.
            padding: {
              ...props.options?.padding,
              top: Math.max(0, (props.options?.padding?.top ?? 0) - overlayTop),
            },
            "semanticHighlighting.enabled": true,
            wordWrap: "on",
            scrollbar: { ...props.options?.scrollbar, horizontal: "hidden" },
            wrappingIndent: "same",
          }}
          onMount={(editor, monaco) => {
            selectionSearch.current?.dispose()
            selectionSearch.current = bindSelectionSearch(monaco, editor)
            changes.current?.dispose()
            changes.current = bindChangeDecorations(
              editor,
              () => baseline.current
            )
            readFeatures.current?.dispose()
            const model = editor.getModel()
            if (model && props.options?.readOnly)
              readFeatures.current = bindReadOnlyFeatures(monaco, model)
            if (model) inspection.bind(model, monaco)
            services.onMount(editor, monaco)
            props.onMount?.(editor, monaco)
          }}
        />
      </div>
      {services.exploration}
      {inspection.exploration}
    </>
  )
}
