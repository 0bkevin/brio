import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { IncomingShareProvider } from '@/features/threads/incoming-share-context';
import { useComposerStore } from '@/state/composer-store';
import { useConnectionStore } from '@/state/connection-store';
import { useRelaySessionStore } from '@/state/relay-session-store';
import { useUIStore } from '@/state/ui-store';

const queryClient = new QueryClient();

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const hydrateComposer = useComposerStore((state) => state.hydrate);
  const flushComposer = useComposerStore((state) => state.flush);
  const hydrate = useConnectionStore((state) => state.hydrate);
  const hydrateRelaySession = useRelaySessionStore((state) => state.hydrate);
  const hydrateUI = useUIStore((state) => state.hydrate);

  useEffect(() => {
    void hydrateComposer();
    void hydrate();
    void hydrateRelaySession();
    void hydrateUI();
  }, [hydrate, hydrateComposer, hydrateRelaySession, hydrateUI]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'inactive' || state === 'background') void flushComposer();
    });
    return () => subscription.remove();
  }, [flushComposer]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <IncomingShareProvider>
          <AnimatedSplashOverlay />
          <AppTabs />
        </IncomingShareProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
