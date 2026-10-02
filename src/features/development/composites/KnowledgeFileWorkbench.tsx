"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { KnowledgeFile } from "@/features/knowledge/composites/KnowledgeFile"
import { documentAfter } from "../fixtures/documentDiff.fixture"

const paths = [
  "README.md",
  "notes.TXT",
  "LICENSE",
  "CMakeLists.txt",
  "README.mdx",
]
export function KnowledgeFileWorkbench() {
  const [path, setPath] = useState(paths[0])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 500)
    return () => clearInterval(timer)
  }, [])
  const code =
    path === "notes.TXT" ? "# Notes\nFirst line\nSecond line" : documentAfter
  return (
    <main className="flex h-screen flex-col">
      <nav>
        {paths.map((value) => (
          <Button key={value} onClick={() => setPath(value)}>
            {value}
          </Button>
        ))}
        <output data-testid="refresh-count">{tick}</output>
      </nav>
      <KnowledgeFile
        key={path}
        snapshot={{ id: `context-${tick}`, repositoryId: "fixture" }}
        file={{
          path,
          content: { hash: path, size: code.length, mode: "100644" },
        }}
        code={code}
      />
    </main>
  )
}
