"use client"
import { useExplorerSearch } from "@/features/file-tree/components/ExplorerSearchProvider"
import { useSourceInspection } from "@/features/language-servers/hooks/useSourceInspection"
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import * as monaco from "monaco-editor/editor/editor.api"
import type { editor } from "monaco-editor"
import { useTheme } from "next-themes"
import { useCodeTheme, codeEditorOptions } from "@/lib/code/codeAppearance"
import { ensureCodeLanguage } from "@/lib/code/highlighter"
import { useEditorLanguageServices } from "@/features/language-servers/hooks/useEditorLanguageServices"
import type {
  BlockDiffProps,
  CodeBlock,
  CodePoint,
  CodeSide,
} from "../contracts/blockDiff.types"
import {
  codeBlocks,
  containingBlock,
  currentLine,
} from "../helpers/blockDiff.helpers"
import { BlockDiffZones } from "../services/BlockDiffZones"
import { useSourceLanguage } from "@/features/language-servers/hooks/useSourceLanguage"
import { BlockDiffSearch } from "./BlockDiffSearch"
import surface from "./editor-surface.module.css"
import "./block-diff.css"
import "./change-decorations.css"
import { bindReadOnlyFeatures } from "@/features/editor-extensions/services/readOnlyFeatures"
import { bindChangeDecorations } from "../services/changeDecorations"

type Runtime = {
  main: editor.IStandaloneCodeEditor
  diff: editor.IStandaloneDiffEditor
  zones: BlockDiffZones
  before: editor.ITextModel
  after: editor.ITextModel
  blocks: CodeBlock[]
  ready: boolean
  pending?: {
    point: CodePoint
    end?: number
    column?: number
    endColumn?: number
  }
}
type Match = { side: CodeSide; range: monaco.Range }

export function BlockDiffRuntime(props: BlockDiffProps) {
  const explorerSearch = useExplorerSearch()?.search
  const searchExplorer = useRef(explorerSearch)
  useLayoutEffect(() => {
    searchExplorer.current = explorerSearch
  }, [explorerSearch])
  const language = useSourceLanguage(
    props.sourcePath ?? props.afterDocument?.path ?? props.beforeDocument?.path,
    props.after || props.before,
    props.language
  )
  const host = useRef<HTMLDivElement>(null)
  const engineHost = useRef<HTMLDivElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const { resolvedTheme } = useTheme()
  const theme = useCodeTheme(resolvedTheme !== "light")
  const beforeInspection = useSourceInspection(
    props.inspectionRepositoryId && props.sourcePath
      ? { repositoryId: props.inspectionRepositoryId, path: props.sourcePath }
      : undefined
  )
  const afterInspection = useSourceInspection(
    props.inspectionRepositoryId && props.sourcePath
      ? { repositoryId: props.inspectionRepositoryId, path: props.sourcePath }
      : undefined
  )
  const beforeServices = useEditorLanguageServices(props.beforeDocument)
  const afterServices = useEditorLanguageServices(props.afterDocument)
  const [search, setSearch] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<Match[]>([])
  const [index, setIndex] = useState(0)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState("")
  const reveal = useCallback(
    (point: CodePoint, end?: number, column = 1, endColumn = column) => {
      const state = runtime.current
      if (!state) return
      if (!state.ready) {
        state.pending = { point, end, column, endColumn }
        return
      }
      if (point.side === "before") {
        const block = containingBlock(state.blocks, "before", point.line)
        if (block && !latest.current.compare) {
          state.pending = { point, end, column, endColumn }
          latest.current.onCompare(true)
          return
        }
        if (!block)
          point = {
            ...point,
            side: "after",
            line: currentLine(state.blocks, point.line),
          }
      }
      state.zones.reveal(point, end, column, endColumn)
    },
    []
  )
  useImperativeHandle(
    props.handle,
    () => ({
      find: () => setSearch(true),
      capture: () =>
        runtime.current?.ready ? runtime.current.zones.capture() : undefined,
      reveal,
    }),
    [reveal]
  )
  useEffect(() => {
    void ensureCodeLanguage(language).catch(() => {})
  }, [language])

  useLayoutEffect(() => {
    if (!host.current || !engineHost.current) return
    const initial = latest.current
    const before = monaco.editor.createModel(
      initial.before,
      initial.language,
      monaco.Uri.parse(`${initial.modelPath}/before`)
    )
    const after = monaco.editor.createModel(
      initial.after,
      initial.language,
      monaco.Uri.parse(`${initial.modelPath}/after`)
    )
    const main = monaco.editor.create(host.current, {
      model: after,
      theme,
      readOnly: true,
      ...codeEditorOptions(),
      fontSize: 12,
      lineHeight: 20,
      fontLigatures: false,
      wordWrap: "on",
      wrappingIndent: "same",
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 12,
      overviewRulerLanes: 0,
      renderLineHighlight: "none",
      padding: { top: initial.inset, bottom: initial.bottom },
      scrollbar: { verticalScrollbarSize: 8, horizontal: "hidden" },
      "semanticHighlighting.enabled": true,
      ariaLabel: "Current file",
    })
    const diff = monaco.editor.createDiffEditor(engineHost.current, {
      ...codeEditorOptions(),
      readOnly: true,
      ignoreTrimWhitespace: initial.trimWhitespace,
      renderSideBySide: true,
      diffAlgorithm: "advanced",
      maxComputationTime: 0,
      minimap: { enabled: false },
    })
    diff.setModel({ original: before, modified: after })
    const zones = new BlockDiffZones(main, { before, after }, theme, {
      compare: () => latest.current.onCompare(true),
      changed: () => persist(),
      cursor: (line, column) => latest.current.onCursor({ line, column }),
      searchSelection: explorerSearch
        ? (text) => searchExplorer.current?.(text)
        : undefined,
      find: () => setSearch(true),
      selection: (selection) => latest.current.onCommentSelection?.(selection),
    })
    const state: Runtime = {
      main,
      diff,
      zones,
      before,
      after,
      blocks: [],
      ready: false,
    }
    runtime.current = state
    let disposed = false
    let restore = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const persist = () => {
      if (!state.ready) return
      clearTimeout(timer)
      timer = setTimeout(() => latest.current.onCapture(zones.capture()), 100)
    }
    const compute = () => {
      if (disposed || !diff.getLineChanges()) return
      try {
        const point = restore ? latest.current.point : zones.capture()
        state.blocks = codeBlocks(diff.getLineChanges()!, {
          before: before.getValue(),
          after: after.getValue(),
        })
        zones.update(state.blocks, latest.current.compare)
        state.ready = true
        latest.current.onCounts(
          state.blocks.reduce(
            (total, block) => ({
              added:
                total.added +
                (block.after ? block.after.end - block.after.start + 1 : 0),
              removed:
                total.removed +
                (block.before ? block.before.end - block.before.start + 1 : 0),
            }),
            { added: 0, removed: 0 }
          )
        )
        setRevision((value) => value + 1)
        const target = latest.current.target
        if (state.pending) {
          const pending = state.pending
          state.pending = undefined
          reveal(pending.point, pending.end, pending.column, pending.endColumn)
        } else if (target && (restore || target.column !== undefined)) {
          zones.highlight(target)
          reveal(
            { side: target.side, line: target.start, fraction: 0 },
            target.end,
            target.column,
            target.endColumn
          )
        } else if (point) reveal(point)
        restore = false
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    const beforeFeatures = bindReadOnlyFeatures(monaco, before)
    const afterFeatures = bindReadOnlyFeatures(monaco, after)
    const gutter = bindChangeDecorations(main, () => latest.current.before)
    const originalChanges = before.onDidChangeContent(gutter.refresh)
    const listeners = [
      diff.onDidUpdateDiff(compute),
      main.onDidScrollChange(persist),
      main.onDidChangeCursorPosition((event) => {
        latest.current.onCursor({
          line: event.position.lineNumber,
          column: event.position.column,
        })
        persist()
      }),
      main.addAction({
        id: "reviewbox.block.find",
        label: "Find in file",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF],
        run: () => setSearch(true),
      }),
    ]
    beforeInspection.bind(before, monaco)
    afterInspection.bind(after, monaco)
    beforeServices.onMount(diff.getOriginalEditor(), monaco)
    afterServices.onMount(main, monaco)
    return () => {
      disposed = true
      if (state.ready) latest.current.onCapture(zones.capture())
      clearTimeout(timer)
      listeners.forEach((item) => item.dispose())
      beforeFeatures.dispose()
      afterFeatures.dispose()
      gutter.dispose()
      originalChanges.dispose()
      zones.dispose()
      main.setModel(null)
      diff.setModel(null)
      main.dispose()
      diff.dispose()
      before.dispose()
      after.dispose()
      runtime.current = null
    }
    // Models and subscriptions belong to the file identity. Live content, theme,
    // callbacks and comparison state update below without recreating the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.modelPath])

  useLayoutEffect(() => {
    const state = runtime.current
    if (!state) return
    if (language) {
      if (state.before.getLanguageId() !== language)
        monaco.editor.setModelLanguage(state.before, language)
      if (state.after.getLanguageId() !== language)
        monaco.editor.setModelLanguage(state.after, language)
    }
    if (state.before.getValue() !== props.before)
      state.before.setValue(props.before)
    if (state.after.getValue() !== props.after)
      state.after.setValue(props.after)
    state.diff.updateOptions({ ignoreTrimWhitespace: props.trimWhitespace })
  }, [props.before, props.after, props.trimWhitespace, language])
  useLayoutEffect(() => {
    const state = runtime.current
    if (!state?.ready) return
    const point = state.zones.capture()
    state.zones.update(state.blocks, props.compare)
    if (state.pending) {
      const pending = state.pending
      state.pending = undefined
      reveal(pending.point, pending.end, pending.column, pending.endColumn)
    } else if (point.side === "before" && !props.compare) {
      const block = containingBlock(state.blocks, "before", point.line)
      reveal({
        side: "after",
        line:
          block?.after?.start ??
          Math.max(1, block?.anchor ?? currentLine(state.blocks, point.line)),
        fraction: 0,
      })
    } else reveal(point)
  }, [props.compare, reveal])
  useEffect(() => {
    const state = runtime.current
    if (!state || !props.target) return
    state.zones.highlight(props.target)
    reveal(
      { side: props.target.side, line: props.target.start, fraction: 0 },
      props.target.end,
      props.target.column,
      props.target.endColumn
    )
  }, [props.target, reveal])
  useEffect(() => {
    runtime.current?.zones.setTheme(theme)
    monaco.editor.setTheme(theme)
  }, [theme])
  useEffect(() => {
    runtime.current?.main.updateOptions({
      padding: { top: props.inset, bottom: props.bottom },
    })
  }, [props.inset, props.bottom])
  useEffect(() => {
    const state = runtime.current
    if (!state || !query) {
      setMatches([])
      setIndex(0)
      return
    }
    const found: Match[] = state.after
      .findMatches(query, false, false, false, null, false)
      .map((match) => ({ side: "after", range: match.range }))
    if (props.compare)
      for (const match of state.before.findMatches(
        query,
        false,
        false,
        false,
        null,
        false
      )) {
        if (
          containingBlock(state.blocks, "before", match.range.startLineNumber)
        )
          found.push({ side: "before", range: match.range })
      }
    setMatches(found)
    setIndex(0)
    if (found[0])
      reveal(
        {
          side: found[0].side,
          line: found[0].range.startLineNumber,
          fraction: 0,
        },
        found[0].range.endLineNumber,
        found[0].range.startColumn,
        found[0].range.endColumn
      )
  }, [query, props.compare, revision, reveal])
  const next = (direction: number) => {
    if (!matches.length) return
    const chosen = (index + direction + matches.length) % matches.length
    setIndex(chosen)
    const match = matches[chosen]
    reveal(
      { side: match.side, line: match.range.startLineNumber, fraction: 0 },
      match.range.endLineNumber,
      match.range.startColumn,
      match.range.endColumn
    )
  }
  return (
    <div
      className={`block-diff ${surface.surface}`}
      data-theme={resolvedTheme === "light" ? "light" : "dark"}
      data-comparing={props.compare}
      style={{ paddingTop: props.overlayTop }}
      onKeyDownCapture={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault()
          event.stopPropagation()
          setSearch(true)
        }
      }}
    >
      <div ref={host} className="block-diff-main" />
      <div
        ref={engineHost}
        className="block-diff-engine"
        aria-hidden="true"
        inert
      />
      {search && (
        <div
          className="block-search-position"
          style={{ top: props.overlayTop }}
        >
          <BlockDiffSearch
            query={query}
            onQuery={setQuery}
            count={matches.length}
            index={index}
            next={next}
            close={() => {
              setSearch(false)
              runtime.current?.main.focus()
            }}
          />
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="absolute inset-x-4 bottom-16 rounded-xl bg-card p-4 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {beforeInspection.exploration}
      {afterInspection.exploration}
      {beforeServices.exploration}
      {afterServices.exploration}
    </div>
  )
}
