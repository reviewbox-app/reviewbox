"use client"
import dynamic from "next/dynamic"
import { initializeMonaco } from "@/lib/monaco/initializeMonaco"
import type { BlockDiffProps } from "../contracts/blockDiff.types"

export const BlockDiff = dynamic<BlockDiffProps>(
  async () => {
    await initializeMonaco()
    return (await import("./BlockDiffRuntime")).BlockDiffRuntime
  },
  { ssr: false }
)
