import { Redirect } from 'expo-router';

import { HermesSettingsScreen } from '@/features/settings/hermes-settings-screen';
import { useConnectionStore } from '@/state/connection-store';

export default function SettingsRoute() {
  const connection = useConnectionStore((state) => state.connection);
  if (!connection) return <Redirect href="/" />;
  return <HermesSettingsScreen connection={connection} />;
}
