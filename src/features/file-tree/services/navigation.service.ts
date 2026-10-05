import { create } from "zustand"
import { call, desktopAvailable } from "@/lib/desktop/review.commands"
import type {
  CheckoutNavigation,
  FileTreeNavigation,
} from "@/lib/desktop/contracts.generated"

export const navigationCommands = {
  load: (repositoryId: string) =>
    call<CheckoutNavigation>("editor_navigation", { repositoryId }),
  save: (repositoryId: string, navigation: CheckoutNavigation) =>
    call<CheckoutNavigation>("editor_store_navigation", {
      repositoryId,
      navigation,
    }),
}

export const emptyTree = (): FileTreeNavigation => ({
  expandedPaths: [],
  selectedPath: null,
  scrollTop: 0,
  mode: "all",
})
export const useTreeNavigation = create<{
  checkouts: Record<string, CheckoutNavigation>
}>(() => ({ checkouts: {} }))
const loads = new Map<string, Promise<void>>()
const queues = new Map<string, Promise<unknown>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const versions = new Map<string, number>()
const emptyCheckout = (): CheckoutNavigation => ({ revision: 0, trees: {} })

export function loadTreeNavigation(repositoryId: string) {
  if (useTreeNavigation.getState().checkouts[repositoryId])
    return Promise.resolve()
  const pending = loads.get(repositoryId)
  if (pending) return pending
  const work = (
    desktopAvailable()
      ? navigationCommands.load(repositoryId)
      : Promise.resolve(emptyCheckout())
  )
    .then((navigation) => {
      versions.set(repositoryId, navigation.revision)
      useTreeNavigation.setState((s) => ({
        checkouts: { ...s.checkouts, [repositoryId]: navigation },
      }))
    })
    .finally(() => loads.delete(repositoryId))
  loads.set(repositoryId, work)
  return work
}
export function treeNavigation(repositoryId: string, key: string) {
  return useTreeNavigation.getState().checkouts[repositoryId]?.trees[key]
}
export function flushTreeNavigation(repositoryId: string) {
  clearTimeout(timers.get(repositoryId))
  const work = (queues.get(repositoryId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const current = useTreeNavigation.getState().checkouts[repositoryId]
      if (!current || !desktopAvailable()) return
      const saved = await navigationCommands.save(repositoryId, {
        ...current,
        revision: versions.get(repositoryId) ?? current.revision,
      })
      versions.set(repositoryId, saved.revision)
    })
  queues.set(repositoryId, work)
  return work
}
export function updateTreeNavigation(
  repositoryId: string,
  key: string,
  update: (tree: FileTreeNavigation) => FileTreeNavigation
) {
  useTreeNavigation.setState((s) => {
    const current = s.checkouts[repositoryId]
    if (!current) return s
    const trees = {
      ...current.trees,
      [key]: update(current.trees[key] ?? emptyTree()),
    }
    // Old captured reviews must not grow the private navigation document forever.
    while (Object.keys(trees).length > 100) {
      const oldest = Object.keys(trees).find(
        (item) => item !== key && item.startsWith("review:")
      )
      if (!oldest) break
      delete trees[oldest]
    }
    return {
      checkouts: { ...s.checkouts, [repositoryId]: { ...current, trees } },
    }
  })
  clearTimeout(timers.get(repositoryId))
  timers.set(
    repositoryId,
    setTimeout(
      () => void flushTreeNavigation(repositoryId).catch(() => {}),
      200
    )
  )
}
export function remapTreeNavigation(
  repositoryId: string,
  from: string,
  destination?: string
) {
  const remap = (path: string) =>
    path === from || path.startsWith(`${from}/`)
      ? destination === undefined
        ? null
        : destination + path.slice(from.length)
      : path
  for (const key of Object.keys(
    useTreeNavigation.getState().checkouts[repositoryId]?.trees ?? {}
  ))
    updateTreeNavigation(repositoryId, key, (tree) => ({
      ...tree,
      expandedPaths: tree.expandedPaths
        .map(remap)
        .filter((p): p is string => p !== null),
      selectedPath: tree.selectedPath ? remap(tree.selectedPath) : null,
    }))
}
