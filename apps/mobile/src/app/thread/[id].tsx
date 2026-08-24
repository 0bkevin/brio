import { Redirect, useLocalSearchParams } from 'expo-router';

import { HermesThreadScreen } from '@/features/threads/hermes-thread-screen';
import { profileName } from '@/lib/profiles';
import { useConnectionStore } from '@/state/connection-store';

export default function ThreadRoute() {
  const { id, profile } = useLocalSearchParams<{ id: string; profile?: string }>();
  const connection = useConnectionStore((state) => state.connection);

  if (!connection) return <Redirect href="/" />;
  return (
    <HermesThreadScreen
      connection={connection}
      profile={profileName(profile)}
      routeSessionId={decodeURIComponent(id ?? 'new')}
    />
  );
}
