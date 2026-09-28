"use client"

import Editor from "@monaco-editor/react"
import { useEffect } from "react"
import { useCodeTheme } from "@/lib/code/codeAppearance"
import { ensureCodeLanguage } from "@/lib/code/highlighter"
import { useEditorLanguageServices } from "@/features/language-servers/hooks/useEditorLanguageServices"

import type { CodeEditorProps } from "../contracts/codeEditor.types"

export function CodeEditorRuntime(props: CodeEditorProps) {
  const { languageDocument, ...editorProps } = props
  const services = useEditorLanguageServices(languageDocument)
  const theme = useCodeTheme(!props.theme?.endsWith("light"))
  useEffect(() => {
    void ensureCodeLanguage(props.language).catch(() => {})
  }, [props.language])
  return (
    <>
      <Editor
        height={320}
        {...editorProps}
        theme={theme}
        options={{
          ...props.options,
          "semanticHighlighting.enabled": true,
          wordWrap: "on",
          scrollbar: { ...props.options?.scrollbar, horizontal: "hidden" },
          wrappingIndent: "same",
        }}
        onMount={(editor, monaco) => {
          services.onMount(editor, monaco)
          props.onMount?.(editor, monaco)
        }}
      />
      {services.exploration}
    </>
  )
}
