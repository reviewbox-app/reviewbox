import { listen } from "@tauri-apps/api/event"
import { desktopAvailable } from "./review.commands"

/** Native notifications are hints; focus and polling also verify freshness. */
export function subscribeRepositoryReads(
  repositoryId: string,
  refresh: () => void
) {
  if (!desktopAvailable()) return () => {}
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const subscription = listen<string>(
    "reviewbox:repository-read-invalidated",
    (event) => {
      if (disposed || event.payload !== repositoryId) return
      clearTimeout(timer)
      timer = setTimeout(refresh, 150)
    }
  ).catch(() => undefined)
  return () => {
    disposed = true
    clearTimeout(timer)
    void subscription.then((unlisten) => unlisten?.())
  }
}
