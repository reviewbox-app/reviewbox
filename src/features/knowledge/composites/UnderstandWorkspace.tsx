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
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  AiMagicIcon,
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  BookOpen01Icon,
  CodeIcon,
  MoreHorizontalIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import type {
  ProjectKnowledge,
  Snapshot,
  ExplanationDocument,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import {
  languageFor,
  languageName,
} from "@/features/review/helpers/review.helpers"
import { FileTree } from "../components/FileTree"
import { UnderstandTabs } from "../components/UnderstandTabs"
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
  const [adding, setAdding] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const highlight = useRef<editor.IEditorDecorationsCollection | null>(null)
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
  const hoveredSection = document?.sections.find((s) => s.id === hovered)
  // Hovering a section of the explanation highlights its lines in the code.
  useEffect(() => {
    if (!hoveredSection) {
      highlight.current?.clear()
      return
    }
    highlight.current?.set([
      {
        range: {
          startLineNumber: hoveredSection.startLine,
          endLineNumber: hoveredSection.endLine,
          startColumn: 1,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: "review-passage",
          marginClassName: "review-passage-margin",
        },
      },
    ])
  }, [hoveredSection])
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
        setAdding(false)
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
  const paths = snapshot.files
    .map((f) => f.path)
    .filter((p) => p.toLowerCase().includes(filter.toLowerCase()))
  const marks = Object.fromEntries(
    (knowledge?.documents ?? []).map((d) => [
      d.path,
      snapshot.files.find((f) => f.path === d.path)?.content.hash ===
      d.fingerprint
        ? ("explained" as const)
        : ("outdated" as const),
    ])
  )
  const nav = (
    <UnderstandTabs
      value={onboarding ? "tours" : glossary ? "glossary" : "files"}
      onChange={(view) => {
        setOnboarding(view === "tours")
        setGlossary(view === "glossary")
      }}
    />
  )
  if (onboarding)
    return (
      <OnboardingWorkspace
        repositoryId={snapshot.repositoryId}
        nav={nav}
        onClose={() => setOnboarding(false)}
      />
    )
  const folder = path.split("/").slice(0, -1).join("/")
  return (
    <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
      <aside className="flex w-[272px] shrink-0 flex-col gap-3 pb-2 max-[1100px]:w-[220px]">
        {nav}
        {glossary ? (
          <p className="px-3 text-sm leading-6 text-muted-foreground">
            Terms of this project, with every meaning Rev or you defined.
            Explanations link to them automatically.
          </p>
        ) : (
          <>
            <InputGroup className="mx-1 w-auto">
              <InputGroupAddon>
                <HugeiconsIcon icon={Search01Icon} size={14} />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Filter files"
                placeholder="Filter files"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </InputGroup>
            <nav
              aria-label="Snapshot files"
              className="min-h-0 flex-1 overflow-auto px-1"
            >
              <FileTree
                paths={paths}
                selected={path}
                marks={marks}
                onSelect={(value) => {
                  setPath(value)
                  setTargetLine(1)
                }}
              />
            </nav>
            <ul className="space-y-1 px-3 text-xs text-muted-foreground">
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-primary" />
                Explained
              </li>
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-review-attention" />
                Explanation outdated
              </li>
            </ul>
          </>
        )}
      </aside>
      <main className="flex min-w-0 flex-1 overflow-hidden rounded-panel border bg-card">
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
              <header className="flex h-12 shrink-0 items-center gap-3 border-b pr-3 pl-4">
                <HugeiconsIcon
                  icon={CodeIcon}
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 truncate text-sm" title={path}>
                  {path ? (
                    <>
                      {folder && (
                        <span className="text-muted-foreground">{folder}/</span>
                      )}
                      <span className="font-medium">
                        {path.split("/").at(-1)}
                      </span>
                    </>
                  ) : (
                    "No files in this snapshot"
                  )}
                </span>
                {path && (
                  <Badge variant="secondary">{languageName(path)}</Badge>
                )}
                <span className="flex-1" />
                {back.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const target = back.at(-1)!
                      setBack(back.slice(0, -1))
                      setPath(target.path)
                      setTargetLine(target.line)
                    }}
                  >
                    <HugeiconsIcon icon={ArrowLeft01Icon} />
                    Back
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={finding || !code}
                  onClick={() => void definition()}
                >
                  {finding ? "Finding…" : "Go to definition"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!file}
                  onClick={() => setAgentOpen(true)}
                >
                  <HugeiconsIcon icon={AiMagicIcon} />
                  Explain with Rev
                </Button>
              </header>
              <div className="min-h-0 flex-1">
                <CodeEditor
                  key={`${snapshot.id}/${path}`}
                  path={`reviewbox://${snapshot.id}/understand/${path}`}
                  height="100%"
                  onMount={(mounted) => {
                    editorRef.current = mounted
                    highlight.current = mounted.createDecorationsCollection()
                    mounted.revealLineInCenter(targetLine)
                    mounted.setPosition({ lineNumber: targetLine, column: 1 })
                  }}
                  value={code}
                  language={languageFor(path)}
                  theme={reviewboxTheme(resolvedTheme !== "light")}
                  options={{
                    readOnly: true,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    lineHeight: 20,
                    fontLigatures: false,
                    fontFamily: "var(--font-mono)",
                    padding: { top: 8 },
                    folding: false,
                    renderLineHighlight: "none",
                    scrollBeyondLastLine: false,
                    scrollbar: {
                      verticalScrollbarSize: 8,
                      horizontalScrollbarSize: 8,
                    },
                  }}
                />
              </div>
            </div>
            <aside className="flex w-[500px] shrink-0 flex-col border-l max-[1300px]:w-[360px]">
              <header className="flex h-12 shrink-0 items-center gap-2 border-b pr-3 pl-5">
                <HugeiconsIcon icon={BookOpen01Icon} size={16} />
                <h2 className="flex-1 text-sm font-medium">
                  In plain language
                </h2>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!file}
                  onClick={() => setAgentOpen(true)}
                >
                  <HugeiconsIcon icon={ArrowReloadHorizontalIcon} />
                  {document ? "Refresh" : "Explain"}
                </Button>
                {knowledge && (
                  <Popover>
                    <PopoverTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Explanation options"
                        />
                      }
                    >
                      <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-64">
                      <Label htmlFor="explanation-language">
                        Explanation language
                      </Label>
                      <Input
                        id="explanation-language"
                        defaultValue={knowledge.language}
                        onBlur={(e) => {
                          if (e.target.value !== knowledge.language)
                            void save({
                              ...knowledge,
                              language: e.target.value,
                            })
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        Applies to this project. The interface stays in English.
                      </p>
                    </PopoverContent>
                  </Popover>
                )}
              </header>
              <div className="min-h-0 flex-1 space-y-2 overflow-auto p-5">
                {document && (
                  <p className="pb-2 text-xs text-muted-foreground">
                    {path.split("/").at(-1)} · {languageName(path)} · written in{" "}
                    {document.language} · snapshot{" "}
                    {document.snapshotId.slice(0, 6)}
                  </p>
                )}
                {stale && (
                  <div className="flex gap-2.5 rounded-2xl bg-review-attention-soft p-3 text-sm leading-5">
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      size={16}
                      className="mt-0.5 shrink-0 text-review-attention"
                    />
                    This explanation refers to an older version of the file. Its
                    line links need review.
                  </div>
                )}
                {!document && (
                  <p className="text-sm leading-6 text-muted-foreground">
                    No explanation yet. Ask Rev to explain this file, or add
                    source-linked sections yourself. Glossary terms are linked
                    automatically.
                  </p>
                )}
                {knowledge &&
                  document?.sections.map((section, index) => (
                    <article
                      key={section.id}
                      onMouseEnter={() => setHovered(section.id)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(section.id)}
                      className={cn(
                        "group/section rounded-3xl p-4 transition-colors",
                        hovered === section.id && "bg-secondary"
                      )}
                    >
                      <h3 className="mb-1.5 flex items-baseline gap-3 text-sm font-medium">
                        <button
                          className="flex-1 text-left outline-none focus-visible:underline"
                          onClick={() =>
                            editorRef.current?.revealLineInCenter(
                              section.startLine
                            )
                          }
                        >
                          {index + 1} · {section.title}
                        </button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="-my-1 text-muted-foreground opacity-0 group-focus-within/section:opacity-100 group-hover/section:opacity-100"
                          onClick={() => setOccurrenceSection(section.id)}
                        >
                          Explain a word
                        </Button>
                        <span className="font-mono text-xs font-normal text-muted-foreground">
                          L{section.startLine}–{section.endLine}
                        </span>
                      </h3>
                      <GlossaryText
                        text={section.body}
                        terms={knowledge.terms}
                        occurrences={document.occurrences}
                        sectionId={section.id}
                      />
                    </article>
                  ))}
                {file && (
                  <Collapsible open={adding} onOpenChange={setAdding}>
                    {!adding && (
                      <CollapsibleTrigger
                        render={<Button variant="secondary" size="sm" />}
                      >
                        <HugeiconsIcon icon={Add01Icon} />
                        Add a section
                      </CollapsibleTrigger>
                    )}
                    <CollapsibleContent>
                      <form
                        className="space-y-3 rounded-3xl border p-4"
                        onSubmit={(e) => {
                          e.preventDefault()
                          addSection()
                        }}
                      >
                        <h3 className="text-sm font-medium">Add a section</h3>
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
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setAdding(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            disabled={saving || !title.trim() || !body.trim()}
                          >
                            Save section
                          </Button>
                        </div>
                      </form>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            </aside>
          </>
        )}
      </main>
      <Dialog open={agentOpen} onOpenChange={setAgentOpen}>
        <DialogContent className="flex h-[min(720px,85vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <div className="border-b px-6 pt-5 pb-4">
            <DialogTitle>Explain {path.split("/").at(-1)} with Rev</DialogTitle>
            <DialogDescription className="mt-1">
              Written in {knowledge?.language ?? "French"}. Rev’s suggestions
              are reviewed before they are saved.
            </DialogDescription>
          </div>
          <AgentConversation
            className="min-h-0 flex-1"
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
