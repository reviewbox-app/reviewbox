"use client"
import { useCallback, useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  Attachment01Icon,
  CodeIcon,
  ComputerTerminal01Icon,
  Database01Icon,
  Folder01Icon,
  KeyboardIcon,
  PlugSocketIcon,
  SecurityCheckIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Kbd } from "@/components/ui/kbd"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { HarnessCard } from "@/features/agents/components/HarnessCard"
import { ProviderSettingsPanel } from "@/features/agents/composites/ProviderSettingsPanel"
import { LanguageServerSettingsPanel } from "@/features/language-servers/composites/LanguageServerSettingsPanel"
import { agentCommands } from "@/features/agents/services/agent.commands"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import type { ProviderStatus } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { SettingRow } from "../components/SettingRow"
import { ProjectSettingsPanel } from "./ProjectSettingsPanel"

const sections = [
  { id: "General", icon: Settings01Icon },
  { id: "Rev", icon: AiMagicIcon },
  { id: "Permissions", icon: SecurityCheckIcon },
  { id: "Context sent", icon: Attachment01Icon },
  { id: "Integrations", icon: PlugSocketIcon },
  { id: "Language servers", icon: CodeIcon },
  { id: "Storage", icon: Database01Icon },
  { id: "Shortcuts", icon: KeyboardIcon },
  { id: "Project", icon: Folder01Icon },
] as const
type Section = (typeof sections)[number]["id"]

const shortcuts = [
  ["Next / previous step", ["J", "K"]],
  ["Next / previous topic", ["]", "["]],
  ["Validate passage", ["V"]],
  ["Ask a question", ["Q"]],
  ["Add a note", ["N"]],
  ["Back to the step", ["Esc"]],
  ["Command palette", ["⌘K"]],
  ["Open a file of the snapshot", ["⌘P"]],
  ["Understand · Review · Resume", ["⌘1", "⌘2", "⌘3"]],
  ["Ask Rev about the selection", ["⌘L"]],
  ["Side-by-side diff", ["⌘\\"]],
  ["New review / open repository", ["⌘N", "⌘O"]],
  ["Confirm (forms, notes)", ["⌘↵"]],
] as const

const intro: Record<Section, string> = {
  General: "Appearance and language of ReviewBox on this Mac.",
  Rev: "Rev is ReviewBox’s review agent. It runs on a harness launched by the Rust backend; each provider handles its own sign-in — ReviewBox never sees your credentials.",
  Permissions: "What Rev and the commands you run are allowed to do.",
  "Context sent": "What leaves ReviewBox when you ask Rev something.",
  Integrations:
    "Enrich project reviews from other tools, with the app open or closed.",
  "Language servers":
    "Servers already installed on your Mac. They run on a copy of the frozen source files; ReviewBox installs nothing.",
  Storage: "Where reviews, tours and explanations are saved.",
  Shortcuts: "Every reading action has a shortcut.",
  Project:
    "Saved in .reviewbox and shared through Git. Executables and permissions stay in the application settings.",
}

export function SettingsDialog({
  open,
  onClose,
  standalone = false,
}: {
  open: boolean
  onClose: () => void
  standalone?: boolean
}) {
  const { theme, setTheme } = useTheme()
  const [section, setSection] = useState<Section>("General")
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [defaultProvider, setDefaultProvider] = useState("codex")
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState("")
  const load = useCallback(
    () =>
      Promise.all([reviewCommands.providers(), agentCommands.settings()])
        .then(([value, settings]) => {
          setProviders(value)
          setDefaultProvider(settings.defaultProvider)
          setError("")
        })
        .catch((e) => setError(errorMessage(e))),
    []
  )
  const detect = () => {
    setDetecting(true)
    void load().finally(() => setDetecting(false))
  }
  useEffect(() => {
    if (open) void load()
  }, [open, load])
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent
        className={cn(
          "flex gap-2 overflow-hidden p-2",
          standalone
            ? "inset-0 h-full w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-background before:hidden sm:max-w-none"
            : "h-[min(720px,85vh)] sm:max-w-[1040px]"
        )}
      >
        <nav
          aria-label="Settings sections"
          className={cn(
            "flex w-[212px] shrink-0 flex-col gap-0.5 p-2",
            standalone && "pt-10"
          )}
        >
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            ReviewBox runs locally. Your agent provider owns its authentication.
          </DialogDescription>
          {sections.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30",
                item.id === "Project" && "mt-4",
                section === item.id &&
                  "bg-accent text-foreground hover:bg-accent"
              )}
            >
              <HugeiconsIcon icon={item.icon} size={16} />
              {item.id}
            </button>
          ))}
        </nav>
        <section className="min-w-0 flex-1 overflow-auto rounded-panel border bg-card p-8 text-sm">
          <h2 className="text-xl font-medium">{section}</h2>
          <p className="mt-2 max-w-2xl leading-6 text-muted-foreground">
            {intro[section]}
          </p>
          <div className="mt-6 space-y-5">
            {section === "General" && (
              <div className="rounded-3xl border px-5">
                <SettingRow
                  title="Appearance"
                  description="ReviewBox is designed dark first; light stays available."
                >
                  <Tabs
                    value={theme ?? "dark"}
                    onValueChange={(value) => setTheme(String(value))}
                  >
                    <TabsList>
                      <TabsTrigger value="dark">Dark</TabsTrigger>
                      <TabsTrigger value="light">Light</TabsTrigger>
                      <TabsTrigger value="system">System</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </SettingRow>
                <SettingRow
                  title="Interface language"
                  description="Explanations use the language chosen per project."
                >
                  <span className="text-muted-foreground">English</span>
                </SettingRow>
              </div>
            )}
            {section === "Rev" && (
              <>
                {error && (
                  <p role="alert" className="text-destructive">
                    {error}
                  </p>
                )}
                {providers.map((provider) => (
                  <HarnessCard
                    key={provider.provider}
                    status={provider}
                    isDefault={provider.provider === defaultProvider}
                    busy={detecting}
                    onDetect={detect}
                  />
                ))}
                <ProviderSettingsPanel onSaved={detect} />
                <p className="text-xs text-muted-foreground">
                  Opening settings never starts a session. Rev starts on your
                  first request.
                </p>
              </>
            )}
            {section === "Permissions" && (
              <div className="rounded-3xl border px-5">
                <SettingRow
                  title="Read the snapshot"
                  description="Rev reads the frozen files you put in context."
                >
                  <Badge variant="secondary">Always allowed</Badge>
                </SettingRow>
                <SettingRow
                  title="Modify code"
                  description="Rev suggests; it never edits your repository."
                >
                  <Badge variant="secondary">Never</Badge>
                </SettingRow>
                <SettingRow
                  title="Run commands"
                  description="Each command shows its exact text and folder, and runs once. Approvals expire when the app closes."
                >
                  <Badge variant="secondary">Ask every time</Badge>
                </SettingRow>
                <SettingRow
                  title="Validate or resolve"
                  description="Only you validate passages and resolve questions."
                >
                  <Badge variant="secondary">Never</Badge>
                </SettingRow>
              </div>
            )}
            {section === "Context sent" && (
              <div className="rounded-3xl border px-5">
                <SettingRow
                  title="Frozen file contents"
                  description="Only the files you keep in context, as captured in the snapshot."
                />
                <SettingRow
                  title="Always excluded"
                  description="Environment files and private keys are never sent."
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    .env, *.pem, id_*
                  </span>
                </SettingRow>
                <SettingRow
                  title="Show the context before each request"
                  description="Ask Rev lists the context as badges; Preview shows the exact prompt."
                >
                  <Badge variant="secondary">Always</Badge>
                </SettingRow>
              </div>
            )}
            {section === "Integrations" && (
              <>
                <article className="space-y-3 rounded-3xl border p-5">
                  <h3 className="flex items-center gap-2 font-medium">
                    <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} />
                    Command line and MCP
                  </h3>
                  <p className="leading-6 text-muted-foreground">
                    Proposals wait for your approval before they change a
                    review. MCP uses stdio; no network port is opened.
                  </p>
                  <pre className="overflow-auto rounded-2xl bg-muted/60 p-4 font-mono text-xs leading-5">
                    {`reviewbox context --repo .\nreviewbox propose --repo . --from tour.json\nreviewbox mcp`}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    Use the application executable, or add its location to your
                    PATH.
                  </p>
                </article>
              </>
            )}
            {section === "Language servers" && <LanguageServerSettingsPanel />}
            {section === "Storage" && (
              <div className="rounded-3xl border px-5">
                <SettingRow
                  title="Project content"
                  description="Reviews, tours, explanations, comments and attributed decisions live in each project’s .reviewbox folder. Commit it to share them."
                />
                <SettingRow
                  title="On this Mac"
                  description="Preferences, raw agent conversations and caches. SQLite indexes project files locally."
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void reviewCommands
                        .revealStorage()
                        .catch((e) => setError(errorMessage(e)))
                    }
                  >
                    Reveal in Finder
                  </Button>
                </SettingRow>
                {error && (
                  <p role="alert" className="pb-4 text-destructive">
                    {error}
                  </p>
                )}
              </div>
            )}
            {section === "Shortcuts" && (
              <dl className="rounded-3xl border px-5">
                {shortcuts.map(([label, keys]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between border-b py-2.5 last:border-b-0"
                  >
                    <dt>{label}</dt>
                    <dd className="flex gap-1">
                      {keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {section === "Project" && <ProjectSettingsPanel />}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
