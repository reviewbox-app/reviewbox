"use client"
import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { Snapshot, Topic } from "@/lib/desktop/contracts.generated"
import { anchorFor } from "../helpers/review.helpers"

export function TopicEditorDialog({
  snapshot,
  topic,
  open,
  onClose,
  onSave,
}: {
  snapshot: Snapshot
  topic?: Topic
  open: boolean
  onClose: () => void
  onSave: (topic: Topic) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<Topic>(
    () => topic ?? { id: crypto.randomUUID(), title: "", brief: "", steps: [] }
  )
  const [saving, setSaving] = useState(false)
  const [editingStep, setEditingStep] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [explanation, setExplanation] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const addStep = () => {
    if (!title.trim() || !selected.length) return
    const anchors = snapshot.changes.flatMap((c) =>
      c.passages
        .filter((p) => selected.includes(p.id))
        .map((p) => anchorFor(snapshot, c.id, p))
    )
    setDraft({
      ...draft,
      steps: editingStep
        ? draft.steps.map((step) =>
            step.id === editingStep
              ? { ...step, title, explanation, anchors }
              : step
          )
        : [
            ...draft.steps,
            { id: crypto.randomUUID(), title, explanation, anchors },
          ],
    })
    setEditingStep(null)
    setTitle("")
    setExplanation("")
    setSelected([])
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{topic ? "Edit topic" : "Create a topic"}</DialogTitle>
          <DialogDescription>
            Group related passages across files into an ordered reading path.
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="topic-title">Topic title</Label>
        <Input
          id="topic-title"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
        <Label htmlFor="topic-brief">Goal, expected behavior and risks</Label>
        <Textarea
          id="topic-brief"
          value={draft.brief}
          onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
        />
        <ol className="space-y-2">
          {draft.steps.map((step, index) => (
            <li
              key={step.id}
              className="flex items-center gap-2 rounded-lg border p-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {index + 1}. {step.title}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setEditingStep(step.id)
                  setTitle(step.title)
                  setExplanation(step.explanation)
                  setSelected(
                    step.anchors
                      .filter((a) => a.snapshotId === snapshot.id)
                      .map((a) => a.passageId)
                  )
                }}
              >
                Edit anchors
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={index === 0}
                onClick={() => {
                  const steps = [...draft.steps]
                  ;[steps[index - 1], steps[index]] = [
                    steps[index],
                    steps[index - 1],
                  ]
                  setDraft({ ...draft, steps })
                }}
              >
                Move up
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  setDraft({
                    ...draft,
                    steps: draft.steps.filter((s) => s.id !== step.id),
                  })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
        <fieldset className="space-y-3 rounded-xl border p-4">
          <legend className="px-2 text-xs text-muted-foreground">
            Add a step
          </legend>
          <Input
            aria-label="Step title"
            placeholder="What should the reviewer check?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            aria-label="Step explanation"
            placeholder="Explain the change and suggested checks"
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
          />
          <div className="max-h-40 space-y-2 overflow-auto">
            {snapshot.changes.flatMap((c) =>
              c.passages.map((p) => (
                <Label key={p.id} className="flex text-xs">
                  <Checkbox
                    checked={selected.includes(p.id)}
                    onCheckedChange={(value) =>
                      setSelected(
                        value
                          ? [...selected, p.id]
                          : selected.filter((id) => id !== p.id)
                      )
                    }
                  />
                  <span className="truncate">
                    {c.path} · {c.layer} · {p.newStart}–
                    {p.newStart + Math.max(1, p.newLines) - 1}
                  </span>
                </Label>
              ))
            )}
          </div>
          <Button
            variant="outline"
            onClick={addStep}
            disabled={!title.trim() || !selected.length}
          >
            {editingStep ? "Save step" : "Add step"}
          </Button>
        </fieldset>
        <Button
          disabled={saving || !draft.title.trim()}
          onClick={() => {
            setSaving(true)
            void onSave(draft)
              .then((ok) => {
                if (ok) onClose()
              })
              .finally(() => setSaving(false))
          }}
        >
          Save topic
        </Button>
      </DialogContent>
    </Dialog>
  )
}
