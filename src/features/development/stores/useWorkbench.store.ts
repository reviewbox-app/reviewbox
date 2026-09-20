import { create } from "zustand"

interface WorkbenchState {
  count: number
  increment: () => void
  reset: () => void
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  reset: () => set({ count: 0 }),
}))
