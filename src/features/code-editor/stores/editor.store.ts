"use client"
import {
  loadTreeNavigation,
  treeNavigation,
  updateTreeNavigation,
} from "@/features/file-tree/services/navigation.service"
import { create } from "zustand"
import { mergeRepositoryChanges } from "@/lib/desktop/repositoryReads"
import type {
  EditorEntry,
  RepositoryReadChange,
  EditorFile,
  EditorRecovery,
  EditorSaveActions,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { isDocumentFile } from "@/features/markdown/helpers/documentFiles.helpers"
import { resolveLanguageId, type LanguageDecision } from "@/lib/code/languages"
import type { ContentLanguageDetection } from "@/features/language-servers/helpers/languageDetection"
import { detectProjectLanguage } from "@/features/language-servers/helpers/projectLanguage"
import { editorCommands } from "../services/editor.commands"

export interface EditorBuffer extends EditorFile {
  id: string
  baseText: string
  version: number
  external?: EditorFile | null
  preview: boolean
  language?: string
  detectedLanguage?: ContentLanguageDetection
  navigation?: { line: number; column: number; length: number; token: string }
}
export interface EditorSession {
  entries: EditorEntry[]
  buffers: EditorBuffer[]
  active: string
  filter: string
  searchMode: "file" | "content"
  showIgnored: boolean
  ignoredPaths: ReadonlySet<string>
  toggledFolders: ReadonlySet<string>
  saveActions?: Record<string, EditorSaveActions>
  autoSave: boolean
  associations: Record<string, string>
  servers: Record<string, string>
  ready: boolean
  watchHealthy?: boolean
  error: string
}
export const useEditorStore = create<{
  sessions: Record<string, EditorSession>
}>(() => ({ sessions: {} }))
const initial = (): EditorSession => ({
  entries: [],
  buffers: [],
  active: "",
  filter: "",
  searchMode: "file",
  showIgnored: true,
  ignoredPaths: new Set(),
  toggledFolders: new Set(),
  autoSave: false,
  associations: {},
  servers: {},
  ready: false,
  error: "",
})
export const dirty = (buffer: EditorBuffer) => buffer.text !== buffer.baseText
export const getEditor = (id: string) => useEditorStore.getState().sessions[id]
export function updateEditor(
  id: string,
  update: (current: EditorSession) => EditorSession
) {
  useEditorStore.setState((state) => {
    const next = update(state.sessions[id] ?? initial())
    return next === state.sessions[id]
      ? state
      : { sessions: { ...state.sessions, [id]: next } }
  })
}
export function updateBuffer(
  id: string,
  key: string,
  update: (buffer: EditorBuffer) => EditorBuffer
) {
  updateEditor(id, (s) => {
    let changed = false
    const buffers = s.buffers.map((b) => {
      const next = b.id === key ? update(b) : b
      changed ||= next !== b
      return next
    })
    return changed ? { ...s, buffers } : s
  })
}
export const editorError = (id: string, error: unknown) =>
  updateEditor(id, (s) =>
    s.error === errorMessage(error) ? s : { ...s, error: errorMessage(error) }
  )
export const recoveryVersions = new Map<string, number>()
const pending = new Map<string, Promise<void>>()
export async function initializeEditor(id: string) {
  if (getEditor(id)?.ready) return
  const key = `init/${id}`
  if (pending.has(key)) return pending.get(key)
  updateEditor(id, (s) => s)
  const work = (async () => {
    await loadTreeNavigation(id)
    const tree = treeNavigation(id, "editor")
    const recovery = await editorCommands.recovery(id)
    recoveryVersions.set(id, recovery.revision)
    const buffers: EditorBuffer[] = []
    for (const path of new Set([
      ...recovery.paths,
      ...recovery.drafts.map((d) => d.path),
    ])) {
      const draft = recovery.drafts.find((d) => d.path === path)
      try {
        const file = await editorCommands.read(id, path)
        buffers.push({
          ...file,
          id: crypto.randomUUID(),
          version: 1,
          preview: isDocumentFile(path),
          baseText: draft?.baseText ?? file.text,
          text: draft?.text ?? file.text,
          revision: draft?.revision ?? file.revision,
          external:
            draft && draft.revision !== file.revision ? file : undefined,
        })
      } catch {
        if (draft)
          buffers.push({
            ...draft,
            uri: "",
            readOnly: false,
            reason: null,
            baseText: draft.baseText,
            id: crypto.randomUUID(),
            version: 1,
            preview: false,
            external: null,
          })
      }
    }
    updateEditor(id, (s) => ({
      ...s,
      buffers,
      active: recovery.active ?? buffers[0]?.path ?? "",
      toggledFolders: new Set(tree?.expandedPaths ?? []),
      saveActions: recovery.saveActions ?? {},
      autoSave: recovery.autoSave,
      associations: recovery.associations ?? {},
      servers: recovery.servers ?? {},
      ready: true,
    }))
    await refreshEditor(id)
  })().finally(() => pending.delete(key))
  pending.set(key, work)
  return work
}
export async function openEditorFile(
  id: string,
  path: string,
  activate = true
) {
  if (getEditor(id)?.buffers.some((b) => b.path === path)) {
    if (activate) updateEditor(id, (s) => ({ ...s, active: path }))
    return
  }
  const key = `open/${id}/${path}`
  if (pending.has(key)) {
    await pending.get(key)
    if (activate) updateEditor(id, (s) => ({ ...s, active: path }))
    return
  }
  const work = (async () => {
    const file = await editorCommands.read(id, path)
    updateEditor(id, (s) => ({
      ...s,
      active: activate ? path : s.active,
      buffers: [
        ...s.buffers,
        {
          ...file,
          id: crypto.randomUUID(),
          baseText: file.text,
          version: 1,
          preview: isDocumentFile(path),
        },
      ],
    }))
  })().finally(() => pending.delete(key))
  pending.set(key, work)
  return work
}
export function editBuffer(id: string, key: string, text: string) {
  updateBuffer(id, key, (b) =>
    b.text === text ? b : { ...b, text, version: b.version + 1 }
  )
}
export type SaveReason = "manual" | "all" | "close" | "automatic"
export async function saveBuffer(
  id: string,
  key: string,
  overwrite = false,
  reason: SaveReason = "manual"
) {
  const lock = `save/${id}/${key}`
  if (pending.has(lock)) {
    await pending.get(lock)
    return saveBuffer(id, key, overwrite, reason)
  }
  let buffer = getEditor(id)?.buffers.find((b) => b.id === key)
  if (!buffer || buffer.readOnly || (reason === "automatic" && !dirty(buffer)))
    return
  if (buffer.external !== undefined && !overwrite)
    throw new Error("Compare the external changes before saving.")
  if (buffer.external === null)
    throw new Error(
      "This file was deleted. Recreate it or copy the draft into a new file."
    )
  const work = (async () => {
    if (reason === "manual" || reason === "all") {
      const { prepareLiveSave } =
        await import("@/features/language-servers/services/liveMonaco")
      await prepareLiveSave(id, key)
      buffer = getEditor(id)?.buffers.find((b) => b.id === key)
    }
    if (!buffer || buffer.readOnly || !dirty(buffer)) return
    if (buffer.external !== undefined && !overwrite)
      throw new Error("Compare the external changes before saving.")
    if (buffer.external === null)
      throw new Error(
        "This file was deleted. Recreate it or copy the draft into a new file."
      )
    const saving = buffer
    await editorCommands.mutate(id, {
      kind: "save",
      path: saving.path,
      text: saving.text,
      expectedRevision: overwrite ? saving.external!.revision : saving.revision,
    })
    const saved = await editorCommands.read(id, saving.path)
    const sameText =
      saved.text.replace(/\r\n?/g, "\n") === saving.text.replace(/\r\n?/g, "\n")
    updateBuffer(id, key, (b) => ({
      ...b,
      baseText: sameText ? saving.text : saving.baseText,
      revision: sameText ? saved.revision : saving.revision,
      external: sameText ? undefined : saved,
    }))
  })()
    .catch(async (error) => {
      await refreshEditor(id)
      throw error
    })
    .finally(() => pending.delete(lock))
  pending.set(lock, work)
  return work
}
export async function saveAllEditors(
  repositoryId?: string,
  reason: SaveReason = "all"
) {
  for (const [id, session] of Object.entries(
    useEditorStore.getState().sessions
  )) {
    if (repositoryId && id !== repositoryId) continue
    for (const buffer of session.buffers)
      if (dirty(buffer)) await saveBuffer(id, buffer.id, false, reason)
  }
}
const queuedRefreshes = new Map<string, RepositoryReadChange>()
export async function refreshEditor(id: string, change?: RepositoryReadChange) {
  const key = `refresh/${id}`
  queuedRefreshes.set(
    id,
    mergeRepositoryChanges(
      queuedRefreshes.get(id),
      change ?? {
        repositoryId: id,
        paths: [],
        tree: true,
        git: true,
        full: true,
      }
    )
  )
  if (pending.has(key)) return pending.get(key)
  const work = (async () => {
    // Keep events received during I/O: they must run after the current read.
    while (queuedRefreshes.has(id)) {
      const change = queuedRefreshes.get(id)!
      queuedRefreshes.delete(id)
      await reconcileEditor(id, change)
    }
  })().finally(() => {
    pending.delete(key)
    // Also cover events queued between the last await and promise settlement.
    const trailing = queuedRefreshes.get(id)
    if (trailing) return refreshEditor(id, trailing)
  })
  pending.set(key, work)
  return work
}

async function reconcileEditor(id: string, change: RepositoryReadChange) {
  const before = getEditor(id)
  if (!before) return
  if (change.tree || change.full) {
    const showIgnored = before.showIgnored
    const entries = await editorCommands.inventory(
      id,
      showIgnored,
      [...before.toggledFolders],
      change
    )
    const folders = new Set(
      entries.filter((entry) => entry.directory).map((entry) => entry.path)
    )
    const retained = [...before.toggledFolders].filter(
      (path) =>
        folders.has(path) ||
        entries.some((entry) => entry.lazy && path.startsWith(`${entry.path}/`))
    )
    if (retained.length !== before.toggledFolders.size) {
      updateEditor(id, (s) => ({ ...s, toggledFolders: new Set(retained) }))
      updateTreeNavigation(id, "editor", (tree) => ({
        ...tree,
        expandedPaths: retained,
      }))
    }
    const ignoredPaths = new Set(
      entries.filter((entry) => entry.ignored).map((entry) => entry.path)
    )
    updateEditor(id, (s) => {
      if (s.showIgnored !== showIgnored) return s
      const sameEntries =
        entries.length === s.entries.length &&
        entries.every(
          (entry, i) =>
            entry.path === s.entries[i].path &&
            entry.directory === s.entries[i].directory &&
            entry.revision === s.entries[i].revision &&
            entry.ignored === s.entries[i].ignored &&
            entry.excluded === s.entries[i].excluded &&
            entry.lazy === s.entries[i].lazy
        )
      const sameIgnored =
        ignoredPaths.size === s.ignoredPaths.size &&
        [...ignoredPaths].every((path) => s.ignoredPaths.has(path))
      return sameEntries && sameIgnored
        ? s
        : {
            ...s,
            entries: sameEntries ? s.entries : entries,
            ignoredPaths: sameIgnored ? s.ignoredPaths : ignoredPaths,
          }
    })
  }
  for (const old of getEditor(id).buffers) {
    if (old.readOnly && old.path.startsWith("file:")) continue
    if (
      !change.full &&
      !change.paths.some(
        (path) => old.path === path || old.path.startsWith(path + "/")
      )
    )
      continue
    try {
      const file = await editorCommands.read(id, old.path)
      updateBuffer(id, old.id, (b) =>
        b.path !== old.path || b.revision !== old.revision
          ? b
          : b.revision === file.revision
            ? b.uri === file.uri &&
              b.readOnly === file.readOnly &&
              b.reason === file.reason &&
              b.external === undefined
              ? b
              : {
                  ...b,
                  uri: file.uri,
                  readOnly: file.readOnly,
                  reason: file.reason,
                  external: undefined,
                }
            : dirty(b)
              ? b.external?.revision === file.revision
                ? b
                : { ...b, external: file }
              : {
                  ...b,
                  ...file,
                  baseText: file.text,
                  version: b.version + 1,
                  external: undefined,
                }
      )
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "file_not_found"
      )
        updateBuffer(id, old.id, (b) =>
          b.path === old.path && b.external !== null
            ? { ...b, external: null }
            : b
        )
      else editorError(id, error)
    }
  }
}
export function editorRecovery(s: EditorSession): EditorRecovery {
  return {
    revision: 0,
    saveActions: s.saveActions ?? {},
    autoSave: s.autoSave,
    associations: s.associations,
    servers: s.servers,
    active: s.active || null,
    paths: s.buffers
      .filter((b) => !b.path.startsWith("file:"))
      .map((b) => b.path),
    drafts: s.buffers
      .filter((b) => dirty(b) && !b.readOnly)
      .map((b) => ({
        path: b.path,
        text: b.text,
        baseText: b.baseText,
        revision: b.revision,
      })),
  }
}
export function closeBuffer(id: string, key: string) {
  updateEditor(id, (s) => {
    const buffer = s.buffers.find((b) => b.id === key)
    const buffers = s.buffers.filter((b) => b.id !== key)
    return {
      ...s,
      buffers,
      active:
        s.active === buffer?.path ? (buffers.at(-1)?.path ?? "") : s.active,
    }
  })
}

export function fileAssociation(path: string) {
  const name = path.split("/").at(-1) ?? path
  return name.includes(".")
    ? `*.${name.split(".").at(-1)!.toLowerCase()}`
    : name
}
export function bufferLanguage(repository: string, buffer: EditorBuffer) {
  return bufferLanguageDecision(repository, buffer).language.id
}
export function bufferLanguageDecision(
  repository: string,
  buffer: EditorBuffer
): LanguageDecision {
  const session = getEditor(repository)
  const association = session?.associations[fileAssociation(buffer.path)]
  if (buffer.language || association)
    return {
      language: resolveLanguageId(buffer.language ?? association),
      source: buffer.language ? "manual" : "association",
      candidates: [],
    }
  const decision = detectProjectLanguage(
    buffer.path,
    buffer.text.split("\n", 1)[0],
    session?.entries ?? []
  )
  const detected = buffer.detectedLanguage
  if (
    decision.source === "plaintext" &&
    detected?.path === buffer.path &&
    detected.languageId
  )
    return {
      language: resolveLanguageId(detected.languageId),
      source: "content",
      candidates: [],
    }
  return decision
}

/** Reorder existing models without changing their identity or the active file. */
export function moveEditorBuffer(
  buffers: EditorBuffer[],
  source: string,
  target: string,
  after: boolean
) {
  if (source === target) return buffers
  const buffer = buffers.find((b) => b.id === source)
  if (!buffer || !buffers.some((b) => b.id === target)) return buffers
  const next = buffers.filter((b) => b.id !== source)
  const position = next.findIndex((b) => b.id === target) + Number(after)
  next.splice(position, 0, buffer)
  return next
}
