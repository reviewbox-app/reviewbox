import { invoke, isTauri } from "@tauri-apps/api/core"
import { reportDiagnostic } from "./diagnostics"
import { diagnosticContext } from "./diagnostics.helpers"
import type {
  CaptureRequest,
  Coverage,
  FileContent,
  ProjectSettings,
  ProviderStatus,
  Repository,
  Review,
  ReviewAction,
  ReviewFreshness,
  Workspace,
} from "./contracts.generated"

let activeRepositoryId: string | null = null

export function setActiveRepository(repositoryId: string | null) {
  activeRepositoryId = repositoryId
}

export function desktopAvailable() {
  return isTauri()
}
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message)
  return String(error)
}
export async function call<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isTauri())
    return Promise.reject(
      new Error(
        "Open the desktop app to work with local repositories. Run bun run dev."
      )
    )
  const repositoryId =
    typeof args?.repositoryId === "string"
      ? args.repositoryId
      : activeRepositoryId
  try {
    return await invoke<T>(command, { repositoryId, ...args })
  } catch (error) {
    const entry = await reportDiagnostic(
      error,
      "native",
      command,
      diagnosticContext({ ...args, repositoryId })
    )
    // Preserve the rejection and its classification for existing consumers.
    if (
      entry &&
      error &&
      typeof error === "object" &&
      Object.isExtensible(error)
    ) {
      try {
        Object.defineProperty(error, "diagnosticId", {
          value: entry.id,
          enumerable: true,
          configurable: true,
        })
      } catch {
        /* A frozen/provider object still keeps its original error. */
      }
    }
    throw error
  }
}
export const reviewCommands = {
  projectSettings: (repositoryId: string) =>
    call<ProjectSettings>("project_settings", { repositoryId }),
  configureProject: (repositoryId: string, settings: ProjectSettings) =>
    call<ProjectSettings>("configure_project", { repositoryId, settings }),
  openSettings: () => call<void>("open_settings"),
  revealStorage: () => call<void>("reveal_storage"),
  repositories: () => call<Repository[]>("list_repositories"),
  choose: () => call<string | null>("choose_repository"),
  open: (path: string) => call<Repository>("open_repository", { path }),
  forget: (id: string) => call<void>("forget_repository", { id }),
  reviews: (repositoryId: string) =>
    call<Review[]>("list_reviews", { repositoryId }),
  create: (request: CaptureRequest) =>
    call<Workspace>("create_review", { request }),
  load: (id: string, repositoryId?: string) =>
    call<Workspace>("load_review", {
      id,
      ...(repositoryId ? { repositoryId } : {}),
    }),
  update: (id: string, revision: number, action: ReviewAction) =>
    call<Workspace>("update_review", { id, revision, action }),
  refresh: (id: string, revision: number) =>
    call<Workspace>("refresh_review", { id, revision }),
  delete: (id: string) => call<void>("delete_review", { id }),
  content: (snapshotId: string, changeId: string) =>
    call<FileContent>("read_change", { snapshotId, changeId }),
  coverage: (id: string) => call<Coverage>("review_coverage", { id }),
  freshness: (id: string, repositoryId: string) =>
    call<ReviewFreshness>("check_review_freshness", { id, repositoryId }),
  changed: (snapshotId: string) =>
    call<boolean>("check_repository_changed", { snapshotId }),
  file: (snapshotId: string, path: string) =>
    call<string>("read_snapshot_file", { snapshotId, path }),
  providers: () => call<ProviderStatus[]>("provider_status"),
}
