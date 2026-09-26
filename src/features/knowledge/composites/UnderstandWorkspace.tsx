"use client"
import { OnboardingWorkspace } from "@/features/onboarding/composites/OnboardingWorkspace"
import { AgentConversation } from "@/features/agents/composites/AgentConversation"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useEffect, useState, useRef } from "react"
import type { editor } from "monaco-editor"
import { languageServerCommands } from "@/features/language-servers/services/languageServer.commands"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import type {
  ProjectKnowledge,
  Snapshot,
  ExplanationDocument,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { languageFor } from "@/features/review/helpers/review.helpers"
import { OccurrenceDialog } from "./OccurrenceDialog"
import { GlossaryEditor } from "./GlossaryEditor"
import { GlossaryText } from "./GlossaryText"
export function UnderstandWorkspace({
  snapshot,
  reviewId,
  onApplied,
  onError,
}: {
  snapshot: Snapshot
  reviewId: string
  onApplied: () => void
  onError: (error: string) => void
}) {
  const [onboarding, setOnboarding] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [back, setBack] = useState<
    { path: string; line: number; column: number }[]
  >([])
  const [targetLine, setTargetLine] = useState(1)
  const [finding, setFinding] = useState(false)
  const [occurrenceSection, setOccurrenceSection] = useState<string | null>(
    null
  )
  const [knowledge, setKnowledge] = useState<ProjectKnowledge | null>(null)
  const [path, setPath] = useState(snapshot.files[0]?.path ?? "")
  const [loaded, setLoaded] = useState<{ path: string; code: string } | null>(
    null
  )
  const code = loaded?.path === path ? loaded.code : ""
  const [filter, setFilter] = useState("")
  const [glossary, setGlossary] = useState(false)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [start, setStart] = useState(1)
  const [end, setEnd] = useState(1)
  const [saving, setSaving] = useState(false)
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    let alive = true
    const reload = () =>
      reviewCommands
        .knowledge(snapshot.repositoryId)
        .then((v) => {
          if (alive) setKnowledge(v)
        })
        .catch((e) => onError(errorMessage(e)))
    reload()
    const timer = setInterval(reload, 2500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [snapshot.repositoryId, onError])
  useEffect(() => {
    let alive = true
    if (!path) return
    reviewCommands
      .file(snapshot.id, path)
      .then((v) => {
        if (alive) setLoaded({ path, code: v })
      })
      .catch((e) => {
        if (alive) {
          setLoaded(null)
          onError(errorMessage(e))
        }
      })
    return () => {
      alive = false
    }
  }, [snapshot.id, path, onError])
  const document = knowledge?.documents.filter((d) => d.path === path).at(-1)
  const file = snapshot.files.find((f) => f.path === path)
  const stale = document && file && document.fingerprint !== file.content.hash
  const save = async (value: ProjectKnowledge) => {
    if (saving) return false
    setSaving(true)
    try {
      setKnowledge(await reviewCommands.saveKnowledge(value))
      return true
    } catch (e) {
      onError(errorMessage(e))
      return false
    } finally {
      setSaving(false)
    }
  }
  const addSection = () => {
    if (!knowledge || !file) return
    const section = {
      id: crypto.randomUUID(),
      title,
      body,
      startLine: start,
      endLine: end,
    }
    const next: ExplanationDocument =
      document && !stale
        ? { ...document, sections: [...document.sections, section] }
        : {
            id: crypto.randomUUID(),
            repositoryId: snapshot.repositoryId,
            snapshotId: snapshot.id,
            path,
            fingerprint: file.content.hash,
            language: knowledge.language,
            sections: [section],
            occurrences: [],
            createdAt: snapshot.createdAt,
          }
    void save({
      ...knowledge,
      documents: [...knowledge.documents.filter((d) => d.id !== next.id), next],
    }).then((ok) => {
      if (ok) {
        setTitle("")
        setBody("")
      }
    })
  }
  const definition = async () => {
    const position = editorRef.current?.getPosition()
    if (!position || finding) return
    setFinding(true)
    try {
      const locations = await languageServerCommands.definition(
        snapshot.id,
        path,
        position.lineNumber,
        position.column
      )
      if (locations.length !== 1) {
        onError(
          locations.length
            ? "Several definitions were returned; narrow the symbol before navigating."
            : "No definition found in this snapshot."
        )
        return
      }
      const target = locations[0]
      if (!snapshot.files.some((f) => f.path === target.path)) {
        onError("This definition is outside the frozen snapshot.")
        return
      }
      setBack([
        ...back,
        { path, line: position.lineNumber, column: position.column },
      ])
      setPath(target.path)
      setTargetLine(target.line)
      if (target.path === path)
        editorRef.current?.revealLineInCenter(target.line)
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setFinding(false)
    }
  }
  if (onboarding)
    return (
      <OnboardingWorkspace
        repositoryId={snapshot.repositoryId}
        onClose={() => setOnboarding(false)}
      />
    )
  return (
    <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
      <aside className="flex w-[272px] shrink-0 flex-col gap-4 p-2 max-[1100px]:w-[210px]">
        <h1 className="text-base font-medium">Understand this project</h1>
        <Input
          aria-label="Find a file"
          placeholder="Find a file…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button
          variant={glossary ? "secondary" : "outline"}
          onClick={() => setGlossary(!glossary)}
        >
          Project glossary
        </Button>
        <Button variant="ghost" onClick={() => setOnboarding(true)}>
          Onboarding tours
        </Button>
        <div className="min-h-0 flex-1 overflow-auto">
          {snapshot.files
            .filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()))
            .map((file) => (
              <button
                key={file.path}
                onClick={() => {
                  setPath(file.path)
                  setGlossary(false)
                }}
                className={`block w-full truncate rounded-lg px-2 py-2 text-left font-mono text-xs hover:bg-accent ${file.path === path ? "bg-accent" : ""}`}
              >
                {file.path}
              </button>
            ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 overflow-hidden rounded-[14px] border bg-card">
        {glossary && knowledge ? (
          <div className="mx-auto w-full max-w-2xl overflow-auto p-8">
            <GlossaryEditor
              terms={knowledge.terms}
              onChange={(terms) => void save({ ...knowledge, terms })}
            />
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-12 shrink-0 items-center border-b px-4 font-mono text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {path || "No files in this snapshot"}
                </span>
                {back.length > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      const target = back.at(-1)!
                      setBack(back.slice(0, -1))
                      setPath(target.path)
                      setTargetLine(target.line)
                    }}
                  >
                    Back
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={finding || !code}
                  onClick={() => void definition()}
                >
                  {finding ? "Finding…" : "Go to definition"}
                </Button>
              </header>
              <div className="min-h-0 flex-1">
                <CodeEditor
                  key={`${snapshot.id}/${path}`}
                  path={`reviewbox://${snapshot.id}/understand/${path}`}
                  height="100%"
                  onMount={(mounted) => {
                    editorRef.current = mounted
                    mounted.revealLineInCenter(targetLine)
                    mounted.setPosition({ lineNumber: targetLine, column: 1 })
                  }}
                  value={code}
                  language={languageFor(path)}
                  theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                  options={{
                    readOnly: true,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    fontLigatures: false,
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>
            </div>
            <aside className="w-[500px] shrink-0 overflow-auto border-l p-6 max-[1300px]:w-[340px]">
              <div className="mb-6 flex items-center justify-between gap-4">
                <h2 className="font-medium">Plain language</h2>
                {knowledge && (
                  <Input
                    className="w-28"
                    aria-label="Explanation language"
                    defaultValue={knowledge.language}
                    onBlur={(e) => {
                      if (e.target.value !== knowledge.language)
                        void save({ ...knowledge, language: e.target.value })
                    }}
                  />
                )}
              </div>
              <Button
                className="mb-5"
                variant="outline"
                disabled={!file}
                onClick={() => setAgentOpen(true)}
              >
                Explain with an agent
              </Button>
              {stale && (
                <p className="mb-4 rounded-lg bg-review-attention/10 p-3 text-xs text-review-attention">
                  These explanations refer to an older version. Their source
                  links need review.
                </p>
              )}
              {!document && (
                <p className="mb-6 text-sm leading-6 text-muted-foreground">
                  No explanation yet. Add source-linked reading notes below.
                  Definitions from the project glossary are linked
                  automatically.
                </p>
              )}
              {knowledge &&
                document?.sections.map((section, index) => (
                  <article key={section.id} className="mb-7">
                    <h3 className="mb-2 text-sm font-medium">
                      {index + 1}. {section.title}
                    </h3>
                    <p className="mb-3 font-mono text-[11px] text-muted-foreground">
                      {path} · {section.startLine}–{section.endLine}
                    </p>
                    <GlossaryText
                      text={section.body}
                      terms={knowledge.terms}
                      occurrences={document.occurrences}
                      sectionId={section.id}
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setOccurrenceSection(section.id)}
                    >
                      Explain a word
                    </Button>
                  </article>
                ))}
              {file && (
                <form
                  className="space-y-3 border-t pt-5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    addSection()
                  }}
                >
                  <h3 className="text-sm font-medium">Add an explanation</h3>
                  <Input
                    aria-label="Section title"
                    placeholder="What does this part do?"
                    value={title}
                    required
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <Textarea
                    aria-label="Explanation"
                    placeholder="Describe the behavior in natural language"
                    value={body}
                    required
                    onChange={(e) => setBody(e.target.value)}
                  />
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Lines</span>
                    <Input
                      type="number"
                      min={1}
                      aria-label="First line"
                      value={start}
                      onChange={(e) => setStart(Number(e.target.value))}
                    />
                    <span>to</span>
                    <Input
                      type="number"
                      min={start}
                      aria-label="Last line"
                      value={end}
                      onChange={(e) => setEnd(Number(e.target.value))}
                    />
                  </div>
                  <Button disabled={saving || !title.trim() || !body.trim()}>
                    Save explanation
                  </Button>
                </form>
              )}
            </aside>
          </>
        )}
      </main>
      <Dialog open={agentOpen} onOpenChange={setAgentOpen}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
          <DialogTitle>Understand {path}</DialogTitle>
          <DialogDescription>
            Explain code in {knowledge?.language ?? "French"}. Suggestions are
            reviewed before saving.
          </DialogDescription>
          <AgentConversation
            key={path}
            reviewId={reviewId}
            snapshot={snapshot}
            initialPath={path}
            actions={["file", "block", "glossary", "refresh"]}
            onApplied={() => {
              void reviewCommands
                .knowledge(snapshot.repositoryId)
                .then(setKnowledge)
                .catch((e) => onError(errorMessage(e)))
              onApplied()
            }}
          />
        </DialogContent>
      </Dialog>
      {knowledge &&
        document &&
        occurrenceSection &&
        document.sections.find((s) => s.id === occurrenceSection) && (
          <OccurrenceDialog
            section={document.sections.find((s) => s.id === occurrenceSection)!}
            terms={knowledge.terms}
            onClose={() => setOccurrenceSection(null)}
            onSave={(occurrence) => {
              void save({
                ...knowledge,
                documents: knowledge.documents.map((d) =>
                  d.id === document.id
                    ? {
                        ...d,
                        occurrences: [
                          ...d.occurrences.filter(
                            (o) =>
                              o.sectionId !== occurrence.sectionId ||
                              o.offset !== occurrence.offset
                          ),
                          occurrence,
                        ],
                      }
                    : d
                ),
              })
              setOccurrenceSection(null)
            }}
          />
        )}
    </div>
  )
}
