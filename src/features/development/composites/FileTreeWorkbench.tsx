"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { FileTree } from "@/features/file-tree/components/FileTree"
import { FileMenu } from "@/features/file-tree/components/FileMenu"
import { fileTreeCommands } from "@/features/file-tree/services/file-tree.commands"
import { Button } from "@/components/ui/button"

const statuses = {
  "src/added.ts": "A",
  "src/deleted.ts": "D",
  "src/modified.ts": "M",
  "src/renamed.ts": "R",
  "src/untracked.ts": "U",
} as const
const paths = Object.keys(statuses)

export function FileTreeWorkbench() {
  const [selected, setSelected] = useState(paths[0])
  const [error, setError] = useState("")
  const [revealed, setRevealed] = useState("")
  const [fail, setFail] = useState(false)
  const [filter, setFilter] = useState("")
  const { setTheme } = useTheme()
  useEffect(() => {
    const original = fileTreeCommands.reveal
    fileTreeCommands.reveal = async (_repositoryId, path) => {
      if (fail) throw new Error("Finder unavailable")
      setRevealed(path)
    }
    return () => {
      fileTreeCommands.reveal = original
    }
  }, [fail])
  return (
    <main className="p-6">
      <Button onClick={() => setTheme("light")}>Light</Button>
      <Button onClick={() => setTheme("dark")}>Dark</Button>
      <Button onClick={() => setFail(true)}>Fail reveal</Button>
      <input
        aria-label="Filter fixture files"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <output aria-label="Selected file">{selected}</output>
      <output aria-label="Revealed path">{revealed}</output>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-4">
        {["Review", "Code Explain", "Local changes"].map((name) => (
          <nav key={name} aria-label={name} className="w-72">
            <FileTree
              paths={paths.filter((path) => path.includes(filter))}
              statuses={statuses}
              selected={selected}
              marks={{ [paths[0]]: "validated" }}
              reviewedPaths={new Set(["src", ...paths])}
              alwaysExpanded={name === "Review"}
              defaultExpanded={name === "Local changes"}
              onSelect={setSelected}
              renderRow={(row, target) => (
                <FileMenu
                  row={row}
                  path={target.path}
                  repositoryId="fixture"
                  onError={setError}
                />
              )}
            />
          </nav>
        ))}
      </div>
    </main>
  )
}
