"use client"
import { useEffect, useState } from "react"
import type { LanguageServerCatalogue } from "@/lib/desktop/contracts.generated"
import type * as L from "vscode-languageserver-protocol"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { codeLanguages, resolveLanguageId } from "@/lib/code/languages"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import {
  updateBuffer,
  updateEditor,
  getEditor,
  bufferLanguage,
  bufferLanguageDecision,
  fileAssociation,
  type EditorBuffer,
} from "@/features/code-editor/stores/editor.store"
import { catalogueCommands } from "../services/catalogue.commands"
import {
  restartLiveEditor,
  languageDiagnostic,
  useLiveLanguages,
  searchWorkspaceSymbols,
  openWorkspaceSymbol,
} from "../services/liveMonaco"
import { useLanguageRegistry } from "../services/languageRegistry.service"
import { LanguageSetupDialog } from "./LanguageSetupDialog"
import { EditorProjectSettings } from "./EditorProjectSettings"
import { useEditorLanguageDetection } from "../hooks/useEditorLanguageDetection"

const detectionLabels = {
  manual: "Selected for this file",
  association: "Local file association",
  filename: "Detected from filename",
  extension: "Detected from extension",
  firstLine: "Detected from first line",
  project: "Detected from nearby project sources",
  content: "Detected locally from content",
  plaintext: "No confident language detected",
}

export function EditorLanguageStatus({
  repositoryId,
  buffer,
}: {
  repositoryId: string
  buffer: EditorBuffer
}) {
  useEditorLanguageDetection(repositoryId, buffer)
  const state =
    useLiveLanguages((s) => s.status[buffer.id]) ?? "Syntax highlighting"
  const registry = useLanguageRegistry((s) => s.registry)
  const saveNotice = useLiveLanguages((s) => s.saveNotices[buffer.id])
  const capabilities = useLiveLanguages((s) => s.capabilities[buffer.id])
  const [servers, setServers] = useState<LanguageServerCatalogue["entries"]>([])
  const [setup, setSetup] = useState(false)
  const [error, setError] = useState("")
  const [installing, setInstalling] = useState<string | null>(null)
  const [installId, setInstallId] = useState<string | null>(null)
  const [symbols, setSymbols] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<L.SymbolInformation[]>([])
  const language = bufferLanguage(repositoryId, buffer)
  const detection = bufferLanguageDecision(repositoryId, buffer)
  const candidates =
    buffer.detectedLanguage?.path === buffer.path
      ? buffer.detectedLanguage.candidates
      : []
  const lspId = resolveLanguageId(language).lspId
  const selectedServer = getEditor(repositoryId)?.servers[lspId] ?? ""
  useEffect(() => {
    let alive = true
    void catalogueCommands
      .read()
      .then((catalogue) => {
        if (alive)
          setServers(
            catalogue.entries.filter((e) => e.languages.includes(lspId))
          )
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [lspId, installId, registry])
  useEffect(() => {
    if (!installId) return
    const timer = setInterval(() => {
      void catalogueCommands
        .read()
        .then((catalogue) => {
          const operation = catalogue.operations.find((o) => o.id === installId)
          if (!operation) return
          setInstalling(operation.message)
          if (
            ["ready", "failed", "interrupted", "cancelled"].includes(
              operation.status
            )
          ) {
            setInstallId(null)
            setInstalling(null)
            if (operation.status === "ready")
              void restartLiveEditor(buffer.id).catch((e) =>
                setError(errorMessage(e))
              )
            else setError(operation.message)
          }
        })
        .catch((e) => setError(errorMessage(e)))
    }, 500)
    return () => clearInterval(timer)
  }, [installId, buffer.id])
  useEffect(() => {
    if (!symbols) return
    let alive = true
    const timer = setTimeout(() => {
      void searchWorkspaceSymbols(buffer.id, query).then((value) => {
        if (alive) setResults(value)
      })
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [symbols, query, buffer.id])
  const enable = async () => {
    setError("")
    try {
      const catalogue = await catalogueCommands.read()
      const lspId =
        codeLanguages.find((l) => l.id === language)?.lspId ?? language
      const entry = catalogue.entries.find((e) =>
        selectedServer ? e.id === selectedServer : e.languages.includes(lspId)
      )
      if (!entry) {
        setSetup(true)
        return
      }
      if (entry.installedVersion && !entry.enabled) {
        await catalogueCommands.enable(entry.id, true)
        await restartLiveEditor(buffer.id)
        return
      }
      const operation = await catalogueCommands.install(entry.id)
      setInstalling(operation.message)
      setInstallId(operation.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          aria-label="File language"
          title={detectionLabels[detection.source]}
          className="max-w-32 rounded-md bg-transparent"
          value={language}
          onChange={(e) => {
            const value = e.target.value
            // The detector inputs have not changed when automatic is already active.
            if (value === "automatic" && !buffer.language) return
            updateBuffer(repositoryId, buffer.id, (b) => ({
              ...b,
              language: value === "automatic" ? undefined : value,
              detectedLanguage: undefined,
            }))
            void restartLiveEditor(buffer.id).catch((e) =>
              setError(errorMessage(e))
            )
          }}
        >
          <option value="automatic">Detect automatically</option>
          <option value="plaintext">Plain text</option>
          {candidates.length > 0 && (
            <optgroup label="Suggested from content">
              {candidates.map((candidate) => (
                <option key={candidate.languageId} value={candidate.languageId}>
                  {resolveLanguageId(candidate.languageId).name} (
                  {Math.round(candidate.confidence * 100)}%)
                </option>
              ))}
            </optgroup>
          )}
          {codeLanguages
            .filter(
              (l) =>
                !candidates.some((candidate) => candidate.languageId === l.id)
            )
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
        {detection.source === "plaintext" && buffer.detectedLanguage?.error && (
          <span
            className="text-muted-foreground"
            title={buffer.detectedLanguage.error}
          >
            Detection unavailable
          </span>
        )}
        <Button
          size="xs"
          variant="ghost"
          title="Save this file association for this checkout"
          onClick={() => {
            updateEditor(repositoryId, (s) => ({
              ...s,
              associations: {
                ...s.associations,
                [fileAssociation(buffer.path)]: language,
              },
            }))
          }}
        >
          Use for {fileAssociation(buffer.path)}
        </Button>
        {servers.length > 1 && (
          <select
            aria-label="Language server"
            className="max-w-36 bg-transparent"
            value={selectedServer}
            onChange={(e) => {
              updateEditor(repositoryId, (s) => ({
                ...s,
                servers: { ...s.servers, [lspId]: e.target.value },
              }))
              void restartLiveEditor(buffer.id).catch((e) =>
                setError(errorMessage(e))
              )
            }}
          >
            <option value="">Automatic server</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <span
          role="status"
          className="max-w-72 truncate"
          title={error || installing || saveNotice || state}
        >
          {error || installing || saveNotice || state}
        </span>
        {!buffer.readOnly &&
          state !== "Language support active" &&
          !state.startsWith("Indexing") &&
          !installId && (
            <Button size="xs" variant="ghost" onClick={() => void enable()}>
              Enable language support
            </Button>
          )}
        {installId && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void catalogueCommands.cancel(installId)}
          >
            Cancel installation
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => setSetup(true)}>
          Configure with Rev
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void restartLiveEditor(buffer.id).catch((e) =>
              setError(errorMessage(e))
            )
          }
        >
          Restart
        </Button>
        {state === "Language support active" && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void restartLiveEditor(buffer.id, true)}
          >
            Stop
          </Button>
        )}
        {!!capabilities?.workspaceSymbolProvider && (
          <Button size="xs" variant="ghost" onClick={() => setSymbols(true)}>
            Project symbols
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void reviewCommands.openSettings()}
        >
          Settings
        </Button>
        <EditorProjectSettings
          repositoryId={repositoryId}
          buffer={buffer}
          preferredServerId={selectedServer || undefined}
          serverId={
            servers.find((s) => s.status === "ready")?.id || servers[0]?.id
          }
        />
      </div>
      {setup && (
        <LanguageSetupDialog
          repositoryId={repositoryId}
          path={buffer.path}
          diagnostic={languageDiagnostic(buffer.id)}
          onClose={() => setSetup(false)}
          onApplied={() =>
            void restartLiveEditor(buffer.id).catch((e) =>
              setError(errorMessage(e))
            )
          }
        />
      )}
      <Dialog open={symbols} onOpenChange={setSymbols}>
        <DialogContent>
          <DialogTitle>Project symbols</DialogTitle>
          <DialogDescription>
            Search symbols exposed by the active language server.
          </DialogDescription>
          <Input
            aria-label="Search symbols"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="max-h-80 overflow-auto">
            {results.map((s, i) => (
              <Button
                key={i}
                className="w-full justify-start"
                variant="ghost"
                onClick={() => {
                  void openWorkspaceSymbol(buffer.id, s)
                  setSymbols(false)
                }}
              >
                {s.name}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
