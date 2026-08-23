import { useIncomingShare, type UseIncomingShareResult } from 'expo-sharing';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { Platform } from 'react-native';

type IncomingShareContextValue = UseIncomingShareResult & {
  consumeSharedPayloads: () => void;
};

const IncomingShareContext = createContext<IncomingShareContextValue | null>(null);

export function IncomingShareProvider({ children }: { children: ReactNode }) {
  if (Platform.OS === 'web') {
    return (
      <IncomingShareContext.Provider value={emptyIncomingShare}>
        {children}
      </IncomingShareContext.Provider>
    );
  }
  return <NativeIncomingShareProvider>{children}</NativeIncomingShareProvider>;
}

function NativeIncomingShareProvider({ children }: { children: ReactNode }) {
  const incoming = useIncomingShare();
  const { clearSharedPayloads, refreshSharePayloads } = incoming;
  const consumeSharedPayloads = useCallback(() => {
    clearSharedPayloads();
    refreshSharePayloads();
  }, [clearSharedPayloads, refreshSharePayloads]);

  return (
    <IncomingShareContext.Provider value={{ ...incoming, consumeSharedPayloads }}>
      {children}
    </IncomingShareContext.Provider>
  );
}

const emptyIncomingShare: IncomingShareContextValue = {
  sharedPayloads: [],
  resolvedSharedPayloads: [],
  isResolving: false,
  error: null,
  clearSharedPayloads: () => undefined,
  refreshSharePayloads: () => undefined,
  consumeSharedPayloads: () => undefined,
};

export function useIncomingShareContext() {
  const value = useContext(IncomingShareContext);
  if (!value) throw new Error('IncomingShareProvider is missing');
  return value;
}
