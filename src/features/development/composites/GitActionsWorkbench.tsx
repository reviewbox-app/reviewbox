"use client"
import { useState } from "react"
import { useSourceControl } from "@/features/source-control/hooks/useSourceControl"
import { sourceControlCommands } from "@/features/source-control/services/source-control.commands"
import { LocalFileMenu } from "@/features/source-control/composites/LocalFileMenu"
import { GroupedFileTree } from "@/features/file-tree/components/GroupedFileTree"
import { FileTree } from "@/features/file-tree/components/FileTree"

export function GitActionsWorkbench() {
  const [repository, setRepository] = useState("fixture")
  const git = useSourceControl(repository)
  const [selected, setSelected] = useState("")
  const [tree, setTree] = useState(false)
  const files = git.state?.files ?? []
  const Tree = tree ? FileTree : GroupedFileTree
  return (
    <main className="p-8">
      <button onClick={() => setRepository("other")}>Switch project</button>
      <button onClick={() => setTree(!tree)}>Toggle layout</button>
      <p role="status">{git.busy ? "Working" : "Ready"}</p>
      <p>{git.error}</p>
      <output>{selected}</output>
      <div className="w-96">
        <Tree
          paths={files.map((f) => f.path)}
          selected={selected}
          marks={{}}
          statuses={Object.fromEntries(
            files.map((f) => [f.path, "M" as const])
          )}
          onSelect={setSelected}
          renderRow={(row, target) => (
            <LocalFileMenu
              row={row}
              path={target.path}
              folder={target.folder}
              staged={false}
              git={git}
              targets={() =>
                files.filter((f) =>
                  target.folder
                    ? f.path.startsWith(target.path + "/")
                    : f.path === target.path
                )
              }
              select={() => {}}
              onStage={async (batch) => {
                await git.mutate(() =>
                  sourceControlCommands.stageFiles(
                    repository,
                    batch.map(({ path, version }) => ({ path, version })),
                    true
                  )
                )
              }}
            />
          )}
        />
      </div>
    </main>
  )
}
