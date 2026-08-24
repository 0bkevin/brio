import { Redirect } from 'expo-router';

import { HermesFilesScreen } from '@/features/files/hermes-files-screen';
import { useConnectionStore } from '@/state/connection-store';

export default function FilesRoute() {
  const connection = useConnectionStore((state) => state.connection);
  if (!connection) return <Redirect href="/" />;
  return <HermesFilesScreen connection={connection} />;
}
