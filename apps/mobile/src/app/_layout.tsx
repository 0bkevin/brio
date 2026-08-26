import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular';
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium';
import { DMSans_700Bold } from '@expo-google-fonts/dm-sans/700Bold';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Linking, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { T3Palette, T3Typography } from '@/constants/t3-theme';
import { IncomingShareProvider } from '@/features/threads/incoming-share-context';
import { CloudAuthProvider } from '@/lib/cloud-auth';
import { parseBrioDeepLink } from '@/lib/profiles-model';
import { useComposerStore } from '@/state/composer-store';
import { useConnectionStore } from '@/state/connection-store';
import { useDeepLinkStore } from '@/state/deep-link-store';
import { useRelaySessionStore } from '@/state/relay-session-store';
import { useRunStore } from '@/state/run-store';
import { useProfileStore } from '@/state/profile-store';
import { useUIStore } from '@/state/ui-store';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2_000 },
    mutations: { retry: 0 },
  },
});

export default function RootLayout() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const dark = colorScheme !== 'light';
  const colors = dark ? T3Palette.dark : T3Palette.light;
  const [fontsLoaded] = useFonts({ DMSans_400Regular, DMSans_500Medium, DMSans_700Bold });
  const hydrate = useConnectionStore((state) => state.hydrate);
  const connectionHydrated = useConnectionStore((state) => state.hydrated);
  const hydrateRelaySession = useRelaySessionStore((state) => state.hydrate);
  const relayHydrated = useRelaySessionStore((state) => state.hydrated);
  const hydrateRuns = useRunStore((state) => state.hydrate);
  const runsHydrated = useRunStore((state) => state.hydrated);
  const hydrateProfiles = useProfileStore((state) => state.hydrate);
  const profilesHydrated = useProfileStore((state) => state.hydrated);
  const hydrateComposer = useComposerStore((state) => state.hydrate);
  const composerHydrated = useComposerStore((state) => state.hydrated);
  const flushComposer = useComposerStore((state) => state.flush);
  const hydrateUI = useUIStore((state) => state.hydrate);
  const pushDeepLink = useDeepLinkStore((state) => state.push);

  useEffect(() => {
    void hydrate();
    void hydrateRelaySession();
    void hydrateRuns();
    void hydrateProfiles();
    void hydrateComposer();
    void hydrateUI();
  }, [hydrate, hydrateComposer, hydrateProfiles, hydrateRelaySession, hydrateRuns, hydrateUI]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void flushComposer();
    });
    return () => subscription.remove();
  }, [flushComposer]);

  useEffect(() => {
    const ingest = (url: string | null) => {
      if (!url) return;
      const link = parseBrioDeepLink(url);
      if (!link) return;
      pushDeepLink(link);
      router.replace('/');
    };
    void Linking.getInitialURL().then(ingest).catch(() => undefined);
    const subscription = Linking.addEventListener('url', (event) => ingest(event.url));
    return () => subscription.remove();
  }, [pushDeepLink, router]);

  useEffect(() => {
    if (
      fontsLoaded &&
      composerHydrated &&
      connectionHydrated &&
      profilesHydrated &&
      relayHydrated &&
      runsHydrated
    ) {
      void SplashScreen.hideAsync();
    }
  }, [composerHydrated, connectionHydrated, fontsLoaded, profilesHydrated, relayHydrated, runsHydrated]);

  if (!fontsLoaded) return null;

  const navigationTheme = {
    ...(dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(dark ? DarkTheme.colors : DefaultTheme.colors),
      background: colors.screen,
      border: colors.border,
      card: colors.sheet,
      primary: colors.userBubble,
      text: colors.foreground,
    },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <CloudAuthProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={navigationTheme}>
            <StatusBar style={dark ? 'light' : 'dark'} />
            <IncomingShareProvider>
              <Stack
                screenOptions={{
                  contentStyle: { backgroundColor: colors.screen },
                  headerBackButtonDisplayMode: 'minimal',
                  headerShadowVisible: false,
                  headerStyle: { backgroundColor: colors.sheet },
                  headerTintColor: colors.foreground,
                  headerTitleStyle: { fontFamily: T3Typography.bold, fontSize: 18 },
                }}
              >
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen
                  name="connect"
                  options={{ presentation: 'modal', title: 'Add Environment' }}
                />
                <Stack.Screen
                  name="relay"
                  options={{ presentation: 'modal', title: 'Brio Relay' }}
                />
                <Stack.Screen
                  name="environments"
                  options={{ presentation: 'modal', title: 'Environments' }}
                />
                <Stack.Screen name="thread/[id]" options={{ title: 'Hermes' }} />
                <Stack.Screen name="files" options={{ title: 'Files' }} />
                <Stack.Screen name="automation" options={{ title: 'Automation' }} />
                <Stack.Screen name="command-center" options={{ title: 'Command Center' }} />
                <Stack.Screen name="profiles" options={{ title: 'Hermes Profiles' }} />
                <Stack.Screen
                  name="settings"
                  options={{ presentation: 'modal', title: 'Settings' }}
                />
                <Stack.Screen name="explore" options={{ title: 'Diagnostics' }} />
              </Stack>
            </IncomingShareProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </CloudAuthProvider>
    </GestureHandlerRootView>
  );
}
