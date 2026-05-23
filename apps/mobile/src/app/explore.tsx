import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { brioFetch, getCapabilities, getHealth } from '@/lib/brio';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useConnectionStore } from '@/state/connection-store';

export default function ManageScreen() {
  const theme = useTheme();
  const connection = useConnectionStore((state) => state.connection);

  const health = useQuery({
    queryKey: ['manage-health', connection?.url],
    queryFn: () => getHealth(connection!),
    enabled: Boolean(connection),
  });
  const capabilities = useQuery({
    queryKey: ['capabilities', connection?.url],
    queryFn: () => getCapabilities(connection!),
    enabled: Boolean(connection),
  });
  const sessions = useQuery({
    queryKey: ['sessions', connection?.url],
    queryFn: () => brioFetch<{ sessions: unknown[] }>(connection!, '/sessions?limit=5'),
    enabled: Boolean(connection),
  });
  const memory = useQuery({
    queryKey: ['memory', connection?.url],
    queryFn: () => brioFetch<{ memory: string; user: string }>(connection!, '/memory'),
    enabled: Boolean(connection),
  });

  if (!connection) {
    return (
      <ThemedView style={styles.centered}>
        <ThemedText>Connect an agent from the Chat tab.</ThemedText>
      </ThemedView>
    );
  }

  return (
    <ScrollView style={[styles.scroll, { backgroundColor: theme.background }]}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedView style={styles.header}>
          <ThemedText type="subtitle">Manage</ThemedText>
          <ThemedText themeColor="textSecondary">{connection.url}</ThemedText>
        </ThemedView>

        <StatusCard
          title="Health"
          loading={health.isLoading}
          rows={[
            ['Companion', health.data?.ok ? 'online' : 'unknown'],
            ['Hermes', health.data?.hermes_ok ? 'online' : 'not reachable'],
            ['Home', health.data?.hermes_home ?? 'unknown'],
          ]}
          onRefresh={() => void health.refetch()}
        />

        <StatusCard
          title="Capabilities"
          loading={capabilities.isLoading}
          rows={[
            ['Files', capabilities.data?.companion?.files ? 'available' : 'unknown'],
            ['Sessions', capabilities.data?.companion?.sessions ? 'available' : 'unknown'],
            ['Gateway', capabilities.data?.companion?.gateway ? 'available' : 'unknown'],
          ]}
          onRefresh={() => void capabilities.refetch()}
        />

        <StatusCard
          title="Recent Sessions"
          loading={sessions.isLoading}
          rows={(sessions.data?.sessions ?? []).map((item, index) => [
            `#${index + 1}`,
            JSON.stringify(item),
          ])}
          onRefresh={() => void sessions.refetch()}
        />

        <StatusCard
          title="Memory"
          loading={memory.isLoading}
          rows={[
            ['MEMORY.md', `${memory.data?.memory?.length ?? 0} chars`],
            ['USER.md', `${memory.data?.user?.length ?? 0} chars`],
          ]}
          onRefresh={() => void memory.refetch()}
        />
      </SafeAreaView>
    </ScrollView>
  );
}

function StatusCard({
  loading,
  onRefresh,
  rows,
  title,
}: {
  loading?: boolean;
  onRefresh: () => void;
  rows: [string, string][];
  title: string;
}) {
  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <View style={styles.cardHeader}>
        <ThemedText type="smallBold">{title}</ThemedText>
        <Pressable onPress={onRefresh} style={styles.refreshButton}>
          <ThemedText type="link">Refresh</ThemedText>
        </Pressable>
      </View>
      {loading ? <ActivityIndicator /> : null}
      {rows.length ? (
        rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <ThemedText themeColor="textSecondary">{label}</ThemedText>
            <ThemedText style={styles.rowValue}>{value}</ThemedText>
          </View>
        ))
      ) : (
        <ThemedText themeColor="textSecondary">No data.</ThemedText>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  safeArea: {
    alignSelf: 'center',
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    paddingBottom: BottomTabInset + Spacing.four,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    width: '100%',
  },
  header: {
    gap: Spacing.one,
  },
  card: {
    borderRadius: Spacing.two,
    gap: Spacing.two,
    padding: Spacing.three,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  refreshButton: {
    padding: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
  },
  rowValue: {
    flex: 1,
    textAlign: 'right',
  },
  centered: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: Spacing.four,
  },
});
