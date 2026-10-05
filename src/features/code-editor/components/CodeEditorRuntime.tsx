"use client"

import Editor from "@monaco-editor/react"
import { useEffect } from "react"
import styles from "./editor-surface.module.css"
import { useTheme } from "next-themes"
import { useCodeTheme, codeEditorOptions } from "@/lib/code/codeAppearance"
import { ensureCodeLanguage } from "@/lib/code/highlighter"
import { useEditorLanguageServices } from "@/features/language-servers/hooks/useEditorLanguageServices"

import type { CodeEditorProps } from "../contracts/codeEditor.types"

export function CodeEditorRuntime(props: CodeEditorProps) {
  const { languageDocument, overlayTop = 0, ...editorProps } = props
  const services = useEditorLanguageServices(languageDocument)
  const { resolvedTheme } = useTheme()
  const theme = useCodeTheme(
    props.theme ? !props.theme.endsWith("light") : resolvedTheme !== "light"
  )
  useEffect(() => {
    void ensureCodeLanguage(props.language).catch(() => {})
  }, [props.language])
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
            services.onMount(editor, monaco)
            props.onMount?.(editor, monaco)
          }}
        />
      </div>
      {services.exploration}
    </>
  )
}
