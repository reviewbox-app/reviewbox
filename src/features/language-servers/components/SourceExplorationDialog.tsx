"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import { resolveCodeLanguage } from "@/lib/code/languages"
import { monacoRange } from "../helpers/languageTokens"
import { languageSessionCommands } from "../services/languageSession.commands"
import { errorMessage } from "@/lib/desktop/review.commands"
import type { LanguageLocation } from "@/lib/desktop/contracts.generated"

export interface SourceExploration {
  id: string
  title: string
  locations: LanguageLocation[]
  error?: string
}

/** Temporary exploration never changes the guided step or file-validation target. */
export function SourceExplorationDialog({
  value,
  onClose,
}: {
  value: SourceExploration
  onClose: () => void
}) {
  const [index, setIndex] = useState(0)
  const [loaded, setLoaded] = useState<{
    key: string
    text?: string
    error?: string
  } | null>(null)
  const target = value.locations[index]
  const key = target ? JSON.stringify(target) : ""
  const { resolvedTheme } = useTheme()
  const content = loaded?.key === key ? loaded : null
  useEffect(() => {
    if (!target) return
    let active = true
    void languageSessionCommands
      .source(target.document)
      .then((text) => {
        if (active) setLoaded({ key, text })
      })
      .catch((error: unknown) => {
        if (active) setLoaded({ key, error: errorMessage(error) })
      })
    return () => {
      active = false
    }
  }, [key, target])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{value.title}</DialogTitle>
          <DialogDescription>
            Explore captured source without leaving your current reading
            position.
          </DialogDescription>
        </DialogHeader>
        {value.error ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {value.error}
          </p>
        ) : !target ? (
          <p className="text-sm text-muted-foreground">
            No results in this snapshot.
          </p>
        ) : (
          <>
            {value.locations.length > 1 && (
              <nav
                aria-label="Source locations"
                className="flex max-h-36 shrink-0 flex-col gap-1 overflow-auto"
              >
                {value.locations.map((location, i) => (
                  <Button
                    key={`${location.document.path}/${location.range.startLine}/${i}`}
                    variant={index === i ? "secondary" : "ghost"}
                    size="sm"
                    className="shrink-0 justify-start"
                    onClick={() => setIndex(i)}
                  >
                    <FileIcon path={location.document.path} />
                    {location.document.path}:{location.range.startLine}
                  </Button>
                ))}
              </nav>
            )}
            <p
              className="flex items-center gap-2 truncate text-xs text-muted-foreground"
              title={target.document.path}
            >
              <FileIcon path={target.document.path} />
              {target.document.path} · line {target.range.startLine}
            </p>
            {content?.error ? (
              <p role="alert" className="text-sm text-muted-foreground">
                {content.error}
              </p>
            ) : content?.text === undefined ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading captured source…
              </p>
            ) : (
              <div className="h-[min(55vh,520px)] min-h-48 overflow-hidden rounded-xl border">
                <CodeEditor
                  key={key}
                  height="100%"
                  path={`reviewbox-exploration://${value.id}/${index}/${encodeURIComponent(target.document.path)}`}
                  languageDocument={target.document}
                  value={content.text}
                  language={resolveCodeLanguage(target.document.path).id}
                  theme={
                    resolvedTheme === "light"
                      ? "reviewbox-light"
                      : "reviewbox-dark"
                  }
                  options={{
                    readOnly: true,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontLigatures: false,
                    fontSize: 12,
                    lineHeight: 20,
                    scrollBeyondLastLine: false,
                  }}
                  onMount={(editor) => {
                    editor.setSelection(monacoRange(target.range))
                    editor.revealLineInCenter(target.range.startLine)
                  }}
                />
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
