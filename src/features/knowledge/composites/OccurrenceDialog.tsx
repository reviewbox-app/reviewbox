"use client"
import { useState } from "react"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import type {
  ExplanationSection,
  GlossaryTerm,
  TermOccurrence,
} from "@/lib/desktop/contracts.generated"
export function OccurrenceDialog({
  section,
  terms,
  onClose,
  onSave,
}: {
  section: ExplanationSection
  terms: GlossaryTerm[]
  onClose: () => void
  onSave: (occurrence: TermOccurrence) => void
}) {
  const [quote, setQuote] = useState("")
  const [description, setDescription] = useState("")
  const [offset, setOffset] = useState<number | null>(null)
  const [sense, setSense] = useState("")
  const characters = Array.from(section.body)
  const length = Array.from(quote).length
  const matches = quote
    ? characters.flatMap((_, index) =>
        characters.slice(index, index + length).join("") === quote
          ? [index]
          : []
      )
    : []
  const location =
    offset !== null && matches.includes(offset)
      ? offset
      : matches.length === 1
        ? matches[0]
        : null
  const selected = terms
    .flatMap((term) => term.senses.map((s) => ({ term, sense: s })))
    .find((item) => item.sense.id === sense)
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent>
        <DialogTitle>Explain a word here</DialogTitle>
        <DialogDescription>
          This explanation applies to one occurrence. It does not add a global
          glossary entry.
        </DialogDescription>
        <Label htmlFor="occurrence-word">Word or phrase</Label>
        <Input
          id="occurrence-word"
          value={quote}
          onChange={(e) => {
            setQuote(e.target.value)
            setOffset(null)
          }}
        />
        <div className="space-y-1">
          {matches.map((index) => (
            <Button
              key={index}
              variant={location === index ? "secondary" : "ghost"}
              size="sm"
              className="w-full justify-start truncate"
              onClick={() => setOffset(index)}
            >
              {characters
                .slice(Math.max(0, index - 20), index + length + 20)
                .join("")}
            </Button>
          ))}
        </div>
        <Label htmlFor="occurrence-description">One-off description</Label>
        <Textarea
          id="occurrence-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Label htmlFor="occurrence-sense">
          Or explicitly link an existing meaning
        </Label>
        <NativeSelect
          id="occurrence-sense"
          value={sense}
          onChange={(e) => setSense(e.target.value)}
          className="w-full"
        >
          <NativeSelectOption value="">No linked meaning</NativeSelectOption>
          {terms
            .filter((t) => !t.archived)
            .flatMap((term) =>
              term.senses.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {term.term} — {s.description}
                </NativeSelectOption>
              ))
            )}
        </NativeSelect>
        <DialogFooter>
          <Button
            disabled={location === null || (!description.trim() && !selected)}
            onClick={() => {
              if (location === null) return
              onSave({
                id: crypto.randomUUID(),
                sectionId: section.id,
                quote,
                offset: location,
                description: description.trim() || null,
                termId: selected?.term.id ?? null,
                senseId: selected?.sense.id ?? null,
              })
            }}
          >
            Save for this occurrence
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
