"use client"
import { useState } from "react"
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
import { ProviderSettingsPanel } from "@/features/agents/composites/ProviderSettingsPanel"
import { LanguageServerSettingsPanel } from "@/features/language-servers/composites/LanguageServerSettingsPanel"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import { SettingRow } from "../components/SettingRow"
import { CodeAppearanceSettings } from "../components/CodeAppearanceSettings"
import { ReadingSettings } from "../components/ReadingSettings"
import { ProjectSettingsPanel } from "./ProjectSettingsPanel"

const sections = [
  { id: "General", icon: Settings01Icon },
  { id: "Reading", icon: CodeIcon },
  { id: "Rev", icon: AiMagicIcon },
  { id: "Permissions", icon: SecurityCheckIcon },
  { id: "Context sent", icon: Attachment01Icon },
  { id: "Integrations", icon: PlugSocketIcon },
  { id: "Languages", icon: CodeIcon },
  { id: "Storage", icon: Database01Icon },
  { id: "Shortcuts", icon: KeyboardIcon },
  { id: "Project", icon: Folder01Icon },
] as const
type Section = (typeof sections)[number]["id"]

const shortcuts = [
  ["Next / previous step or file", ["J", "K"]],
  ["Next / previous topic", ["]", "["]],
  ["Validate the step", ["V"]],
  ["Switch document / code", ["D"]],
  ["Command palette", ["⌘K"]],
  ["Open a review file", ["⌘P"]],
  ["Home · Review · Code Explain", ["⌘1", "⌘2", "⌘3"]],
  ["Side-by-side diff", ["⌘\\"]],
  ["New review / open repository", ["⌘N", "⌘O"]],
  ["Confirm (forms)", ["⌘↵"]],
] as const

const intro: Record<Section, string> = {
  General: "Appearance and language of ReviewBox on this Mac.",
  Reading:
    "Choose how Rev explains changes. Your reading mode stays on this Mac.",
  Rev: "Rev helps you review and understand code using your chosen harness. Sign-in stays with the provider; ReviewBox has no account of its own.",
  Permissions: "What Rev and the commands you run are allowed to do.",
  "Context sent": "Context used to prepare review explanations.",
  Integrations:
    "Enrich project reviews from other tools, with the app open or closed.",
  Languages:
    "Install and manage language tools for richer code reading. Servers work with the captured source files.",
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
  const [error, setError] = useState("")
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
            ? "inset-0 h-full w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-background backdrop-filter-none sm:max-w-none"
            : "h-[min(720px,85vh)] sm:max-w-[1040px]"
        )}
      >
        {standalone && (
          <div
            aria-hidden
            data-tauri-drag-region
            className="absolute top-0 left-0 h-10 w-[228px]"
          />
        )}
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
        <section
          className={cn(
            "min-w-0 flex-1 overflow-auto rounded-panel border bg-card p-8 text-sm",
            section === "Rev" && "py-6"
          )}
        >
          <h2 className="text-xl font-medium">{section}</h2>
          <p
            className={cn(
              "mt-2 max-w-2xl leading-6 text-muted-foreground",
              section === "Rev" && "mt-1.5 leading-5"
            )}
          >
            {intro[section]}
          </p>
          <div className={cn("mt-6 space-y-5", section === "Rev" && "mt-5")}>
            {section === "General" && (
              <div className="rounded-3xl border px-5">
                <CodeAppearanceSettings />
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
            {section === "Reading" && <ReadingSettings />}
            {section === "Rev" && <ProviderSettingsPanel />}
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
                  title="Validate a review"
                  description="Only you validate steps and files. Rev does not make reading decisions."
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
            {section === "Languages" && <LanguageServerSettingsPanel />}
            {section === "Storage" && (
              <div className="rounded-3xl border px-5">
                <SettingRow
                  title="Project content"
                  description="Reviews, tours, explanations and attributed decisions live in each project’s .reviewbox folder. Commit it to share them."
                />
                <SettingRow
                  title="On this Mac"
                  description="Preferences, resumable preparation tasks and caches. SQLite indexes project files locally."
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
