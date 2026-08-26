import { Redirect, useLocalSearchParams } from 'expo-router';

import { HermesThreadScreen } from '@/features/threads/hermes-thread-screen';
import { profileName } from '@/lib/profiles';
import type { ChatModelOverride } from '@/state/chat-thread-model';
import { useConnectionStore } from '@/state/connection-store';

export default function ThreadRoute() {
  const { effort, fast, id, model, profile, provider } = useLocalSearchParams<{
    effort?: string;
    fast?: string;
    id: string;
    model?: string;
    profile?: string;
    provider?: string;
  }>();
  const connection = useConnectionStore((state) => state.connection);
  const initialModelOverride: ChatModelOverride | undefined =
    provider?.trim() && model?.trim()
      ? {
          provider: provider.trim(),
          model: model.trim(),
          ...(effort?.trim() ? { reasoningEffort: effort.trim() } : {}),
          ...(fast === 'true' || fast === 'false' ? { fast: fast === 'true' } : {}),
        }
      : undefined;

  if (!connection) return <Redirect href="/" />;
  return (
    <HermesThreadScreen
      connection={connection}
      initialModelOverride={initialModelOverride}
      profile={profileName(profile)}
      routeSessionId={decodeURIComponent(id ?? 'new')}
    />
  );
}
