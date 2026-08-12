import { Redirect } from 'expo-router';

import { HermesCommandCenterScreen } from '@/features/command-center/hermes-command-center-screen';
import { useConnectionStore } from '@/state/connection-store';

export default function CommandCenterRoute() {
  const connection = useConnectionStore((state) => state.connection);
  if (!connection) return <Redirect href="/" />;
  return <HermesCommandCenterScreen connection={connection} />;
}

