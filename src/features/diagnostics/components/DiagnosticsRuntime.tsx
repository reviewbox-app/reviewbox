"use client"
import { useEffect } from "react"
import { observeRuntimeErrors } from "../services/runtimeErrors"

export function DiagnosticsRuntime() {
  useEffect(() => observeRuntimeErrors(window), [])
  return null
}
