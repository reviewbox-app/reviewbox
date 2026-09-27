"use client"
import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  Copy01Icon,
  RefreshIcon,
  SecurityCheckIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { setupCommands } from "@/features/agents/services/setup.commands"
import { harnessNames } from "@/features/agents/hooks/useRevStatus"
import type {
  ProviderSetupEvent,
  ProviderStatus,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import { WizardColumns } from "../components/WizardColumns"

function statusLabel(status: ProviderStatus) {
  if (!status.available) return "Not detected"
  if (status.compatibility === "outdated") return "Update required"
  if (status.compatibility !== "compatible") return "Version unknown"
  if (status.authentication === "signedOut") return "Sign-in required"
  if (!status.ready) return "Could not verify"
  return "Ready · connected"
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  return (
    <div>
      <div className="flex min-w-0 items-center gap-2 rounded-2xl bg-secondary py-2 pr-2 pl-3.5">
        <code className="min-w-0 flex-1 text-xs break-all">{command}</code>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={copied ? "Command copied" : "Copy command"}
          onClick={() =>
            void navigator.clipboard
              .writeText(command)
              .then(() => {
                setCopied(true)
                setError("")
              })
              .catch(() =>
                setError(
                  "Could not copy. Select the command to copy it manually."
                )
              )
          }
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export function HarnessSetupStep({
  provider,
  providers,
  checking,
  error: detectionError,
  onSelect,
  onDetect,
}: {
  provider: string
  providers: ProviderStatus[]
  checking: boolean
  error: string
  onSelect: (provider: string) => void
  onDetect: () => void
}) {
  const status = providers.find((p) => p.provider === provider)
  const name = harnessNames[provider] ?? provider
  const [event, setEvent] = useState<ProviderSetupEvent | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [openingLogin, setOpeningLogin] = useState(false)
  const operation = useRef<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (operation.current)
        void setupCommands.cancel(operation.current).catch(() => {})
    }
  }, [])
  const install = async () => {
    if (operation.current || !status?.installation.canRun) return
    const id = crypto.randomUUID()
    operation.current = id
    setBusy(true)
    setError("")
    setEvent(null)
    try {
      await setupCommands.install(provider, id, (event) => {
        if (!alive.current) void setupCommands.cancel(id).catch(() => {})
        if (alive.current && operation.current === event.operationId)
          setEvent(event)
      })
      if (alive.current) onDetect()
    } catch (e) {
      if (alive.current) {
        setError(errorMessage(e))
        onDetect()
      }
    } finally {
      operation.current = null
      if (alive.current) setBusy(false)
    }
  }
  const login = async () => {
    setOpeningLogin(true)
    setError("")
    try {
      await setupCommands.login(provider)
    } catch (e) {
      if (alive.current) setError(errorMessage(e))
    } finally {
      if (alive.current) setOpeningLogin(false)
    }
  }
  const title = status?.ready
    ? `${name} is ready`
    : !status?.available
      ? `Install ${name} for Rev`
      : status.compatibility === "outdated"
        ? `Update ${name} for Rev`
        : status.authentication === "signedOut"
          ? `Connect ${name} for Rev`
          : `Set up ${name} for Rev`
  return (
    <WizardColumns
      left={
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-medium">Choose Rev’s harness</h3>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              {providers.some((p) => p.ready)
                ? "A harness is ready. You can add or change harnesses in Settings later."
                : "Rev needs Codex or Claude Code on this Mac. Choose a harness to get started."}
            </p>
          </div>
          <RadioGroup
            aria-label="Rev harness"
            value={provider}
            onValueChange={(value) => {
              onSelect(String(value))
              setError("")
              setEvent(null)
            }}
            className="gap-2"
          >
            {providers.map((p) => (
              <label
                key={p.provider}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-3xl border px-4 py-3.5",
                  p.provider === provider && "border-primary bg-accent"
                )}
              >
                <RadioGroupItem
                  value={p.provider}
                  disabled={busy}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="flex flex-1 items-center gap-1.5 text-sm font-medium">
                      <HugeiconsIcon icon={AiMagicIcon} size={16} />
                      {harnessNames[p.provider]}
                    </span>
                    <span
                      className={cn(
                        "text-xs",
                        p.ready
                          ? "text-review-validated"
                          : "text-muted-foreground"
                      )}
                    >
                      {statusLabel(p)}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {p.provider === "codex"
                      ? "Codex App Server, by OpenAI"
                      : "Claude Code CLI, by Anthropic"}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <Button
            size="sm"
            variant="secondary"
            disabled={checking || busy}
            onClick={onDetect}
          >
            {checking ? (
              <Spinner />
            ) : (
              <HugeiconsIcon icon={RefreshIcon} size={16} />
            )}
            Detect again
          </Button>
          {detectionError && (
            <p role="alert" className="text-sm text-destructive">
              {detectionError}
            </p>
          )}
        </div>
      }
      right={
        <div className="w-full max-w-[480px] space-y-6">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-muted">
            <HugeiconsIcon icon={AiMagicIcon} size={20} />
          </div>
          <div>
            <h3 className="text-xl font-medium">{title}</h3>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              {status?.ready
                ? "Rev will use it to suggest topics, explain code and answer your questions. You can change the harness in Settings."
                : `Rev runs on ${name}, installed on your Mac. Sign-in is handled by ${name}; ReviewBox does not store your credentials.`}
            </p>
          </div>
          {status?.ready ? (
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2">
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={16}
                  className="text-review-validated"
                />
                {status.version}
              </p>
              <p className="font-mono text-xs break-all text-muted-foreground">
                {status.executable}
              </p>
              <p>Connected in {name}</p>
              <p className="text-muted-foreground">
                Rev starts at your first request.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {status?.installation.command && (
                <div className="space-y-2">
                  <p className="text-sm">
                    1 · {status.installation.isUpdate ? "Update" : "Install"}{" "}
                    {name}
                  </p>
                  <CopyCommand command={status.installation.command} />
                </div>
              )}
              {status?.loginCommand && (
                <div className="space-y-2">
                  <p className="text-sm">2 · Sign in with your account</p>
                  <CopyCommand command={status.loginCommand} />
                </div>
              )}
              <p className="text-sm">
                3 · Come back here. ReviewBox detects it automatically.
              </p>
              {status?.installation.canRun &&
                (!status.available ||
                  status.compatibility !== "compatible") && (
                  <Button
                    className="w-full"
                    disabled={busy}
                    onClick={() => void install()}
                  >
                    {busy && <Spinner />}
                    {status.installation.isUpdate
                      ? `Update ${name}`
                      : `Install ${name}`}
                  </Button>
                )}
              {status?.available && status.compatibility === "compatible" && (
                <Button
                  className="w-full"
                  disabled={openingLogin || busy}
                  onClick={() => void login()}
                >
                  {openingLogin && <Spinner />}Sign in to {name}
                </Button>
              )}
              {status &&
                !status.installation.canRun &&
                (!status.available ||
                  status.compatibility !== "compatible") && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {status.installation.message}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        void reviewCommands
                          .openSettings()
                          .catch((e) => setError(errorMessage(e)))
                      }
                    >
                      Settings › Rev
                    </Button>
                  </div>
                )}
              {status?.available && (
                <p className="text-xs text-muted-foreground">
                  {status.message}
                </p>
              )}
            </div>
          )}
          {event && (
            <div role="status" className="flex items-start gap-2 text-sm">
              {busy && <Spinner className="mt-0.5 shrink-0" />}
              <span>{event.message}</span>
            </div>
          )}
          {busy && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (operation.current)
                  void setupCommands
                    .cancel(operation.current)
                    .catch((e) => setError(errorMessage(e)))
              }}
            >
              Cancel installation
            </Button>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      }
      notice={
        <div className="flex w-full max-w-[480px] gap-3 rounded-3xl border bg-card p-4">
          <HugeiconsIcon
            icon={SecurityCheckIcon}
            size={16}
            className="mt-0.5 shrink-0"
          />
          <div>
            <p className="text-sm font-medium">Local, no ReviewBox account</p>
            <p className="mt-1 text-xs text-muted-foreground">
              ReviewBox runs the harness on your Mac. Your account and
              subscription stay with the provider.
            </p>
          </div>
        </div>
      }
    />
  )
}
