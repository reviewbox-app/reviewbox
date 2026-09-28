import { create } from "zustand"
import type { ReadingLevel } from "@/lib/desktop/contracts.generated"

type Space = "understand" | "review" | "resume"
type ReaderView = "document" | "code"
interface WorkspaceState {
  space: Space
  view: ReaderView
  readerLevel: ReadingLevel
  codeMode: "real" | "pseudo"
  filesOpen: boolean
  explanationRequested: boolean
  split: boolean
  settings: boolean
  palette: boolean
  setSpace: (space: Space) => void
  setView: (view: ReaderView) => void
  setReaderLevel: (readerLevel: ReadingLevel) => void
  setCodeMode: (codeMode: "real" | "pseudo") => void
  setFilesOpen: (filesOpen: boolean) => void
  setExplanationRequested: (explanationRequested: boolean) => void
  setSplit: (split: boolean) => void
  setSettings: (settings: boolean) => void
  setPalette: (palette: boolean) => void
}
export const useReviewWorkspaceStore = create<WorkspaceState>((set) => ({
  space: "review",
  view: "document",
  readerLevel: "intermediate",
  codeMode: "real",
  filesOpen: false,
  explanationRequested: true,
  split: false,
  settings: false,
  palette: false,
  setSpace: (space) => set({ space }),
  setView: (view) => set({ view }),
  setReaderLevel: (readerLevel) => set({ readerLevel }),
  setCodeMode: (codeMode) => set({ codeMode }),
  setFilesOpen: (filesOpen) => set({ filesOpen }),
  setExplanationRequested: (explanationRequested) =>
    set({ explanationRequested }),
  setSplit: (split) => set({ split }),
  setSettings: (settings) => set({ settings }),
  setPalette: (palette) => set({ palette }),
}))
