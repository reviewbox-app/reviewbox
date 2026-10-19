import { useEffect, useState } from "react"
import { sourceControlCommands } from "@/features/source-control/services/source-control.commands"
import { editorCommands } from "../services/editor.commands"
import { subscribeRepositoryReads } from "@/lib/desktop/repositoryReads"
import { desktopAvailable } from "@/lib/desktop/review.commands"

/** The Git index is the baseline, not the last editor save. */
export function useGitBaseline(repositoryId: string, path: string) {
  const [state, setState] = useState<{ key: string; text: string }>()
  const key = `${repositoryId}/${path}`
  useEffect(() => {
    if (!desktopAvailable() || path.startsWith("file:")) return
    let alive = true
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const current = ++generation
      try {
        const git = await sourceControlCommands.state(repositoryId)
        const file = git.files.find((file) => file.path === path)
        let text: string
        if (file) {
          const unstaged = !!file.unstagedStatus
          const diff = await sourceControlCommands.diff(
            repositoryId,
            path,
            unstaged ? "unstaged" : "staged",
            file.version
          )
          text = (unstaged ? diff.content.before : diff.content.after) ?? ""
        } else text = (await editorCommands.read(repositoryId, path)).text
        if (alive && current === generation) setState({ key, text })
      } catch {
        /* Git assistance must never prevent editing. */
      }
    }
    void read()
    const stop = subscribeRepositoryReads(repositoryId, (change) => {
      if (change.full || change.git || change.paths.includes(path)) {
        ++generation
        clearTimeout(timer)
        timer = setTimeout(() => void read(), 150)
      }
    })
    return () => {
      alive = false
      clearTimeout(timer)
      stop()
    }
  }, [repositoryId, path, key])
  return state?.key === key ? state.text : undefined
}
