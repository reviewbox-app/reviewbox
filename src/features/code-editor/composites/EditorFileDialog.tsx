"use client"
import { remapTreeNavigation } from "@/features/file-tree/services/navigation.service"
import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/lib/desktop/review.commands"
import { editorCommands } from "../services/editor.commands"
import {
  closeBuffer,
  dirty,
  getEditor,
  openEditorFile,
  refreshEditor,
  saveBuffer,
  updateEditor,
} from "../stores/editor.store"

export interface FileAction {
  kind: "file" | "folder" | "rename" | "trash"
  path: string
  revision: string
}
export function EditorFileDialog({
  repositoryId: id,
  action,
  onClose,
}: {
  repositoryId: string
  action: FileAction
  onClose: () => void
}) {
  const [value, setValue] = useState(action.path)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const affected = () =>
    getEditor(id).buffers.filter(
      (b) => b.path === action.path || b.path.startsWith(`${action.path}/`)
    )
  const hasDrafts = affected().some(dirty)
  const apply = async (save = false) => {
    setBusy(true)
    setError("")
    try {
      if (action.kind === "file" || action.kind === "folder") {
        await editorCommands.mutate(id, {
          kind: "create",
          path: value,
          directory: action.kind === "folder",
        })
        if (action.kind === "file") await openEditorFile(id, value)
      } else if (action.kind === "rename") {
        await editorCommands.mutate(id, {
          kind: "rename",
          path: action.path,
          destination: value,
          expectedRevision: action.revision,
        })
        const remap = (p: string) =>
          p === action.path || p.startsWith(`${action.path}/`)
            ? value + p.slice(action.path.length)
            : p
        remapTreeNavigation(id, action.path, value)
        updateEditor(id, (s) => ({
          ...s,
          active: remap(s.active),
          toggledFolders: new Set([...s.toggledFolders].map(remap)),
          buffers: s.buffers.map((b) => ({ ...b, path: remap(b.path) })),
        }))
      } else {
        if (save)
          for (const b of affected()) if (dirty(b)) await saveBuffer(id, b.id)
        const expectedRevision = save
          ? await editorCommands.revision(id, action.path)
          : action.revision
        await editorCommands.mutate(id, {
          kind: "trash",
          path: action.path,
          expectedRevision,
        })
        remapTreeNavigation(id, action.path)
        updateEditor(id, (s) => ({
          ...s,
          toggledFolders: new Set(
            [...s.toggledFolders].filter(
              (p) => p !== action.path && !p.startsWith(`${action.path}/`)
            )
          ),
        }))
        for (const b of affected()) closeBuffer(id, b.id)
      }
      await refreshEditor(id)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  const title =
    action.kind === "file"
      ? "New file"
      : action.kind === "folder"
        ? "New folder"
        : action.kind === "rename"
          ? "Rename"
          : "Move to Trash"
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {action.kind === "trash"
            ? `${action.path}${hasDrafts ? " contains unsaved changes." : " will be moved to the system Trash."}`
            : "Enter a path relative to the repository."}
        </DialogDescription>
        {action.kind !== "trash" && (
          <Input
            aria-label="File path"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void apply()
            }}
          />
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {action.kind === "trash" && hasDrafts && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void apply(true)}
            >
              Save and move to Trash
            </Button>
          )}
          <Button disabled={busy || !value.trim()} onClick={() => void apply()}>
            {action.kind === "trash" && hasDrafts
              ? "Discard and move to Trash"
              : title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
