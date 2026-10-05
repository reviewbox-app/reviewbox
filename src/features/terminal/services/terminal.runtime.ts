import type { Terminal } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"
import type { SearchAddon } from "@xterm/addon-search"
import { errorMessage } from "@/lib/desktop/review.commands"
import {
  openEditorFile,
  updateBuffer,
} from "@/features/code-editor/stores/editor.store"
import { useReviewWorkspaceStore } from "@/features/review/stores/useReviewWorkspace.store"
import { codeEditorOptions } from "@/lib/code/codeAppearance"
import { fileLinks, inputQueue } from "./terminal.helpers"
import { terminalCommands } from "./terminal.commands"
import { selectTerminal, useTerminalStore } from "./terminal.store"

type Runtime = {
  terminal: Terminal
  fit: FitAddon
  search: SearchAddon
  element: HTMLDivElement
  stop: () => void
  resize: () => void
}
const runtimes = new Map<string, Runtime>()
let connected: Promise<void> | undefined
/** A full WebView reload starts fresh shells; never leave inaccessible old jobs running. */
export function initializeTerminals() {
  connected ??= terminalCommands
    .list()
    .then(async (sessions) => {
      for (const session of sessions) {
        if (!runtimes.has(session.id)) await terminalCommands.close(session.id)
      }
    })
    .catch((error) => {
      connected = undefined
      throw error
    })
  return connected
}
const fail = (error: unknown) =>
  useTerminalStore.setState({ error: errorMessage(error) })
export const terminalRuntime = (id: string) => runtimes.get(id)

export async function createTerminal(
  repositoryId: string,
  container: HTMLElement
) {
  if (useTerminalStore.getState().creating) return
  useTerminalStore.setState({ creating: true, error: "" })
  let terminal: Terminal | undefined
  let element: HTMLDivElement | undefined
  try {
    await initializeTerminals()
    const [xterm, fitModule, searchModule, unicodeModule, linkModule] =
      await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-web-links"),
      ])
    terminal = new xterm.Terminal({
      scrollback: 10000,
      fontSize: 13,
      fontFamily: codeEditorOptions().fontFamily,
      fontWeight: Number(codeEditorOptions().fontWeight),
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: false,
      theme: terminalTheme(),
    })
    const term = terminal
    const fit = new fitModule.FitAddon()
    const search = new searchModule.SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new unicodeModule.Unicode11Addon())
    term.unicode.activeVersion = "11"
    term.loadAddon(
      new linkModule.WebLinksAddon((event, uri) => {
        event.preventDefault()
        void terminalCommands.openUrl(uri).catch(fail)
      })
    )
    element = document.createElement("div")
    element.className = "h-full min-h-0 w-full"
    container.replaceChildren(element)
    term.open(element)
    fit.fit()
    let ended: number | null | undefined
    let sessionId = ""
    let disposed = false
    const session = await terminalCommands.create(
      repositoryId,
      Math.max(1, term.cols),
      Math.max(1, term.rows),
      (event) => {
        if (disposed) return
        if (event.kind === "data") {
          term.write(new Uint8Array(event.bytes), () => {
            void terminalCommands.ack(event.id, event.sequence).catch(() => {})
          })
        } else if (event.kind === "exit") {
          ended = event.code
          term.options.disableStdin = true
          useTerminalStore.setState((s) => ({
            tabs: s.tabs.map((tab) =>
              tab.id === event.id
                ? { ...tab, exited: true, exitCode: event.code }
                : tab
            ),
          }))
        } else {
          fail(event.message)
        }
      }
    )
    sessionId = session.id
    const input = inputQueue(
      (bytes) => terminalCommands.write(sessionId, bytes),
      fail
    )
    const data = term.onData((value) =>
      input.send(new TextEncoder().encode(value))
    )
    const binary = term.onBinary((value) =>
      input.send(Uint8Array.from(value, (char) => char.charCodeAt(0)))
    )
    const links = term.registerLinkProvider({
      provideLinks(y, callback) {
        const text =
          term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ""
        callback(
          fileLinks(text).map((link) => ({
            text: link.text,
            range: { start: { x: link.start, y }, end: { x: link.end, y } },
            activate: (event: MouseEvent) => {
              event.preventDefault()
              void terminalCommands
                .resolveFile(sessionId, link.path, link.line, link.column)
                .then(async (target) => {
                  await openEditorFile(repositoryId, target.path)
                  updateBuffer(repositoryId, target.path, (buffer) => ({
                    ...buffer,
                    preview: false,
                    navigation: {
                      line: target.line,
                      column: target.column,
                      length: 0,
                      token: crypto.randomUUID(),
                    },
                  }))
                  useReviewWorkspaceStore.getState().setSpace("understand")
                })
                .catch(fail)
            },
          }))
        )
      },
    })
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const runtime: Runtime = {
      terminal: term,
      fit,
      search,
      element,
      stop() {
        disposed = true
        clearTimeout(resizeTimer)
        input.stop()
        data.dispose()
        binary.dispose()
        links.dispose()
        term.dispose()
        element?.remove()
      },
      resize() {
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          if (
            !runtime.element.isConnected ||
            !runtime.element.offsetWidth ||
            !runtime.element.offsetHeight
          )
            return
          fit.fit()
          void terminalCommands
            .resize(
              sessionId,
              Math.min(1000, Math.max(1, term.cols)),
              Math.min(500, Math.max(1, term.rows))
            )
            .catch(fail)
        }, 50)
      },
    }
    runtimes.set(sessionId, runtime)
    useTerminalStore.setState((s) => ({
      tabs: [
        ...s.tabs,
        {
          ...session,
          title: session.shell.split(/[\\/]/).at(-1) || "Terminal",
          ...(ended !== undefined ? { exited: true, exitCode: ended } : {}),
        },
      ],
    }))
    selectTerminal(repositoryId, sessionId)
    term.focus()
  } catch (error) {
    terminal?.dispose()
    element?.remove()
    fail(error)
  } finally {
    useTerminalStore.setState({ creating: false })
  }
}
export async function closeTerminal(id: string) {
  try {
    await terminalCommands.close(id)
    runtimes.get(id)?.stop()
    runtimes.delete(id)
    useTerminalStore.setState((s) => {
      const tab = s.tabs.find((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      return {
        tabs,
        ...(tab && s.active[tab.repositoryId] === id
          ? {
              active: {
                ...s.active,
                [tab.repositoryId]:
                  tabs.findLast((t) => t.repositoryId === tab.repositoryId)
                    ?.id ?? "",
              },
            }
          : {}),
      }
    })
  } catch (error) {
    fail(error)
  }
}
export function terminalTheme() {
  const light = !document.documentElement.classList.contains("dark")
  return light
    ? {
        background: "#fafafa",
        foreground: "#242424",
        cursor: "#242424",
        selectionBackground: "#005fcc40",
      }
    : {
        background: "#171717",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#64748b66",
      }
}
export function refreshTerminalThemes() {
  for (const runtime of runtimes.values()) {
    runtime.terminal.options = {
      theme: terminalTheme(),
      fontFamily: codeEditorOptions().fontFamily,
      fontWeight: Number(codeEditorOptions().fontWeight),
    }
    runtime.resize()
  }
}
