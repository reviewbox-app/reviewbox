import { reportDiagnostic } from "@/lib/desktop/diagnostics"

/** App lifetime subscription; returning cleanup also handles React strict mode. */
export function observeRuntimeErrors(
  target: Window,
  report = reportDiagnostic
) {
  const onError = (event: ErrorEvent) => {
    if (event.error || event.message)
      void report(event.error ?? event.message, "frontend", "window.error")
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    void report(event.reason, "frontend", "unhandledrejection")
  }
  target.addEventListener("error", onError)
  target.addEventListener("unhandledrejection", onRejection)
  return () => {
    target.removeEventListener("error", onError)
    target.removeEventListener("unhandledrejection", onRejection)
  }
}
