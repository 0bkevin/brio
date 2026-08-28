import { Redirect } from 'expo-router';

import { HermesAutomationScreen } from '@/features/automation/hermes-automation-screen';
import { useConnectionStore } from '@/state/connection-store';

export default function AutomationRoute() {
  const connection = useConnectionStore((state) => state.connection);
  if (!connection) return <Redirect href="/" />;
  return <HermesAutomationScreen connection={connection} />;
}
