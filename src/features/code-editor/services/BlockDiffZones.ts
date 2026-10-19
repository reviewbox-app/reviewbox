import * as monaco from "monaco-editor/editor/editor.api"
import type { editor, IDisposable } from "monaco-editor"
import { codeEditorOptions } from "@/lib/code/codeAppearance"
import type {
  BlockDiffModels,
  CodeBlock,
  CodePoint,
  CodeSide,
} from "../contracts/blockDiff.types"
import { hideRanges, lineRange } from "./monacoHiddenRanges"
import { bindSelectionSearch } from "./selectionSearch"
import { observeSourceSelection } from "./sourceSelection"
import type { SourceSelection } from "../contracts/sourceSelection.types"

type Cell = {
  side: CodeSide
  editor: editor.IStandaloneCodeEditor
  dispose: () => void
}
type Zone = {
  block: CodeBlock
  id: string
  node: HTMLDivElement
  height: number
  top: number
  cells: Cell[]
  definition: editor.IViewZone
}

/** Owns view zones and virtualized, non-scrolling block editors. */
export class BlockDiffZones {
  private zones: Zone[] = []
  private layer: HTMLDivElement
  private marks: editor.IEditorDecorationsCollection
  private listeners: IDisposable[]
  private frame = 0
  private dead = false
  private compare = false
  private theme: string
  private blocks: CodeBlock[] = []
  private activeSide: CodeSide = "after"
  private activeCell?: Cell
  private selected?: { side: CodeSide; start: number; end: number }
  private selectionMarks: editor.IEditorDecorationsCollection[] = []

  constructor(
    readonly main: editor.IStandaloneCodeEditor,
    readonly models: BlockDiffModels,
    theme: string,
    private callbacks: {
      compare: () => void
      changed: () => void
      cursor: (line: number, column: number) => void
      find: (text?: string) => void
      selection?: (selection: SourceSelection | null) => void
    }
  ) {
    this.theme = theme
    this.layer = document.createElement("div")
    this.layer.className = "block-zone-layer"
    main.getDomNode()!.append(this.layer)
    this.layer.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault()
        event.stopPropagation()
        main.setScrollTop(main.getScrollTop() + event.deltaY)
      },
      { passive: false }
    )
    this.marks = main.createDecorationsCollection()
    this.listeners = [
      bindSelectionSearch(monaco, main, (text) => this.callbacks.find(text)),
      observeSourceSelection(main, "after", (selection) =>
        this.callbacks.selection?.(selection)
      ),
      main.onDidScrollChange(() => this.schedule()),
      main.onDidLayoutChange(() => this.schedule()),
      main.onDidFocusEditorText(() => {
        this.activeSide = "after"
        this.activeCell = undefined
      }),
    ]
  }

  update(blocks: CodeBlock[], compare: boolean) {
    this.clear()
    this.blocks = blocks
    this.compare = compare
    const hidden = compare
      ? blocks.flatMap((block) =>
          block.before && block.after
            ? [lineRange(block.after.start, block.after.end)]
            : []
        )
      : []
    const allReplaced = hidden.some(
      (range) =>
        range.startLineNumber === 1 &&
        range.endLineNumber === this.models.after.getLineCount()
    )
    // Monaco restores every line if all are hidden. Keep one invisible spacer
    // line instead; the source model itself must never acquire a synthetic line.
    if (allReplaced)
      hidden[0] = { ...hidden[0], endLineNumber: hidden[0].endLineNumber - 1 }
    hideRanges(
      this.main,
      hidden.filter((range) => range.endLineNumber >= range.startLineNumber)
    )
    this.main.getDomNode()!.dataset.allReplaced = String(allReplaced)
    this.marks.set(
      blocks.flatMap((block) => {
        if (!block.after || (compare && block.before)) return []
        const { start, end } = block.after
        const tone = block.before ? "modified" : "added"
        const ranges =
          start === end
            ? [{ start, end, edge: "block-first block-last" }]
            : [
                { start, end: start, edge: "block-first" },
                ...(end > start + 1
                  ? [{ start: start + 1, end: end - 1, edge: "" }]
                  : []),
                { start: end, end, edge: "block-last" },
              ]
        return [
          ...ranges.map((range) => ({
            range: lineRange(range.start, range.end),
            options: {
              isWholeLine: true,
              className: `block-${tone} ${range.edge}`,
              marginClassName: `block-${tone}-margin ${range.edge}`,
            },
          })),
          ...(block.words?.after ?? []).map((range) => ({
            range,
            options: {
              inlineClassName: block.before
                ? "block-word-modified"
                : "block-word-after",
            },
          })),
        ]
      })
    )
    this.main.changeViewZones((accessor) => {
      for (const block of blocks) {
        if (!block.before) continue
        if (!compare && block.after) continue
        const node = document.createElement("div")
        node.className = compare ? "block-comparison" : "block-deletion"
        node.dataset.blockId = block.id
        this.layer.append(node)
        const height = compare
          ? 28 +
            20 *
              Math.max(
                block.before.end - block.before.start + 1,
                block.after ? block.after.end - block.after.start + 1 : 1
              )
          : 30
        const zone: Zone = {
          block,
          id: "",
          node,
          height,
          top: -1e6,
          cells: [],
          definition: {
            afterLineNumber: block.anchor,
            heightInPx: height,
            showInHiddenAreas: true,
            suppressMouseDown: false,
            domNode: document.createElement("div"),
            onDomNodeTop: (top) => {
              zone.top = top
              node.style.top = `${top}px`
              this.schedule()
            },
          },
        }
        if (!compare) {
          const button = document.createElement("button")
          button.type = "button"
          const count = block.before.end - block.before.start + 1
          button.textContent = `${count} ${count === 1 ? "line" : "lines"} removed`
          button.onclick = () => {
            this.callbacks.compare()
            requestAnimationFrame(() =>
              this.reveal({
                side: "before",
                line: block.before!.start,
                fraction: 0,
              })
            )
          }
          node.append(button)
        }
        zone.id = accessor.addZone(zone.definition)
        this.zones.push(zone)
      }
    })
    this.schedule()
    this.highlight(this.selected)
  }

  private schedule() {
    if (this.dead || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.layout()
    })
  }

  private layout() {
    const layout = this.main.getLayoutInfo()
    for (const zone of this.zones) {
      // The overlay shares the zone's vertical geometry but includes the gutter;
      // placing cells inside Monaco's clipped view-zone would crop their numbers.
      zone.node.style.width = `${Math.max(1, layout.width - layout.verticalScrollbarWidth)}px`
      zone.node.style.height = `${zone.height}px`
      zone.node.style.display =
        zone.top > -zone.height && zone.top < layout.height
          ? this.compare
            ? "grid"
            : "flex"
          : "none"
      if (!this.compare) continue
      const visible =
        zone.top > -zone.height - 500 && zone.top < layout.height + 500
      if (!visible) {
        this.unmount(zone)
        continue
      }
      if (!zone.cells.length) this.mount(zone)
      const width = Math.max(
        1,
        (layout.width - layout.verticalScrollbarWidth) / 2
      )
      let height = 20
      for (const cell of zone.cells) {
        cell.editor.layout({ width, height: Math.max(20, zone.height - 28) })
        height = Math.max(height, cell.editor.getContentHeight())
      }
      if (Math.abs(zone.height - (height + 28)) > 1) {
        zone.height = height + 28
        zone.definition.heightInPx = zone.height
        this.main.changeViewZones((accessor) => accessor.layoutZone(zone.id))
      }
      const windowHeight = Math.min(height, layout.height + 400)
      const windowTop = Math.max(
        0,
        Math.min(height - windowHeight, -zone.top - 28 - 200)
      )
      for (const cell of zone.cells) {
        const host = cell.editor.getContainerDomNode()
        host.style.position = "absolute"
        host.style.top = `${28 + windowTop}px`
        cell.editor.layout({ width, height: windowHeight })
        cell.editor.setScrollTop(windowTop)
      }
    }
  }

  private mount(zone: Zone) {
    zone.node.replaceChildren()
    for (const side of ["after", "before"] as const) {
      const column = document.createElement("div")
      column.className = `block-column block-${side}`
      column.dataset.side = side
      const label = document.createElement("div")
      label.className = "block-label"
      label.textContent = side === "after" ? "Current" : "Previous"
      column.append(label)
      zone.node.append(column)
      const range = zone.block[side]
      if (!range) {
        column.classList.add("block-empty-side")
        const empty = document.createElement("div")
        empty.className = "block-empty"
        empty.textContent = "Removed from current file"
        column.append(empty)
        continue
      }
      const host = document.createElement("div")
      host.className = "block-cell"
      host.setAttribute(
        "aria-label",
        `${label.textContent} lines ${range.start}–${range.end}`
      )
      column.append(host)
      const instance = monaco.editor.create(host, {
        model: this.models[side],
        theme: this.theme,
        readOnly: true,
        ...codeEditorOptions(),
        fontSize: 12,
        lineHeight: 20,
        fontLigatures: false,
        minimap: { enabled: false },
        wordWrap: "on",
        wrappingIndent: "same",
        scrollBeyondLastLine: false,
        lineNumbers: "on",
        lineNumbersMinChars: this.main.getOption(
          monaco.editor.EditorOption.lineNumbersMinChars
        ),
        glyphMargin: false,
        lineDecorationsWidth: this.main.getOption(
          monaco.editor.EditorOption.lineDecorationsWidth
        ),
        folding: false,
        stickyScroll: { enabled: false },
        renderLineHighlight: "none",
        overviewRulerLanes: 0,
        padding: { top: 0, bottom: 0 },
        fixedOverflowWidgets: true,
        scrollbar: {
          vertical: "hidden",
          horizontal: "hidden",
          handleMouseWheel: false,
        },
        "semanticHighlighting.enabled": true,
        ariaLabel: host.getAttribute("aria-label")!,
      })
      const hidden = []
      if (range.start > 1) hidden.push(lineRange(1, range.start - 1))
      if (range.end < this.models[side].getLineCount())
        hidden.push(lineRange(range.end + 1, this.models[side].getLineCount()))
      hideRanges(instance, hidden)
      instance.createDecorationsCollection(
        (zone.block.words?.[side] ?? []).map((word) => ({
          range: word,
          options: { inlineClassName: `block-word-${side}` },
        }))
      )
      instance.setPosition({ lineNumber: range.start, column: 1 })
      instance.setScrollTop(0)
      const wheel = (event: WheelEvent) => {
        event.preventDefault()
        event.stopPropagation()
        this.main.setScrollTop(this.main.getScrollTop() + event.deltaY)
      }
      host.addEventListener("wheel", wheel, { passive: false })
      const subscriptions = [
        observeSourceSelection(instance, side, (selection) =>
          this.callbacks.selection?.(selection)
        ),
        instance.onDidContentSizeChange(() => this.schedule()),
        instance.onDidChangeCursorPosition((event) => {
          this.callbacks.cursor(
            event.position.lineNumber,
            event.position.column
          )
          this.callbacks.changed()
        }),
        bindSelectionSearch(monaco, instance, (text) =>
          this.callbacks.find(text)
        ),
        instance.onDidFocusEditorText(() => {
          this.activeSide = side
          this.activeCell = cell
        }),
        instance.addAction({
          id: "reviewbox.block.find",
          label: "Find in file",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF],
          run: () => this.callbacks.find(),
        }),
      ]
      const cell: Cell = {
        side,
        editor: instance,
        dispose: () => {
          host.removeEventListener("wheel", wheel)
          subscriptions.forEach((item) => item.dispose())
          instance.setModel(null)
          instance.dispose()
        },
      }
      zone.cells.push(cell)
    }
    this.highlight(this.selected)
  }

  private unmount(zone: Zone) {
    if (!zone.cells.length) return
    // Preserve a focused selection until focus moves elsewhere.
    if (zone.cells.some((cell) => cell.editor.hasTextFocus())) return
    zone.cells.forEach((cell) => cell.dispose())
    zone.cells = []
    zone.node.replaceChildren()
  }

  setTheme(theme: string) {
    this.theme = theme
  }

  capture(): CodePoint {
    const focused = this.activeCell
    if (focused && focused.editor.hasTextFocus()) {
      return {
        side: this.activeSide,
        line: focused.editor.getPosition()?.lineNumber ?? 1,
        fraction: 0,
      }
    }
    const zone = this.zones.find(
      (item) => item.top <= 16 && item.top + item.height > 16
    )
    if (zone && this.compare) {
      const side = zone.block.after ? "after" : "before"
      const range = zone.block[side]!
      const cell = zone.cells.find((item) => item.side === side)
      const offset = Math.max(0, -zone.top - 28 + 14)
      let line = range.start
      if (cell) {
        let high = range.end
        while (line < high) {
          const mid = Math.ceil((line + high) / 2)
          if (cell.editor.getTopForLineNumber(mid) <= offset) line = mid
          else high = mid - 1
        }
      }
      const top = cell?.editor.getTopForLineNumber(line) ?? 0
      const bottom = cell?.editor.getBottomForLineNumber(line) ?? 20
      return {
        side,
        line,
        fraction: Math.max(
          0,
          Math.min(1, (offset - top) / Math.max(1, bottom - top))
        ),
      }
    }
    const line = this.main.getVisibleRanges()[0]?.startLineNumber ?? 1
    const top = this.main.getTopForLineNumber(line)
    const height = Math.max(1, this.main.getBottomForLineNumber(line) - top)
    return {
      side: "after",
      line,
      fraction: Math.max(
        0,
        Math.min(1, (this.main.getScrollTop() - top) / height)
      ),
    }
  }

  reveal(point: CodePoint, end?: number, column = 1, endColumn = column) {
    const last = end ?? point.line
    const viewport =
      this.main.getLayoutInfo().height -
      this.main.getOption(monaco.editor.EditorOption.padding).bottom
    const zone = this.zones.find((item) => {
      const range = item.block[point.side]
      return range && point.line >= range.start && point.line <= range.end
    })
    if (zone && this.compare) {
      // Off-screen view zones report a sentinel top. Derive their document
      // position from the complete source model instead of that DOM value.
      const absolute =
        zone.block.anchor >= this.models.after.getLineCount()
          ? this.main.getBottomForLineNumber(this.models.after.getLineCount())
          : this.main.getTopForLineNumber(zone.block.anchor + 1) - zone.height
      this.main.setScrollTop(Math.max(0, absolute - 14))
      this.layout()
      // Monaco may not have reported the zone geometry yet. Materialize the
      // requested cell now so navigation cannot lose its exact selection.
      if (!zone.cells.length) this.mount(zone)
      const cell = zone.cells.find((cell) => cell.side === point.side)
      if (cell) {
        const top = cell.editor.getTopForLineNumber(point.line)
        const bottom = cell.editor.getBottomForLineNumber(last)
        const offset =
          end !== undefined
            ? bottom - top > viewport
              ? top + 14
              : (top + bottom) / 2 - viewport / 2
            : top + point.fraction * Math.max(1, bottom - top) - 14
        this.main.setScrollTop(Math.max(0, absolute + 28 + offset))
        if (endColumn > column) cell.editor.focus()
        cell.editor.setSelection({
          startLineNumber: point.line,
          startColumn: column,
          endLineNumber: last,
          endColumn,
        })
      }
      return
    }
    const top = this.main.getTopForLineNumber(point.line)
    const bottom = this.main.getBottomForLineNumber(last)
    const offset =
      end !== undefined
        ? bottom - top > viewport
          ? top - 14
          : (top + bottom) / 2 - viewport / 2
        : point.line === 1 && !point.fraction
          ? 0
          : top - 14 + point.fraction * (bottom - top)
    this.main.setScrollTop(Math.max(0, offset))
    if (endColumn > column) this.main.focus()
    this.main.setSelection({
      startLineNumber: point.line,
      startColumn: column,
      endLineNumber: last,
      endColumn,
    })
  }

  highlight(target?: { side: CodeSide; start: number; end: number }) {
    this.selected = target
    this.selectionMarks.forEach((mark) => mark.clear())
    this.selectionMarks = []
    if (!target) return
    const instances = [
      ...(target.side === "after" ? [this.main] : []),
      ...this.zones.flatMap((zone) =>
        zone.cells
          .filter((cell) => cell.side === target.side)
          .map((cell) => cell.editor)
      ),
    ]
    for (const instance of instances)
      this.selectionMarks.push(
        instance.createDecorationsCollection([
          {
            range: lineRange(target.start, target.end),
            options: {
              isWholeLine: true,
              className: "review-passage",
              marginClassName: "review-passage-margin",
            },
          },
        ])
      )
  }

  private clear() {
    this.selectionMarks.forEach((mark) => mark.clear())
    this.selectionMarks = []
    this.main.changeViewZones((accessor) =>
      this.zones.forEach((zone) => accessor.removeZone(zone.id))
    )
    for (const zone of this.zones) {
      zone.cells.forEach((cell) => cell.dispose())
      zone.node.remove()
    }
    this.zones = []
    this.activeCell = undefined
    this.marks.clear()
  }
  dispose() {
    this.dead = true
    cancelAnimationFrame(this.frame)
    this.listeners.forEach((item) => item.dispose())
    this.clear()
    hideRanges(this.main, [])
    this.layer.remove()
  }
}
