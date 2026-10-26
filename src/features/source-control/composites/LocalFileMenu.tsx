"use client"
import { useState, type ReactElement } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  MinusSignIcon,
  ArrowReloadHorizontalIcon,
} from "@hugeicons/core-free-icons"
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import type { LocalFile } from "@/lib/desktop/contracts.generated"
import { FileMenu } from "@/features/file-tree/components/FileMenu"
import type { SourceControlSession } from "../hooks/useSourceControl"
import { sourceControlCommands as commands } from "../services/source-control.commands"

export function LocalFileMenu({
  row,
  path,
  folder,
  staged,
  targets,
  select,
  git,
  onStage,
  pendingPaths,
}: {
  row: ReactElement
  path: string
  folder: boolean
  staged: boolean
  targets: () => LocalFile[]
  select: (files: LocalFile[]) => void
  git: SourceControlSession
  onStage?: (files: LocalFile[], staged: boolean) => Promise<void>
  pendingPaths?: ReadonlySet<string>
}) {
  const [snapshot, setSnapshot] = useState<LocalFile[]>([])
  const [confirm, setConfirm] = useState(false)
  const repositoryId = git.state!.repositoryId
  const selections = snapshot.map(({ path, version }) => ({ path, version }))
  const disabled =
    !snapshot.length ||
    snapshot.some((file) => file.conflicted || pendingPaths?.has(file.path))
  const quickTargets = targets().filter((file) => folder || file.path === path)
  const noun = folder
    ? "folder"
    : snapshot.length > 1
      ? `${snapshot.length} files`
      : "file"
  return (
    <>
      <div className="group/stage relative [&:focus-within_[data-git-status]]:invisible [&:focus-within_[data-row-meta]]:invisible [&:hover_[data-git-status]]:invisible [&:hover_[data-row-meta]]:invisible">
        <FileMenu
          row={row}
          repositoryId={repositoryId}
          path={path}
          paths={folder ? [path] : snapshot.map((file) => file.path)}
          revealDisabled={!folder && snapshot.length !== 1}
          onError={git.setError}
          onOpenChange={(open) => {
            if (open) {
              const files = targets()
              setSnapshot(files)
              select(files)
            }
          }}
          before={
            <>
              <ContextMenuItem
                disabled={disabled}
                onClick={() =>
                  void (onStage
                    ? onStage(snapshot, staged)
                    : git.mutate(() =>
                        commands.stageFiles(repositoryId, selections, !staged)
                      ))
                }
              >
                <HugeiconsIcon icon={staged ? MinusSignIcon : Add01Icon} />
                {staged ? "Unstage" : "Stage"} {noun}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          }
          after={
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                disabled={git.busy || disabled || staged}
                onClick={() => setConfirm(true)}
              >
                <HugeiconsIcon icon={ArrowReloadHorizontalIcon} />
                Revert changes
              </ContextMenuItem>
            </>
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`${staged ? "Unstage" : "Stage"} ${folder ? "folder" : "file"} ${path}`}
          title={staged ? "Unstage" : "Stage"}
          disabled={
            !quickTargets.length ||
            quickTargets.some(
              (file) => file.conflicted || pendingPaths?.has(file.path)
            )
          }
          className="absolute top-0.5 right-1 z-10 opacity-0 group-focus-within/stage:opacity-100 group-hover/stage:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            const files = quickTargets
            void (onStage
              ? onStage(files, staged)
              : git.mutate(() =>
                  commands.stageFiles(
                    repositoryId,
                    files.map(({ path, version }) => ({ path, version })),
                    !staged
                  )
                ))
          }}
        >
          <HugeiconsIcon icon={staged ? MinusSignIcon : Add01Icon} size={14} />
        </Button>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert unstaged changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Restore these files to their staged version. Staged changes are
              preserved. Untracked files will be permanently deleted. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-60 overflow-auto text-sm">
            {snapshot.map((file) => (
              <li key={file.path} className="break-all">
                {file.path}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={git.busy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={async () => {
                if (
                  await git.mutate(() =>
                    commands.discard(repositoryId, selections)
                  )
                )
                  setConfirm(false)
              }}
            >
              Revert changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
