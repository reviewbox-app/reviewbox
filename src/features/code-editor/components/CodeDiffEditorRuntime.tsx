"use client"

import { DiffEditor } from "@monaco-editor/react"
import type { editor } from "monaco-editor"
import { useEffect, useLayoutEffect, useRef } from "react"
import { useCodeTheme } from "@/lib/code/codeAppearance"
import { ensureCodeLanguage } from "@/lib/code/highlighter"
import { useEditorLanguageServices } from "@/features/language-servers/hooks/useEditorLanguageServices"

import type { CodeDiffEditorProps } from "../contracts/codeEditor.types"

export function CodeDiffEditorRuntime(props: CodeDiffEditorProps) {
  const { originalLanguageDocument, modifiedLanguageDocument, ...editorProps } =
    props
  const services = useEditorLanguageServices(
    originalLanguageDocument,
    modifiedLanguageDocument
  )
  const theme = useCodeTheme(!props.theme?.endsWith("light"))
  useEffect(() => {
    void ensureCodeLanguage(props.language).catch(() => {})
  }, [props.language])
  const instance = useRef<editor.IStandaloneDiffEditor | null>(null)
  const retainModels = useRef({
    original: props.keepCurrentOriginalModel ?? false,
    modified: props.keepCurrentModifiedModel ?? false,
  })

  useLayoutEffect(() => {
    const retention = retainModels.current
    return () => {
      const current = instance.current
      if (!current) return

      const models = current.getModel()
      // Monaco 0.56 requires detaching the diff before its text models are disposed.
      // This runs before the React wrapper's passive cleanup disposes its models.
      current.setModel(null)
      if (!retention.original) models?.original.dispose()
      if (!retention.modified) models?.modified.dispose()
      instance.current = null
    }
  }, [])

  return (
    <>
      <DiffEditor
        height={320}
        {...editorProps}
        theme={theme}
        options={{
          ...props.options,
          wordWrap: "on",
          scrollbar: { ...props.options?.scrollbar, horizontal: "hidden" },
          wrappingIndent: "same",
          diffWordWrap: "on",
        }}
        onMount={(mountedEditor, monaco) => {
          instance.current = mountedEditor
          mountedEditor
            .getOriginalEditor()
            .updateOptions({ "semanticHighlighting.enabled": true })
          mountedEditor
            .getModifiedEditor()
            .updateOptions({ "semanticHighlighting.enabled": true })
          services.onMount(mountedEditor, monaco)
          props.onMount?.(mountedEditor, monaco)
        }}
      />
      {services.exploration}
    </>
  )
}
