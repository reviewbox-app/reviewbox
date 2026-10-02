import { create } from "zustand"
import type { ReadingLevel } from "@/lib/desktop/contracts.generated"

type Space = "understand" | "review" | "resume"
type ReaderView = "document" | "code"
interface WorkspaceState {
  space: Space
  view: ReaderView
  readerLevel: ReadingLevel
  stepsOpen: boolean
  setStepsOpen: (stepsOpen: boolean) => void
  filesOpen: boolean
  explanationRequested: boolean
  compareCode: boolean
  setCompareCode: (value: boolean) => void
  split: boolean
  settings: boolean
  palette: boolean
  setSpace: (space: Space) => void
  setView: (view: ReaderView) => void
  setReaderLevel: (readerLevel: ReadingLevel) => void
  setFilesOpen: (filesOpen: boolean) => void
  setExplanationRequested: (explanationRequested: boolean) => void
  setSplit: (split: boolean) => void
  setSettings: (settings: boolean) => void
  setPalette: (palette: boolean) => void
}
export const useReviewWorkspaceStore = create<WorkspaceState>((set) => ({
  space: "review",
  view: "document",
  readerLevel: "explained",
  stepsOpen: true,
  setStepsOpen: (stepsOpen) => set({ stepsOpen }),
  filesOpen: false,
  explanationRequested: true,
  compareCode: true,
  setCompareCode: (compareCode) => set({ compareCode }),
  split: false,
  settings: false,
  palette: false,
  setSpace: (space) => set({ space }),
  setView: (view) =>
    set((state) => ({
      view,
      // Entering Code reveals its navigation; ordinary updates in Code still
      // respect a sidebar the reader has explicitly closed.
      ...(view === "code" && state.view !== "code" ? { filesOpen: true } : {}),
    })),
  setReaderLevel: (readerLevel) => set({ readerLevel }),
  setFilesOpen: (filesOpen) => set({ filesOpen }),
  setExplanationRequested: (explanationRequested) =>
    set({ explanationRequested }),
  setSplit: (split) => set({ split }),
  setSettings: (settings) => set({ settings }),
  setPalette: (palette) => set({ palette }),
}))
