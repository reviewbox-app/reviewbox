"use client"

import { DiffEditor } from "@monaco-editor/react"
import type { editor } from "monaco-editor"
import * as monaco from "monaco-editor/editor/editor.api"
import { useEffect, useLayoutEffect, useRef } from "react"
import styles from "./editor-surface.module.css"
import { useCodeTheme } from "@/lib/code/codeAppearance"
import { ensureCodeLanguage } from "@/lib/code/highlighter"
import { useEditorLanguageServices } from "@/features/language-servers/hooks/useEditorLanguageServices"

import type { CodeDiffEditorProps } from "../contracts/codeEditor.types"

export function CodeDiffEditorRuntime(props: CodeDiffEditorProps) {
  const {
    originalLanguageDocument,
    modifiedLanguageDocument,
    overlayTop = 0,
    ...editorProps
  } = props
  const services = useEditorLanguageServices(
    originalLanguageDocument,
    modifiedLanguageDocument
  )
  const theme = useCodeTheme(!props.theme?.endsWith("light"))
  useEffect(() => {
    void ensureCodeLanguage(props.language).catch(() => {})
  }, [props.language])
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IDiffEditor | null>(null)
  const retainModels = useRef({
    original: props.keepCurrentOriginalModel ?? false,
    modified: props.keepCurrentModifiedModel ?? false,
  })

  useLayoutEffect(() => {
    const retention = retainModels.current
    // The React wrapper's onMount runs in a later effect. A fast file/view
    // switch may unmount it in between creation and that callback, so capture
    // ownership synchronously, scoped to this container.
    const created = monaco.editor.onDidCreateDiffEditor((current) => {
      if (container.current?.contains(current.getContainerDomNode()))
        instance.current = current
    })
    return () => {
      created.dispose()
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
      <div
        ref={container}
        className={styles.surface}
        style={{
          height: props.height ?? 320,
          width: props.width ?? "100%",
          paddingTop: overlayTop,
          boxSizing: "border-box",
        }}
      >
        <DiffEditor
          {...editorProps}
          height="100%"
          width="100%"
          theme={theme}
          options={{
            ...props.options,
            // The viewport starts below the glass bars, so sticky-scroll and
            // reveal/find calculations share the same visible upper boundary.
            padding: {
              ...props.options?.padding,
              top: Math.max(0, (props.options?.padding?.top ?? 0) - overlayTop),
            },
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
      </div>
      {services.exploration}
    </>
  )
}
