import { Channel } from "@tauri-apps/api/core"
import { call } from "@/lib/desktop/review.commands"
import type {
  AgentEvent,
  GitCommitDetail,
  GitCommitRequest,
  GitOperation,
  LocalFileDiff,
  LocalGitState,
  LocalFileSelection,
} from "@/lib/desktop/contracts.generated"

/** Shared with commit entry points, which outlive the overview's controls. */
export const pendingGitRefreshes = new Map<string, Promise<void>>()
export async function waitForGitRefresh(repositoryId: string) {
  await pendingGitRefreshes.get(repositoryId)
}

export const sourceControlCommands = {
  recoverLock: (repositoryId: string) =>
    call<void>("recover_git_lock", { repositoryId }),
  clearPlans: (repositoryId: string) =>
    call<void>("clear_git_plans", { repositoryId }),
  branches: (repositoryId: string) =>
    call<string[]>("list_git_branches", { repositoryId }),
  switchBranch: (repositoryId: string, branch: string) =>
    call<void>("switch_git_branch", { repositoryId, branch }),
  state: (repositoryId: string) =>
    call<LocalGitState>("local_git_state", { repositoryId }),
  diff: (repositoryId: string, path: string, layer: string, version: string) =>
    call<LocalFileDiff>("local_file_diff", {
      repositoryId,
      path,
      layer,
      version,
    }),
  stage: (
    repositoryId: string,
    path: string,
    version: string,
    staged: boolean
  ) =>
    call<LocalGitState>("stage_local_file", {
      repositoryId,
      path,
      version,
      staged,
    }),
  stageFiles: (
    repositoryId: string,
    files: LocalFileSelection[],
    staged: boolean
  ) =>
    call<LocalGitState>("stage_local_files", { repositoryId, files, staged }),
  discard: (repositoryId: string, files: LocalFileSelection[]) =>
    call<LocalGitState>("discard_local_files", { repositoryId, files }),
  detail: (repositoryId: string, oid: string) =>
    call<GitCommitDetail>("git_commit_detail", { repositoryId, oid }),
  fetch: (repositoryId: string, force: boolean) =>
    call<LocalGitState>("fetch_git_remote", { repositoryId, force }),
  push: (repositoryId: string, branch: string, remote: string | null) =>
    call<LocalGitState>("push_git_branch", { repositoryId, branch, remote }),
  commit: (
    request: GitCommitRequest,
    onProgress: (state: GitOperation) => void,
    onActivity: (event: AgentEvent) => void
  ) => {
    const channel = new Channel<GitOperation>()
    channel.onmessage = onProgress
    const activity = new Channel<AgentEvent>()
    activity.onmessage = onActivity
    return call<GitOperation>("commit_local_changes", {
      request,
      channel,
      activity,
    })
  },
  cancel: (operationId: string) =>
    call<void>("cancel_git_operation", { operationId }),
  lastOperation: (repositoryId: string) =>
    call<GitOperation | null>("last_git_operation", { repositoryId }),
}
