import { create } from 'zustand';

import type { BrioDeepLink } from '@/lib/profiles-model';

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
