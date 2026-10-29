"use client"

import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  GitBranchIcon,
  UnfoldMoreIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { errorMessage } from "@/lib/desktop/review.commands"
import { dirty, getEditor } from "@/features/code-editor/stores/editor.store"
import { sourceControlCommands } from "../services/source-control.commands"

export function BranchPicker({
  repositoryId,
  branch,
  onSwitched,
}: {
  repositoryId: string
  branch: string
  onSwitched: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const gate = useRef(false)
  useEffect(() => {
    if (!open) return
    let active = true
    sourceControlCommands
      .branches(repositoryId)
      .then(
        (value) => {
          if (active) setBranches(value)
        },
        (cause) => {
          if (active) setError(errorMessage(cause))
        }
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, repositoryId, retry])
  async function switchTo(name: string) {
    if (gate.current || name === branch) return
    if (getEditor(repositoryId)?.buffers.some(dirty)) {
      setError("Save your open files before switching branches.")
      return
    }
    gate.current = true
    setBusy(true)
    setError("")
    try {
      await sourceControlCommands.switchBranch(repositoryId, name)
      await onSwitched()
      setOpen(false)
    } catch (cause) {
      setError(errorMessage(cause))
      // A checkout hook can fail after HEAD has already changed.
      await onSwitched().catch(() => {})
    } finally {
      gate.current = false
      setBusy(false)
    }
  }
  const matches = branches.filter((name) =>
    name.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (!gate.current) {
          setOpen(value)
          setQuery("")
          if (value) {
            setLoading(true)
            setError("")
          }
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-[30px] min-w-0 gap-1 font-normal text-muted-foreground"
            aria-label={`Switch branch (${branch})`}
          />
        }
      >
        <HugeiconsIcon icon={GitBranchIcon} size={14} />
        <span className="max-w-48 truncate">{branch}</span>
        <HugeiconsIcon icon={UnfoldMoreIcon} size={14} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-2">
        <PopoverTitle>Switch branch</PopoverTitle>
        <Input
          aria-label="Filter branches"
          placeholder="Filter local branches…"
          value={query}
          disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
        />
        {error && (
          <p
            role="alert"
            className="text-xs whitespace-pre-wrap text-destructive"
          >
            {error}
          </p>
        )}
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading branches…
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {matches.map((name) => (
              <Button
                key={name}
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                disabled={busy || name === branch}
                onClick={() => void switchTo(name)}
              >
                <HugeiconsIcon
                  icon={name === branch ? Tick02Icon : GitBranchIcon}
                  size={14}
                />
                <span className="truncate">{name}</span>
                {name === branch && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    Current
                  </span>
                )}
              </Button>
            ))}
            {!matches.length && !error && (
              <p className="text-sm text-muted-foreground">
                No local branches found.
              </p>
            )}
          </div>
        )}
        {busy && (
          <p role="status" className="text-xs text-muted-foreground">
            Switching branch…
          </p>
        )}
        {error && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || loading}
            onClick={() => {
              setLoading(true)
              setError("")
              setRetry((value) => value + 1)
            }}
          >
            Refresh branches
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
