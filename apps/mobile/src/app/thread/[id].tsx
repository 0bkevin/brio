import { Redirect, useLocalSearchParams } from 'expo-router';

import { HermesThreadScreen } from '@/features/threads/hermes-thread-screen';
import { useConnectionStore } from '@/state/connection-store';

export default function ThreadRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const connection = useConnectionStore((state) => state.connection);

  if (!connection) return <Redirect href="/" />;
  return <HermesThreadScreen connection={connection} routeSessionId={decodeURIComponent(id ?? 'new')} />;
}
