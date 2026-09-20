"use client"

import dynamic from "next/dynamic"

import { initializeMonaco } from "@/lib/monaco/initializeMonaco"

import type { CodeEditorProps } from "../contracts/codeEditor.types"

export const CodeEditor = dynamic<CodeEditorProps>(
  async () => {
    await initializeMonaco()
    return (await import("./CodeEditorRuntime")).CodeEditorRuntime
  },
  { ssr: false }
)
