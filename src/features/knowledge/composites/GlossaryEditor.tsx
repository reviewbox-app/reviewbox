"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import type { GlossaryTerm } from "@/lib/desktop/contracts.generated"
export function GlossaryEditor({
  terms,
  onChange,
}: {
  terms: GlossaryTerm[]
  onChange: (terms: GlossaryTerm[]) => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [aliases, setAliases] = useState("")
  const [senseTerm, setSenseTerm] = useState<string | null>(null)
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-medium">Project glossary</h2>
      <p className="text-sm text-muted-foreground">
        Terms can have several meanings. Matching explanations stay explicit
        when a word is ambiguous.
      </p>
      <div className="space-y-4">
        {terms
          .filter((t) => !t.archived)
          .map((term) => (
            <article key={term.id} className="rounded-xl border p-4">
              <header className="flex justify-between">
                <h3 className="font-medium">{term.term}</h3>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    onChange(
                      terms.map((t) =>
                        t.id === term.id ? { ...t, archived: true } : t
                      )
                    )
                  }
                >
                  Archive
                </Button>
              </header>
              <p className="text-xs text-muted-foreground">
                {term.aliases.join(" · ")}
              </p>
              <ol className="my-3 list-inside list-decimal space-y-2 text-sm leading-6">
                {term.senses.map((sense) => (
                  <li key={sense.id}>{sense.description}</li>
                ))}
              </ol>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => {
                  setSenseTerm(term.id)
                  setName(term.term)
                }}
              >
                Add another meaning
              </Button>
            </article>
          ))}
      </div>
      <form
        className="space-y-3 rounded-xl border p-4"
        onSubmit={(e) => {
          e.preventDefault()
          const sense = { id: crypto.randomUUID(), description }
          onChange(
            senseTerm
              ? terms.map((t) =>
                  t.id === senseTerm
                    ? { ...t, senses: [...t.senses, sense] }
                    : t
                )
              : [
                  ...terms,
                  {
                    id: crypto.randomUUID(),
                    term: name,
                    aliases: aliases
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    senses: [sense],
                    archived: false,
                  },
                ]
          )
          setName("")
          setDescription("")
          setAliases("")
          setSenseTerm(null)
        }}
      >
        <Label htmlFor="term-name">
          {senseTerm ? "New meaning for" : "New term"}
        </Label>
        <Input
          id="term-name"
          value={name}
          required
          readOnly={!!senseTerm}
          onChange={(e) => setName(e.target.value)}
        />
        {!senseTerm && (
          <Input
            aria-label="Aliases"
            placeholder="Aliases, separated by commas"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
          />
        )}
        <Textarea
          aria-label="Definition"
          placeholder="What does this mean?"
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={!name.trim() || !description.trim()}>
            Save meaning
          </Button>
          {senseTerm && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setSenseTerm(null)
                setName("")
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}
