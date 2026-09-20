"use client"

import Editor from "@monaco-editor/react"

import type { CodeEditorProps } from "../contracts/codeEditor.types"

export function CodeEditorRuntime(props: CodeEditorProps) {
  return <Editor height={320} {...props} />
}
