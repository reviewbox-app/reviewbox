"use client"

import { DiffEditor } from "@monaco-editor/react"
import type { editor } from "monaco-editor"
import { useLayoutEffect, useRef } from "react"

import type { CodeDiffEditorProps } from "../contracts/codeEditor.types"

export function CodeDiffEditorRuntime(props: CodeDiffEditorProps) {
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
    <DiffEditor
      height={320}
      {...props}
      onMount={(mountedEditor, monaco) => {
        instance.current = mountedEditor
        props.onMount?.(mountedEditor, monaco)
      }}
    />
  )
}
