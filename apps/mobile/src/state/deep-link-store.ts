import { create } from 'zustand';

import type { BrioDeepLink } from '@/lib/profiles-model';

// Pending brio://chat deep-link requests. The root layout pushes parsed
// links here (cold start via getInitialURL and warm links via
// Linking events); the chat workspace consumes them once stores are
// hydrated so the target environment, profile, and session resolve in the
// right order without cross-profile leakage.
type DeepLinkState = {
  pending: BrioDeepLink | null;
  push: (link: BrioDeepLink) => void;
  consume: () => BrioDeepLink | null;
};

export const useDeepLinkStore = create<DeepLinkState>((set, get) => ({
  pending: null,
  push: (link) => set({ pending: link }),
  consume: () => {
    const link = get().pending;
    if (link) set({ pending: null });
    return link;
  },
}));
