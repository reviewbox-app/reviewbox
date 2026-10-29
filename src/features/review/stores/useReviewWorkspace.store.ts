import { create } from "zustand"
import type { ReadingLevel } from "@/lib/desktop/contracts.generated"

export type Space = "understand" | "review" | "resume" | "terminal"
type ReaderView = "document" | "code"
interface WorkspaceState {
  space: Space
  view: ReaderView
  readerLevel: ReadingLevel
  stepsOpen: boolean
  setStepsOpen: (stepsOpen: boolean) => void
  explanationRequested: boolean
  compareCode: boolean
  setCompareCode: (value: boolean) => void
  split: boolean
  settings: boolean
  palette: boolean
  setSpace: (space: Space) => void
  setView: (view: ReaderView) => void
  setReaderLevel: (readerLevel: ReadingLevel) => void
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
  explanationRequested: true,
  compareCode: true,
  setCompareCode: (compareCode) => set({ compareCode }),
  split: false,
  settings: false,
  palette: false,
  setSpace: (space) => set({ space }),
  setView: (view) => set({ view }),
  setReaderLevel: (readerLevel) => set({ readerLevel }),
  setExplanationRequested: (explanationRequested) =>
    set({ explanationRequested }),
  setSplit: (split) => set({ split }),
  setSettings: (settings) => set({ settings }),
  setPalette: (palette) => set({ palette }),
}))
