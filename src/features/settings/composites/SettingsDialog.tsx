"use client"
import { ProjectSettingsPanel } from "./ProjectSettingsPanel"
import { ProviderSettingsPanel } from "@/features/agents/composites/ProviderSettingsPanel"
import { LanguageServerSettingsPanel } from "@/features/language-servers/composites/LanguageServerSettingsPanel"
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import type { ProviderStatus } from "@/lib/desktop/contracts.generated"
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
  const [tab, setTab] = useState("General")
  const [scope, setScope] = useState<"application" | "project">("application")
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [error, setError] = useState("")
  useEffect(() => {
    if (!open) return
    let alive = true
    reviewCommands
      .providers()
      .then((v) => {
        if (alive) setProviders(v)
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [open])
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent
        className={
          standalone
            ? "inset-0 h-full w-full max-w-none translate-x-0 translate-y-0 grid-rows-[auto_1fr] rounded-none border-0 sm:max-w-none"
            : "h-[min(720px,85vh)] grid-rows-[auto_1fr] sm:max-w-4xl"
        }
      >
        <div>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            ReviewBox runs locally. Your agent provider owns its authentication.
          </DialogDescription>
        </div>
        <div className="flex min-h-0 flex-col gap-5">
          <div className="flex gap-2">
            <Button
              variant={scope === "application" ? "secondary" : "ghost"}
              onClick={() => setScope("application")}
            >
              Application
            </Button>
            <Button
              variant={scope === "project" ? "secondary" : "ghost"}
              onClick={() => setScope("project")}
            >
              Project
            </Button>
          </div>
          {scope === "project" ? (
            <ProjectSettingsPanel />
          ) : (
            <div className="flex min-h-0 flex-1 gap-8">
              <nav className="w-40 shrink-0 space-y-1">
                {[
                  "General",
                  "Agents",
                  "Permissions",
                  "Language servers",
                  "Integrations",
                  "Storage",
                  "Shortcuts",
                ].map((item) => (
                  <Button
                    key={item}
                    variant={tab === item ? "secondary" : "ghost"}
                    className="w-full justify-start"
                    onClick={() => setTab(item)}
                  >
                    {item}
                  </Button>
                ))}
              </nav>
              <section className="min-w-0 flex-1 overflow-auto text-sm leading-6">
                <h2 className="mb-5 text-lg font-medium">{tab}</h2>
                {tab === "General" && (
                  <>
                    <p className="mb-3 text-muted-foreground">Appearance</p>
                    <div className="flex gap-2">
                      {["dark", "light", "system"].map((value) => (
                        <Button
                          key={value}
                          variant={theme === value ? "default" : "outline"}
                          onClick={() => setTheme(value)}
                        >
                          {value}
                        </Button>
                      ))}
                    </div>
                    <p className="mt-6 text-muted-foreground">
                      Interface: English. Explanation language is set per
                      project in Understand.
                    </p>
                  </>
                )}
                {tab === "Language servers" && <LanguageServerSettingsPanel />}
                {tab === "Agents" && (
                  <div className="space-y-4">
                    {error && <p role="alert">{error}</p>}
                    {providers.map((provider) => (
                      <div
                        className="rounded-xl border p-4"
                        key={provider.provider}
                      >
                        <div className="flex justify-between font-medium">
                          <span>{provider.provider}</span>
                          <span>
                            {provider.available ? "Installed" : "Unavailable"}
                          </span>
                        </div>
                        <p className="mt-2 font-mono text-xs">
                          {provider.version}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {provider.message}
                        </p>
                      </div>
                    ))}
                    <ProviderSettingsPanel
                      onSaved={() =>
                        void reviewCommands
                          .providers()
                          .then(setProviders)
                          .catch((e) => setError(errorMessage(e)))
                      }
                    />
                    <p className="text-muted-foreground">
                      No agent session starts when opening settings. Start an
                      analysis from the review inspector.
                    </p>
                  </div>
                )}
                {tab === "Permissions" && (
                  <div className="space-y-4">
                    <p>Code modification: disabled.</p>
                    <p className="text-muted-foreground">
                      Agents cannot validate passages or resolve your questions.
                      Test execution always shows the exact command and requires
                      a one-time approval. Approvals expire when the app closes.
                    </p>
                  </div>
                )}
                {tab === "Integrations" && (
                  <div className="space-y-4">
                    <p>
                      CLI and MCP can create and enrich project reviews with the
                      app open or closed. Use proposals when you want to approve
                      content first.
                    </p>
                    <pre className="overflow-auto rounded-xl border p-3 text-xs">
                      reviewbox context --repo .{"\n"}reviewbox propose --repo .
                      --from proposal.json{"\n"}reviewbox mcp
                    </pre>
                    <p className="text-xs text-muted-foreground">
                      Use the application executable or add its location to your
                      PATH. MCP uses stdio; no network port is opened.
                    </p>
                  </div>
                )}
                {tab === "Storage" && (
                  <div className="space-y-4">
                    <p>
                      Project content is saved in its .reviewbox folder.
                      Personal preferences, raw agent conversations and caches
                      stay on this machine.
                    </p>
                    <p className="text-muted-foreground">
                      Commit .reviewbox with your project to share reviews,
                      tours, explanations, comments and attributed decisions.
                      SQLite indexes these files locally.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void reviewCommands
                          .revealStorage()
                          .catch((e) => setError(errorMessage(e)))
                      }
                    >
                      Reveal storage folder
                    </Button>
                    {error && (
                      <p role="alert" className="text-sm text-destructive">
                        {error}
                      </p>
                    )}
                  </div>
                )}
                {tab === "Shortcuts" && (
                  <dl className="grid grid-cols-2 gap-3">
                    {[
                      ["⌘O", "Open repository"],
                      ["⌘N", "New review"],
                      ["⌘K / ⌘P", "Find a file"],
                      ["⌘1 / 2 / 3", "Understand / Review / Resume"],
                      ["J / K", "Next / previous passage"],
                      ["V", "Validate passage"],
                      ["N / Q", "Note / question"],
                      ["Esc", "Return from coverage"],
                    ].map(([key, value]) => (
                      <div className="contents" key={key}>
                        <dt className="font-mono text-xs">{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
