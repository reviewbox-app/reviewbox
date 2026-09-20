"use client"

import dynamic from "next/dynamic"

import { initializeMonaco } from "@/lib/monaco/initializeMonaco"

import type { CodeDiffEditorProps } from "../contracts/codeEditor.types"

export const CodeDiffEditor = dynamic<CodeDiffEditorProps>(
  async () => {
    await initializeMonaco()
    return (await import("./CodeDiffEditorRuntime")).CodeDiffEditorRuntime
  },
  { ssr: false }
)
