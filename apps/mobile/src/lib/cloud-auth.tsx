import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import type { ReactNode } from "react";
import { useEffect } from "react";

import {
  resetRelayDPoPTokens,
  setRelayIdentityTokenProvider,
} from "@/lib/brio";
import { useConnectionStore } from "@/state/connection-store";
import { useRelaySessionStore } from "@/state/relay-session-store";

const publishableKey =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? "";
const jwtTemplate = process.env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE?.trim() ?? "";
const relayURL = process.env.EXPO_PUBLIC_BRIO_RELAY_URL?.trim() ?? "";

export function cloudAuthConfigured() {
  return Boolean(publishableKey && jwtTemplate && relayURL);
}

export function configuredRelayURL() {
  return relayURL.replace(/\/+$/, "");
}

export function developmentAuthEnabled() {
  return process.env.EXPO_PUBLIC_BRIO_DEV_AUTH === "true";
}

export function relayTokenOptions() {
  return { template: jwtTemplate };
}

function CloudAuthBridge({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const connection = useConnectionStore((state) => state.connection);
  const clearConnection = useConnectionStore((state) => state.clearConnection);
  const relaySession = useRelaySessionStore((state) => state.session);
  const clearRelaySession = useRelaySessionStore((state) => state.clearSession);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) {
      setRelayIdentityTokenProvider(null);
      resetRelayDPoPTokens();
      return;
    }
    const provider = () => getToken(relayTokenOptions());
    setRelayIdentityTokenProvider(provider);
    resetRelayDPoPTokens();
    return () => setRelayIdentityTokenProvider(null);
  }, [getToken, isLoaded, isSignedIn, userId]);

  useEffect(() => {
    if (!isLoaded) return;
    const isCloudConnection =
      connection?.authMode === "dpop" && Boolean(connection.relayURL);
    if (!isSignedIn || !userId) {
      if (isCloudConnection) void clearConnection();
      if (relaySession && !relaySession.devToken) void clearRelaySession();
      return;
    }
    if (connection?.cloudUserID && connection.cloudUserID !== userId) {
      void clearConnection();
    }
    if (
      relaySession &&
      !relaySession.devToken &&
      relaySession.userID !== userId
    ) {
      void clearRelaySession();
    }
  }, [
    clearConnection,
    clearRelaySession,
    connection,
    isLoaded,
    isSignedIn,
    relaySession,
    userId,
  ]);

  return children;
}

export function CloudAuthProvider({ children }: { children: ReactNode }) {
  if (!cloudAuthConfigured()) return children;
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <CloudAuthBridge>{children}</CloudAuthBridge>
    </ClerkProvider>
  );
}
