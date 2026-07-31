import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, EmptyState, StatusDot } from '@/components/t3-ui';
import { SPLIT_LAYOUT_MIN_WIDTH, T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  getHealth,
  listSessions,
  searchSessions,
  type AgentConnection,
  type HermesSession,
} from '@/lib/brio';

export function HermesHomeScreen({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [search, setSearch] = useState('');
  const health = useQuery({
    queryKey: ['home-health', connection.id],
    queryFn: () => getHealth(connection),
    refetchInterval: 15_000,
  });
  const sessions = useQuery({
    queryKey: ['sessions', connection.id],
    queryFn: () => listSessions(connection),
    refetchInterval: 15_000,
  });
  const searchResults = useQuery({
    queryKey: ['session-search', connection.id, search.trim()],
    queryFn: () => searchSessions(connection, search.trim()),
    enabled: search.trim().length > 1,
  });
  const resultIds = useMemo(
    () => new Set((searchResults.data?.results ?? []).map((result) => result.session_id)),
    [searchResults.data?.results],
  );
  const visibleSessions = useMemo(() => {
    const all = sessions.data?.sessions ?? [];
    if (!search.trim()) return all;
    const normalized = search.trim().toLowerCase();
    return all.filter(
      (session) =>
        resultIds.has(session.id) ||
        session.title?.toLowerCase().includes(normalized) ||
        session.model?.toLowerCase().includes(normalized),
    );
  }, [resultIds, search, sessions.data?.sessions]);
  const split = width >= SPLIT_LAYOUT_MIN_WIDTH;
  const startNewTask = () => {
    const sessionId = `brio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    router.push(`/thread/${sessionId}`);
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.brandRow}>
          <View>
            <AppText style={styles.brand}>Brio</AppText>
            <View style={styles.environmentRow}>
              <StatusDot status={health.data?.hermes_ok ? 'online' : health.isError ? 'error' : 'busy'} />
              <AppText numberOfLines={1} style={[styles.environment, { color: colors.muted }]}>
                {connection.name || 'Hermes'}
              </AppText>
            </View>
          </View>
          <View style={styles.headerActions}>
            <HeaderButton
              accessibilityLabel="Browse files"
              icon="folder"
              onPress={() => router.push('/files')}
            />
            <HeaderButton
              accessibilityLabel="Open settings"
              icon="gearshape"
              onPress={() => router.push('/settings')}
            />
          </View>
        </View>
        <AppTextInput
          accessibilityLabel="Search conversations"
          onChangeText={setSearch}
          placeholder="Search"
          returnKeyType="search"
          style={[styles.search, { backgroundColor: colors.subtleStrong, borderColor: 'transparent' }]}
          value={search}
        />
      </View>

      {sessions.isLoading ? (
        <EmptyState detail="Loading your Hermes conversations." loading title="Connecting to Hermes" />
      ) : sessions.isError ? (
        <EmptyState
          action={
            <Pressable onPress={() => void sessions.refetch()} style={styles.retry}>
              <AppText style={{ color: colors.userBubble }}>Try again</AppText>
            </Pressable>
          }
          detail={sessions.error instanceof Error ? sessions.error.message : 'The environment is unavailable.'}
          title="Environment unavailable"
        />
      ) : (
        <FlatList
          contentContainerStyle={[
            styles.listContent,
            split && styles.listContentWide,
            visibleSessions.length === 0 && styles.emptyList,
          ]}
          data={visibleSessions}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <EmptyState
              detail={
                search
                  ? 'No messages or sessions match this search.'
                  : 'Start a task to create your first Hermes conversation.'
              }
              title={search ? 'No results' : 'No conversations yet'}
            />
          }
          refreshControl={
            <RefreshControl refreshing={sessions.isRefetching} onRefresh={() => void sessions.refetch()} />
          }
          renderItem={({ item }) => (
            <SessionRow session={item} onPress={() => router.push(`/thread/${encodeURIComponent(item.id)}`)} />
          )}
        />
      )}

      <Pressable
        accessibilityLabel="Start a new task"
        accessibilityRole="button"
        onPress={startNewTask}
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: colors.primary, opacity: pressed ? 0.72 : 1 },
        ]}>
        <SymbolView name="plus" size={22} tintColor={colors.primaryForeground} />
        {split ? (
          <AppText style={[styles.fabLabel, { color: colors.primaryForeground }]}>New task</AppText>
        ) : null}
      </Pressable>
    </SafeAreaView>
  );
}

function HeaderButton({
  accessibilityLabel,
  icon,
  onPress,
}: {
  accessibilityLabel: string;
  icon: 'folder' | 'gearshape';
  onPress: () => void;
}) {
  const colors = useT3Theme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerButton,
        { backgroundColor: colors.subtleStrong, opacity: pressed ? 0.55 : 1 },
      ]}>
      <SymbolView name={icon} size={18} tintColor={colors.foreground} />
    </Pressable>
  );
}

function SessionRow({ session, onPress }: { session: HermesSession; onPress: () => void }) {
  const colors = useT3Theme();
  const date = formatRelativeTime(session.started_at);
  const title = session.title?.trim() || 'Untitled conversation';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.sessionRow,
        { borderBottomColor: colors.separator, opacity: pressed ? 0.55 : 1 },
      ]}>
      <View style={[styles.sessionIcon, { backgroundColor: colors.subtle }]}>
        <SymbolView name="text.bubble" size={18} tintColor={colors.secondary} />
      </View>
      <View style={styles.sessionCopy}>
        <View style={styles.sessionTitleRow}>
          <AppText numberOfLines={1} style={styles.sessionTitle}>
            {title}
          </AppText>
          <AppText style={[styles.sessionDate, { color: colors.tertiary }]}>{date}</AppText>
        </View>
        <AppText numberOfLines={1} style={[styles.sessionMeta, { color: colors.muted }]}>
          {session.message_count} {session.message_count === 1 ? 'message' : 'messages'}
          {session.model ? ` · ${session.model}` : ''}
        </AppText>
      </View>
      <AppText style={{ color: colors.tertiary }}>›</AppText>
    </Pressable>
  );
}

function formatRelativeTime(timestamp: number) {
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const delta = Date.now() - milliseconds;
  if (!Number.isFinite(delta)) return '';
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d`;
  return new Date(milliseconds).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: T3Spacing.lg,
    paddingBottom: T3Spacing.lg,
    paddingHorizontal: T3Spacing.xl,
    paddingTop: T3Spacing.md,
  },
  brandRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  brand: { fontFamily: T3Typography.bold, fontSize: 26, lineHeight: 32 },
  environmentRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  environment: { fontSize: 13, lineHeight: 17, maxWidth: 220 },
  headerActions: { flexDirection: 'row', gap: T3Spacing.sm },
  headerButton: {
    alignItems: 'center',
    borderRadius: T3Radius.medium,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  search: { minHeight: 42, paddingVertical: 8 },
  listContent: { paddingBottom: 112, paddingHorizontal: T3Spacing.xl },
  listContentWide: { alignSelf: 'center', maxWidth: 760, width: '100%' },
  emptyList: { flexGrow: 1 },
  sessionRow: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: T3Spacing.md,
    minHeight: 76,
    paddingVertical: T3Spacing.md,
  },
  sessionIcon: {
    alignItems: 'center',
    borderRadius: T3Radius.medium,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  sessionCopy: { flex: 1, gap: 2 },
  sessionTitleRow: { alignItems: 'baseline', flexDirection: 'row', gap: T3Spacing.sm },
  sessionTitle: { flex: 1, fontFamily: T3Typography.medium, fontSize: 16 },
  sessionDate: { fontSize: 12, lineHeight: 16 },
  sessionMeta: { fontSize: 13, lineHeight: 17 },
  retry: { padding: T3Spacing.md },
  fab: {
    alignItems: 'center',
    borderRadius: T3Radius.pill,
    bottom: T3Spacing.xxl,
    flexDirection: 'row',
    gap: T3Spacing.sm,
    minHeight: 56,
    paddingHorizontal: 18,
    position: 'absolute',
    right: T3Spacing.xxl,
    shadowColor: '#000000',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
  },
  fabLabel: { fontFamily: T3Typography.bold, fontSize: 14 },
});
