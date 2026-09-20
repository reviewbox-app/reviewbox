"use client"

import dynamic from "next/dynamic"

import type { RichTextEditorProps } from "../contracts/richTextEditor.types"

export const RichTextEditor = dynamic<RichTextEditorProps>(
  () =>
    import("./RichTextEditorRuntime").then(
      (module) => module.RichTextEditorRuntime
    ),
  { ssr: false }
)
