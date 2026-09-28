"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  LanguageServerCatalogueEntry,
  LanguageServerInstallOperation,
} from "@/lib/desktop/contracts.generated"
import {
  activeInstallation,
  capabilityLabels,
} from "../helpers/languageCatalogue.helpers"
import { catalogueCommands } from "../services/catalogue.commands"

export function LanguageServerCatalogueRow({
  entry,
  operation,
  recommended,
  busy,
  act,
  onCustomSetup,
}: {
  entry: LanguageServerCatalogueEntry
  operation?: LanguageServerInstallOperation
  recommended: boolean
  busy: boolean
  act: (id: string, task: () => Promise<unknown>) => Promise<void>
  onCustomSetup: () => void
}) {
  const installing = activeInstallation(operation?.status)
  const capabilities = capabilityLabels(entry)
  return (
    <li className="space-y-2 py-4" data-server-id={entry.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{entry.name}</span>
          {recommended && <Badge variant="secondary">Recommended</Badge>}
          {entry.preview && <Badge variant="secondary">Preview</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">
          {entry.installedVersion
            ? `${entry.installedVersion} · ${entry.enabled ? "Enabled" : "Disabled"}`
            : entry.supported
              ? entry.version
              : entry.setupRequired
                ? "Manual setup required"
                : "Unavailable on this platform"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{entry.description}</p>
      {entry.runtime && (
        <p className="text-xs text-muted-foreground">{entry.runtime}</p>
      )}
      {entry.prerequisites.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Requires: {entry.prerequisites.join(" · ")}
        </p>
      )}
      {entry.setupRequired && (
        <p className="text-xs text-muted-foreground">{entry.setupRequired}</p>
      )}
      {capabilities.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {capabilities.join(" · ")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {installing && operation ? (
          <>
            <span className="text-xs text-muted-foreground" role="status">
              {operation.message}
              {operation.totalBytes
                ? ` · ${Math.floor((Number(operation.downloadedBytes) / Number(operation.totalBytes)) * 100)}%`
                : ""}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() =>
                void act(entry.id, () => catalogueCommands.cancel(operation.id))
              }
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            {entry.installedVersion ? (
              <>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(entry.id, () =>
                      catalogueCommands.enable(entry.id, !entry.enabled)
                    )
                  }
                >
                  {entry.enabled ? "Disable" : "Enable"}
                </Button>
                {(entry.id === "swift" ||
                  entry.version !== entry.installedVersion) && (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy || !entry.supported}
                    onClick={() =>
                      void act(entry.id, () =>
                        catalogueCommands.install(entry.id)
                      )
                    }
                  >
                    {entry.id === "swift" ? "Detect toolchain" : "Update"}
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(entry.id, () =>
                      catalogueCommands.uninstall(entry.id)
                    )
                  }
                >
                  Remove
                </Button>
              </>
            ) : entry.setupRequired ? (
              <Button size="xs" variant="secondary" onClick={onCustomSetup}>
                Custom setup
              </Button>
            ) : (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy || !entry.supported}
                onClick={() =>
                  void act(entry.id, () => catalogueCommands.install(entry.id))
                }
              >
                {entry.id === "swift" ? "Detect toolchain" : "Install"}
              </Button>
            )}
          </>
        )}
      </div>
      {entry.error && <p className="text-xs text-destructive">{entry.error}</p>}
    </li>
  )
}
