import { create } from "zustand"

type Space = "understand" | "review" | "resume"
type Inspector = "explanation" | "notes" | "ask"
interface WorkspaceState {
  space: Space
  inspector: Inspector
  noteKind: "note" | "question"
  setNoteKind: (noteKind: "note" | "question") => void
  split: boolean
  coverage: boolean
  settings: boolean
  palette: boolean
  setSpace: (space: Space) => void
  setInspector: (inspector: Inspector) => void
  setSplit: (split: boolean) => void
  setCoverage: (coverage: boolean) => void
  setSettings: (settings: boolean) => void
  setPalette: (palette: boolean) => void
}
export const useReviewWorkspaceStore = create<WorkspaceState>((set) => ({
  space: "review",
  inspector: "explanation",
  noteKind: "note",
  setNoteKind: (noteKind) => set({ noteKind }),
  split: false,
  coverage: false,
  settings: false,
  palette: false,
  setSpace: (space) => set({ space }),
  setInspector: (inspector) => set({ inspector }),
  setSplit: (split) => set({ split }),
  setCoverage: (coverage) => set({ coverage }),
  setSettings: (settings) => set({ settings }),
  setPalette: (palette) => set({ palette }),
}))
