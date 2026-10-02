"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { CodeExplainWorkspace } from "@/features/knowledge/composites/CodeExplainWorkspace"

export function ReadCacheWorkbench() {
  const [open, setOpen] = useState(true)
  const [error, setError] = useState("")
  return (
    <main className="flex h-screen flex-col">
      <Button onClick={() => setOpen((value) => !value)}>
        Toggle Code Explain
      </Button>
      {error && <p role="alert">{error}</p>}
      {open && (
        <CodeExplainWorkspace repositoryId="cache-fixture" onError={setError} />
      )}
    </main>
  )
}
