import { ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

import { useConnectionStore } from '@/state/connection-store';
import { useRelaySessionStore } from '@/state/relay-session-store';

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? '';
const jwtTemplate = process.env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE?.trim() ?? '';
const relayURL = process.env.EXPO_PUBLIC_BRIO_RELAY_URL?.trim() ?? '';

export function cloudAuthConfigured() {
  return Boolean(publishableKey && jwtTemplate && relayURL);
}

export function configuredRelayURL() {
  return relayURL.replace(/\/+$/, '');
}

export function developmentAuthEnabled() {
  return process.env.EXPO_PUBLIC_BRIO_DEV_AUTH === 'true';
}

export function relayTokenOptions() {
  return { template: jwtTemplate };
}

function CloudSessionGuard({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const relaySession = useRelaySessionStore((state) => state.session);
  const clearRelaySession = useRelaySessionStore((state) => state.clearSession);
  const clearConnection = useConnectionStore((state) => state.clearConnection);

  useEffect(() => {
    if (!isLoaded || !relaySession?.identitySubject) return;
    if (isSignedIn && userId === relaySession.identitySubject) return;
    void clearConnection();
    void clearRelaySession();
  }, [clearConnection, clearRelaySession, isLoaded, isSignedIn, relaySession, userId]);

  return children;
}

export function CloudAuthProvider({ children }: { children: ReactNode }) {
  if (!cloudAuthConfigured()) return children;
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <CloudSessionGuard>{children}</CloudSessionGuard>
    </ClerkProvider>
  );
}
