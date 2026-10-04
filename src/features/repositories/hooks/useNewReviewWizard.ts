"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { useProviderStatus } from "@/features/agents/hooks/useProviderStatus"
import { agentCommands } from "@/features/agents/services/agent.commands"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import type {
  ReadingLevel,
  CaptureProgress,
  CaptureRequest,
  PreparationMode,
  ProjectSettings,
  ReviewPreview,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import type { WizardStep } from "../components/NewReviewStepper"
import { useReadingPreferences } from "@/features/settings/hooks/useReadingPreferences"
import { creationCommands } from "../services/creation.commands"

import { subscribeRepositoryReads } from "@/lib/desktop/repositoryReads"
import { SessionReadCache } from "@/lib/desktop/sessionReadCache"

const previews = new SessionReadCache<ReviewPreview>(24)
const previewKey = (request: CaptureRequest) => JSON.stringify(request)

export interface CreatedReview {
  workspace: Workspace
  preparation: PreparationMode
  provider: string
  warning: string
  readingLevel: ReadingLevel
}

/** One mounted instance owns a draft and any capture it starts. */
export function useNewReviewWizard(
  repositoryId: string,
  onCreated: (result: CreatedReview) => void,
  onClose: () => void
) {
  const preferences = useReadingPreferences()
  const [readingLevel, setReadingLevel] = useState<ReadingLevel>(
    preferences.level
  )
  const providers = useProviderStatus()
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [request, setRequest] = useState<CaptureRequest>({
    repositoryId,
    scope: "local",
    base: "HEAD~1",
    target: "HEAD",
    includeUntracked: true,
  })
  const [step, setStep] = useState<WizardStep>("loading")
  const [setup, setSetup] = useState(false)
  const [skipped, setSkipped] = useState(false)
  const [provider, setProvider] = useState("codex")
  const [mode, setMode] = useState<PreparationMode>("rev")
  const [preview, setPreview] = useState<ReviewPreview | null>(
    () => previews.get(previewKey(request)) ?? null
  )
  const [previewing, setPreviewing] = useState(true)
  const [verified, setVerified] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState("")
  const [progress, setProgress] = useState<CaptureProgress | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const reading = useRef(false)
  const operation = useRef<string | null>(null)
  const disposed = useRef(false)
  const cancelRequested = useRef(false)
  const transition = useRef(false)
  useEffect(() => {
    disposed.current = false
    let alive = true
    reviewCommands
      .projectSettings(repositoryId)
      .then((value) => {
        if (!alive) return
        setSettings(value)
        setRequest((r) => ({
          ...r,
          scope: value.defaultScope,
          includeUntracked: value.includeUntracked,
        }))
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
      disposed.current = true
      if (operation.current)
        void creationCommands.cancel(operation.current).catch(() => {})
    }
  }, [repositoryId])

  // Initialization follows the first completed provider read. Later detections
  // update availability without changing the number/order of this draft's steps.
  if (step === "loading" && settings && !providers.checking) {
    const ready = providers.providers.filter((p) => p.ready)
    const chosen =
      ready.find((p) => p.provider === settings.provider) ??
      ready.find((p) => p.provider === providers.defaultProvider) ??
      ready[0]
    setSetup(!chosen)
    setStep(chosen ? "scope" : "rev")
    setProvider(chosen?.provider ?? providers.defaultProvider)
    setMode(chosen ? settings.defaultPreparation : "manual")
  }
  const selectedProvider =
    providers.providers.find((p) => p.provider === provider) ?? null
  const ready = !skipped && selectedProvider?.ready === true
  const effectiveMode = ready ? mode : "manual"
  const selected =
    preview?.scopes.find((s) => s.scope === request.scope) ?? null

  useEffect(() => {
    let alive = true
    let operationId: string | null = null
    const key = previewKey(request)
    const timer = setTimeout(async () => {
      reading.current = true
      const cached = previews.get(key)
      if (!cached) setPreviewing(true)
      setVerified(false)
      if (cached) setPreview(cached)
      try {
        operationId = crypto.randomUUID()
        const inventory = await creationCommands.preview(
          request,
          false,
          operationId
        )
        if (!alive) return
        setVerified(true)
        setPreview(inventory)
        previews.set(key, inventory)
        setPreviewing(false)
        if (
          inventory.scopes.find((scope) => scope.scope === request.scope)
            ?.detailsReady
        )
          return
        operationId = crypto.randomUUID()
        const detailed = await creationCommands.preview(
          request,
          true,
          operationId
        )
        if (!alive) return
        setPreview(detailed)
        previews.set(key, detailed)
      } catch (e) {
        if (alive) {
          setPreviewing(false)
          setError(errorMessage(e))
        }
      } finally {
        if (alive) reading.current = false
      }
    }, 150)
    return () => {
      alive = false
      reading.current = false
      clearTimeout(timer)
      if (operationId)
        void creationCommands.cancelRead(operationId).catch(() => {})
    }
  }, [request, refresh])
  useEffect(() => {
    const focus = () => {
      if (
        document.visibilityState === "visible" &&
        !operation.current &&
        !reading.current
      ) {
        setRefresh((n) => n + 1)
      }
    }
    const unsubscribe = subscribeRepositoryReads(repositoryId, focus)
    const interval = window.setInterval(focus, 30000)
    window.addEventListener("focus", focus)
    return () => {
      unsubscribe()
      window.clearInterval(interval)
      window.removeEventListener("focus", focus)
    }
  }, [repositoryId])

  const change = (patch: Partial<CaptureRequest>) => {
    setError("")
    setPreviewing(true)
    setVerified(false)
    setRequest((r) => ({ ...r, ...patch }))
  }
  const start = async () => {
    if (
      operation.current ||
      transition.current ||
      !selected?.files ||
      selected.error ||
      previewing ||
      !verified
    )
      return
    const id = crypto.randomUUID()
    operation.current = id
    cancelRequested.current = false
    setCapturing(true)
    setError("")
    setProgress(null)
    const normalized = {
      ...request,
      includeUntracked:
        (request.scope === "local" || request.scope === "unstaged") &&
        request.includeUntracked,
    }
    try {
      const workspace = await creationCommands.capture(
        normalized,
        id,
        (event) => {
          // The first event acknowledges native registration. A close can race
          // the initial invoke, so repeat cancellation once registration exists.
          if (cancelRequested.current || disposed.current)
            void creationCommands.cancel(id).catch(() => {})
          if (!disposed.current && operation.current === event.operationId)
            setProgress(event)
        }
      )
      if (disposed.current) return
      let warning = ""
      if (settings) {
        try {
          const currentSettings =
            await reviewCommands.projectSettings(repositoryId)
          await reviewCommands.configureProject(repositoryId, {
            ...currentSettings,
            defaultScope: request.scope,
            includeUntracked: request.includeUntracked,
            defaultPreparation: effectiveMode,
          })
        } catch (e) {
          warning = `The review was created, but its defaults could not be saved: ${errorMessage(e)}`
        }
      }
      if (!disposed.current)
        onCreated({
          workspace,
          preparation: effectiveMode,
          provider,
          warning,
          readingLevel:
            effectiveMode === "manual"
              ? "technical"
              : preferences.askEachReview
                ? readingLevel
                : preferences.level,
        })
    } catch (e) {
      if (!disposed.current) {
        if (
          cancelRequested.current &&
          typeof e === "object" &&
          e !== null &&
          "code" in e &&
          e.code === "cancelled"
        )
          onClose()
        else setError(errorMessage(e))
      }
    } finally {
      operation.current = null
      if (!disposed.current) {
        setCapturing(false)
        setCancelling(false)
      }
    }
  }
  const next = async () => {
    if (transition.current) return
    if (step === "rev") {
      if (!selectedProvider?.ready) return
      transition.current = true
      setAdvancing(true)
      setError("")
      try {
        const value = await agentCommands.settings()
        await agentCommands.configure({ ...value, defaultProvider: provider })
        if (!disposed.current) {
          setSkipped(false)
          setMode(settings?.defaultPreparation ?? "rev")
          setStep("scope")
        }
      } catch (e) {
        if (!disposed.current) setError(errorMessage(e))
      } finally {
        transition.current = false
        if (!disposed.current) setAdvancing(false)
      }
    } else if (
      step === "scope" &&
      selected?.files &&
      !selected.error &&
      !previewing &&
      verified
    )
      setStep("preparation")
    else if (step === "preparation") await start()
  }
  const close = useCallback(async () => {
    if (!operation.current) {
      onClose()
      return
    }
    cancelRequested.current = true
    setCancelling(true)
    try {
      await creationCommands.cancel(operation.current)
    } catch (e) {
      if (
        !disposed.current &&
        !(
          typeof e === "object" &&
          e !== null &&
          "code" in e &&
          (e.code === "capture_completed" || e.code === "capture_committing")
        )
      )
        setError(errorMessage(e))
    }
  }, [onClose])
  return {
    readingLevel,
    setReadingLevel,
    askReadingLevel: preferences.askEachReview,
    request,
    change,
    step,
    setStep,
    setup,
    provider,
    setProvider,
    providers,
    selectedProvider,
    ready,
    mode: effectiveMode,
    setMode,
    preview,
    selected,
    previewing,
    error,
    setError,
    progress,
    capturing,
    advancing,
    cancelling,
    close,
    next,
    skip: () => {
      setSkipped(true)
      setMode("manual")
      setStep("scope")
    },
    canNext:
      !advancing &&
      !capturing &&
      (step === "rev"
        ? selectedProvider?.ready === true
        : step !== "loading" &&
          !previewing &&
          verified &&
          !!selected?.files &&
          !selected.error),
  }
}
