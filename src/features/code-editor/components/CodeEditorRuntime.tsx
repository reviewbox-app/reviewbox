"use client"

import Editor from "@monaco-editor/react"
import { useEffect, type CSSProperties } from "react"
import { useCodeTheme } from "@/lib/code/codeAppearance"
import { ensureCodeLanguage } from "@/lib/code/highlighter"
import { useEditorLanguageServices } from "@/features/language-servers/hooks/useEditorLanguageServices"
import styles from "./editor-overlays.module.css"

import type { CodeEditorProps } from "../contracts/codeEditor.types"

export function CodeEditorRuntime(props: CodeEditorProps) {
  const { languageDocument, overlayTop = 0, ...editorProps } = props
  const services = useEditorLanguageServices(languageDocument)
  const theme = useCodeTheme(!props.theme?.endsWith("light"))
  useEffect(() => {
    void ensureCodeLanguage(props.language).catch(() => {})
  }, [props.language])
  return (
    <>
      <div
        className={overlayTop > 0 ? styles.overlaid : undefined}
        style={
          {
            height: props.height ?? 320,
            width: props.width ?? "100%",
            "--code-overlay-top": `${overlayTop}px`,
          } as CSSProperties
        }
      >
        <Editor
          {...editorProps}
          height="100%"
          width="100%"
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
      </div>
      {services.exploration}
    </>
  )
}
