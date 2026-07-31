import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular';
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium';
import { DMSans_700Bold } from '@expo-google-fonts/dm-sans/700Bold';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { T3Palette, T3Typography } from '@/constants/t3-theme';
import { useConnectionStore } from '@/state/connection-store';
import { useRelaySessionStore } from '@/state/relay-session-store';
import { useUIStore } from '@/state/ui-store';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2_000 },
    mutations: { retry: 0 },
  },
});

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const dark = colorScheme !== 'light';
  const colors = dark ? T3Palette.dark : T3Palette.light;
  const [fontsLoaded] = useFonts({ DMSans_400Regular, DMSans_500Medium, DMSans_700Bold });
  const hydrate = useConnectionStore((state) => state.hydrate);
  const connectionHydrated = useConnectionStore((state) => state.hydrated);
  const hydrateRelaySession = useRelaySessionStore((state) => state.hydrate);
  const relayHydrated = useRelaySessionStore((state) => state.hydrated);
  const hydrateUI = useUIStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
    void hydrateRelaySession();
    void hydrateUI();
  }, [hydrate, hydrateRelaySession, hydrateUI]);

  useEffect(() => {
    if (fontsLoaded && connectionHydrated && relayHydrated) {
      void SplashScreen.hideAsync();
    }
  }, [connectionHydrated, fontsLoaded, relayHydrated]);

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
      <QueryClientProvider client={queryClient}>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: colors.screen },
              headerBackButtonDisplayMode: 'minimal',
              headerShadowVisible: false,
              headerStyle: { backgroundColor: colors.sheet },
              headerTintColor: colors.foreground,
              headerTitleStyle: { fontFamily: T3Typography.bold, fontSize: 18 },
            }}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="thread/[id]" options={{ title: 'Hermes' }} />
            <Stack.Screen name="files" options={{ title: 'Files' }} />
            <Stack.Screen name="settings" options={{ presentation: 'modal', title: 'Settings' }} />
            <Stack.Screen name="explore" options={{ title: 'Diagnostics' }} />
          </Stack>
        </ThemeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
