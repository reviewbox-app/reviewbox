"use client"
import { useRef, useState } from "react"
import { emit } from "@tauri-apps/api/event"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { SettingRow } from "@/features/settings/components/SettingRow"
import type { ProviderSettings } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { HarnessCard } from "../components/HarnessCard"
import { HarnessUpdateDialog } from "../components/HarnessUpdateDialog"
import { useHarnessUpdate } from "../hooks/useHarnessUpdate"
import { useProviderStatus } from "../hooks/useProviderStatus"
import { harnessNames } from "../hooks/useRevStatus"
import { agentCommands } from "../services/agent.commands"
import { HarnessConfigurationDialog } from "./HarnessConfigurationDialog"

const harnessItems = Object.entries(harnessNames).map(([value, label]) => ({
  value,
  label,
}))

export function ProviderSettingsPanel() {
  const {
    providers,
    settings,
    defaultProvider,
    checking,
    error: detectionError,
    refresh,
  } = useProviderStatus()
  const update = useHarnessUpdate()
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [dialog, setDialog] = useState<{
    provider: string
    mode: "details" | "executable" | "update"
  } | null>(null)
  const selected = providers.find(
    (provider) => provider.provider === dialog?.provider
  )
  const config = settings?.providers.find(
    (provider) => provider.provider === dialog?.provider
  )
  const mutate = async (
    change: (latest: ProviderSettings) => ProviderSettings
  ) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    try {
      // Re-read before patching one field so another window's settings are preserved.
      const latest = await agentCommands.settings()
      await agentCommands.configure(change(latest))
      await refresh()
      await emit("reviewbox:providers-changed")
      setError("")
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  const redetect = async () => {
    await refresh()
    await emit("reviewbox:providers-changed").catch((e) =>
      setError(errorMessage(e))
    )
  }
  const closeUpdate = () => {
    void update.cancel()
    setDialog(null)
  }
  const checkingUpdates = update.checking
  const settingsBusy = busy || update.busy || checkingUpdates
  return (
    <div className="space-y-5">
      {!providers.length && checking && (
        <p
          role="status"
          className="flex items-center gap-2 text-muted-foreground"
        >
          <Spinner />
          Detecting harnesses…
        </p>
      )}
      <div className="space-y-2">
        {providers.map((status) => (
          <HarnessCard
            key={status.provider}
            status={status}
            isDefault={status.provider === defaultProvider}
            checking={checking}
            busy={settingsBusy}
            onDetails={() =>
              setDialog({ provider: status.provider, mode: "details" })
            }
            onChooseExecutable={() =>
              setDialog({ provider: status.provider, mode: "executable" })
            }
            onDetect={() => void redetect()}
            onUpdate={() => {
              void update.check(status.provider).then((result) => {
                if (result?.updateAvailable)
                  setDialog({ provider: status.provider, mode: "update" })
              })
            }}
          />
        ))}
      </div>
      {checkingUpdates && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner />
          Checking for updates…
        </p>
      )}
      {!checkingUpdates &&
        update.checked &&
        !update.checked.updateAvailable && (
          <p role="status" className="text-sm text-muted-foreground">
            {harnessNames[update.checked.status.provider]} is up to date (
            {update.checked.status.version}).
          </p>
        )}
      {!dialog && update.error && (
        <p role="alert" className="text-sm text-destructive">
          {update.error}
        </p>
      )}
      {(error || detectionError) && (
        <div className="space-y-2">
          <p role="alert" className="text-sm wrap-anywhere text-destructive">
            {error || detectionError}
          </p>
          {detectionError && (
            <Button
              variant="secondary"
              size="sm"
              disabled={checking}
              onClick={() => void redetect()}
            >
              Redetect
            </Button>
          )}
        </div>
      )}
      {settings && (
        <SettingRow
          title="Rev’s harness"
          description="Used by Rev for reading paths and explanations."
          className="flex-wrap gap-3 border-0 py-3 [&>div:first-child]:basis-48"
        >
          <Select
            items={harnessItems}
            value={defaultProvider}
            disabled={settingsBusy}
            onValueChange={(value) => {
              if (value && value !== defaultProvider)
                void mutate((latest) => ({
                  ...latest,
                  defaultProvider: value,
                })).catch((e) => setError(errorMessage(e)))
            }}
          >
            <SelectTrigger
              id="default-provider"
              aria-label="Rev’s harness"
              size="sm"
              className="w-60"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {harnessItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      )}
      <p className="text-xs text-muted-foreground">
        Rev starts on your first request.
      </p>
      {dialog && selected && config && dialog.mode !== "update" && (
        <HarnessConfigurationDialog
          key={`${dialog.provider}-${dialog.mode}`}
          mode={dialog.mode}
          status={selected}
          config={config}
          onClose={() => setDialog(null)}
          onSave={(patch) =>
            mutate((latest) => ({
              ...latest,
              providers: latest.providers.map((provider) =>
                provider.provider === dialog.provider
                  ? { ...provider, ...patch }
                  : provider
              ),
            }))
          }
        />
      )}
      {dialog?.mode === "update" && selected && update.checked && (
        <HarnessUpdateDialog
          status={update.checked.status}
          latestVersion={update.checked.latestVersion}
          busy={update.busy}
          event={update.event}
          error={update.error}
          completed={update.completed}
          onClose={closeUpdate}
          onCancel={() => void update.cancel()}
          onRetry={() => void update.start(update.checked!.status)}
          onChooseExecutable={() =>
            setDialog({ provider: selected.provider, mode: "executable" })
          }
        />
      )}
    </div>
  )
}
