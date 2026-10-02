import { Channel } from "@tauri-apps/api/core"
import { call } from "@/lib/desktop/review.commands"
import type {
  CaptureProgress,
  CaptureRequest,
  RepositoryRef,
  ReviewPreview,
  Workspace,
} from "@/lib/desktop/contracts.generated"

export const creationCommands = {
  preview: (request: CaptureRequest, details: boolean, operationId: string) =>
    call<ReviewPreview>("preview_review", { request, details, operationId }),
  cancelRead: (operationId: string) =>
    call<void>("cancel_repository_read", { operationId }),
  references: (repositoryId: string, query: string) =>
    call<RepositoryRef[]>("review_references", { repositoryId, query }),
  capture(
    request: CaptureRequest,
    operationId: string,
    onProgress: (event: CaptureProgress) => void
  ) {
    const channel = new Channel<CaptureProgress>()
    channel.onmessage = onProgress
    return call<Workspace>("create_review_operation", {
      request,
      operationId,
      channel,
    })
  },
  cancel: (operationId: string) =>
    call<void>("cancel_review_creation", { operationId }),
}
