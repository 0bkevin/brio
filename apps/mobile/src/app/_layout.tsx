import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { useConnectionStore } from '@/state/connection-store';
import { useRelaySessionStore } from '@/state/relay-session-store';
import { useUIStore } from '@/state/ui-store';

const queryClient = new QueryClient();

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const hydrate = useConnectionStore((state) => state.hydrate);
  const hydrateRelaySession = useRelaySessionStore((state) => state.hydrate);
  const hydrateUI = useUIStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
    void hydrateRelaySession();
    void hydrateUI();
  }, [hydrate, hydrateRelaySession, hydrateUI]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <AppTabs />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
