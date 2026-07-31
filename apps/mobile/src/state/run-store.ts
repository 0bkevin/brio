import { create } from 'zustand';

type RunState = {
  activeRuns: Record<string, string>;
  setActiveRun: (sessionId: string, runId: string) => void;
  clearActiveRun: (sessionId: string) => void;
};

export const useRunStore = create<RunState>((set) => ({
  activeRuns: {},
  setActiveRun: (sessionId, runId) =>
    set((state) => ({ activeRuns: { ...state.activeRuns, [sessionId]: runId } })),
  clearActiveRun: (sessionId) =>
    set((state) => {
      const activeRuns = { ...state.activeRuns };
      delete activeRuns[sessionId];
      return { activeRuns };
    }),
}));
