import { DarkTheme, DefaultTheme, ThemeProvider, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Linking, useColorScheme } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { parseBrioDeepLink } from '@/lib/profiles-model';
import { useComposerStore } from '@/state/composer-store';
import { useConnectionStore } from '@/state/connection-store';
import { useDeepLinkStore } from '@/state/deep-link-store';
import { useProfileStore } from '@/state/profile-store';
import { useRelaySessionStore } from '@/state/relay-session-store';
import { useUIStore } from '@/state/ui-store';

const queryClient = new QueryClient();

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const hydrateComposer = useComposerStore((state) => state.hydrate);
  const hydrate = useConnectionStore((state) => state.hydrate);
  const hydrateProfiles = useProfileStore((state) => state.hydrate);
  const hydrateRelaySession = useRelaySessionStore((state) => state.hydrate);
  const hydrateUI = useUIStore((state) => state.hydrate);
  const pushDeepLink = useDeepLinkStore((state) => state.push);

  useEffect(() => {
    void hydrateComposer();
    void hydrate();
    void hydrateProfiles();
    void hydrateRelaySession();
    void hydrateUI();
  }, [hydrate, hydrateComposer, hydrateProfiles, hydrateRelaySession, hydrateUI]);

  // brio://chat?agent=&profile=&session= deep links: cold start resolves the
  // initial URL; warm links arrive through Linking events. Parsing failures
  // and foreign URLs are ignored by the parser itself.
  useEffect(() => {
    const ingest = (url: string | null) => {
      if (!url) return;
      const link = parseBrioDeepLink(url);
      if (link) {
        pushDeepLink(link);
        // Queue first so ChatWorkspace can resolve the exact environment,
        // profile, and optional session after hydration, then normalize both
        // cold and warm links through the app root.
        router.replace('/');
      }
    };
    void Linking.getInitialURL().then(ingest).catch(() => undefined);
    const subscription = Linking.addEventListener('url', (event) => ingest(event.url));
    return () => subscription.remove();
  }, [pushDeepLink, router]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <AppTabs />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
