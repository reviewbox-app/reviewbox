import { invoke } from "@tauri-apps/api/core"
import type { ReviewWritingProfile } from "@/lib/desktop/contracts.generated"
export const writingCommands = {
  get: (repositoryId?: string) =>
    invoke<ReviewWritingProfile | null>("review_writing_profile", {
      repositoryId: repositoryId ?? null,
    }),
  save: (
    repositoryId: string | undefined,
    profile: ReviewWritingProfile | null
  ) =>
    invoke<void>("save_review_writing_profile", {
      repositoryId: repositoryId ?? null,
      profile,
    }),
}
