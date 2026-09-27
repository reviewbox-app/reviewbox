"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type {
  CodeAnchor,
  Snapshot,
  Topic,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { anchorLabel } from "../helpers/preparation.helpers"

export function PreparationTopicEditor({
  topic,
  snapshot,
  onSave,
  onClose,
}: {
  topic: Topic
  snapshot: Snapshot
  onSave: (topic: Topic) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState(topic)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const anchors = snapshot.changes.flatMap((change) =>
    change.passages.map((passage) => ({
      snapshotId: snapshot.id,
      changeId: change.id,
      passageId: passage.id,
    }))
  )
  const replaceAnchor = (
    stepIndex: number,
    anchorIndex: number,
    anchor: CodeAnchor | null
  ) =>
    setDraft((value) => ({
      ...value,
      steps: value.steps.map((step, index) =>
        index !== stepIndex
          ? step
          : {
              ...step,
              anchors: anchor
                ? [
                    ...step.anchors.slice(0, anchorIndex),
                    anchor,
                    ...step.anchors.slice(anchorIndex + 1),
                  ]
                : step.anchors.filter((_, index) => index !== anchorIndex),
            }
      ),
    }))
  const save = async () => {
    setBusy(true)
    setError("")
    try {
      await onSave(draft)
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogTitle>Edit proposed topic</DialogTitle>
        <DialogDescription>
          Choose passages from the frozen review files. Saving an edit returns
          this topic to pending.
        </DialogDescription>
        <div className="min-h-0 space-y-4 overflow-y-auto">
          <Label className="grid gap-2">
            Topic title
            <Input
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </Label>
          <Label className="grid gap-2">
            Purpose, behavior and risks
            <Textarea
              value={draft.brief}
              onChange={(event) =>
                setDraft({ ...draft, brief: event.target.value })
              }
            />
          </Label>
          {draft.steps.map((step, stepIndex) => (
            <section key={step.id} className="space-y-3 rounded-2xl border p-3">
              <Label className="grid gap-2">
                Step {stepIndex + 1}
                <Input
                  value={step.title}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      steps: draft.steps.map((item, index) =>
                        index === stepIndex
                          ? { ...item, title: event.target.value }
                          : item
                      ),
                    })
                  }
                />
              </Label>
              <Label className="grid gap-2">
                Explanation
                <Textarea
                  value={step.explanation}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      steps: draft.steps.map((item, index) =>
                        index === stepIndex
                          ? { ...item, explanation: event.target.value }
                          : item
                      ),
                    })
                  }
                />
              </Label>
              {(step.anchors.length ? step.anchors : [null]).map(
                (anchor, anchorIndex) => {
                  const key =
                    anchor && anchor.snapshotId === snapshot.id
                      ? anchors.findIndex(
                          (item) =>
                            item.changeId === anchor.changeId &&
                            item.passageId === anchor.passageId
                        )
                      : -1
                  return (
                    <div key={anchorIndex} className="flex min-w-0 gap-2">
                      <Select
                        value={key >= 0 ? String(key) : null}
                        onValueChange={(value) => {
                          if (value !== null)
                            replaceAnchor(
                              stepIndex,
                              anchorIndex,
                              anchors[Number(value)]
                            )
                        }}
                      >
                        <SelectTrigger
                          className="min-w-0 flex-1"
                          aria-label={`Passage for step ${stepIndex + 1}, anchor ${anchorIndex + 1}`}
                        >
                          <SelectValue placeholder="Choose a frozen passage" />
                        </SelectTrigger>
                        <SelectContent>
                          {anchors.map((item, index) => (
                            <SelectItem
                              key={`${item.changeId}/${item.passageId}`}
                              value={String(index)}
                            >
                              {anchorLabel(snapshot, item)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {step.anchors.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            replaceAnchor(stepIndex, anchorIndex, null)
                          }
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  )
                }
              )}
              {anchors.length > 0 && step.anchors.length > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    replaceAnchor(stepIndex, step.anchors.length, anchors[0])
                  }
                >
                  Add another passage
                </Button>
              )}
            </section>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <footer className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            Save changes
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
