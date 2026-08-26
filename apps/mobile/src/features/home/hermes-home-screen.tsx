import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
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
import {
  DEFAULT_PROFILE_NAME,
  environmentId,
  isNamedProfile,
  listProfiles,
  profileName,
  type HermesProfile,
} from '@/lib/profiles';
import { resolveBrioDeepLink } from '@/lib/profiles-model';
import { useDeepLinkStore } from '@/state/deep-link-store';
import { useProfileStore } from '@/state/profile-store';

export function HermesHomeScreen({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [search, setSearch] = useState('');
  const agentId = environmentId(connection);
  const storedProfiles = useProfileStore((state) => state.activeProfiles);
  const setActiveProfile = useProfileStore((state) => state.setActiveProfile);
  const pendingDeepLink = useDeepLinkStore((state) => state.pending);
  const consumeDeepLink = useDeepLinkStore((state) => state.consume);
  const profilesQuery = useQuery({
    queryKey: ['profiles', connection.url, agentId],
    queryFn: () => listProfiles(connection),
    staleTime: 30_000,
    retry: false,
  });
  const profiles: HermesProfile[] = useMemo(
    () => profilesQuery.data?.profiles ?? [],
    [profilesQuery.data?.profiles],
  );
  const requestedProfile = storedProfiles[agentId];
  const activeProfile = profiles.some((profile) => profile.name === requestedProfile)
    ? profileName(requestedProfile)
    : profilesQuery.data
      ? profileName(profilesQuery.data.active)
      : DEFAULT_PROFILE_NAME;
  useEffect(() => {
    if (!pendingDeepLink || !profilesQuery.data) return;
    const resolved = resolveBrioDeepLink(pendingDeepLink, agentId, profiles);
    consumeDeepLink();
    if (!resolved) return;
    void setActiveProfile(
      agentId,
      isNamedProfile(resolved.profile) ? resolved.profile : undefined,
    );
    if (!resolved.sessionId) return;
    router.push(
      `/thread/${encodeURIComponent(resolved.sessionId)}${
        isNamedProfile(resolved.profile)
          ? `?profile=${encodeURIComponent(resolved.profile)}`
          : ''
      }`,
    );
  }, [
    agentId,
    consumeDeepLink,
    pendingDeepLink,
    profiles,
    profilesQuery.data,
    router,
    setActiveProfile,
  ]);
  const health = useQuery({
    queryKey: ['home-health', connection.id, connection.url],
    queryFn: () => getHealth(connection),
    refetchInterval: 15_000,
  });
  const sessions = useQuery({
    queryKey: ['sessions', connection.id, connection.url, activeProfile],
    queryFn: () => listSessions(connection, 100, activeProfile),
    refetchInterval: 15_000,
  });
  const searchResults = useQuery({
    queryKey: ['session-search', connection.id, connection.url, activeProfile, search.trim()],
    queryFn: () => searchSessions(connection, search.trim(), activeProfile),
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
  const threadPath = (sessionId: string) =>
    `/thread/${encodeURIComponent(sessionId)}${
      isNamedProfile(activeProfile) ? `?profile=${encodeURIComponent(activeProfile)}` : ''
    }` as const;
  const startNewTask = () => {
    // `new` tells the thread screen to create a Hermes gateway session on the
    // first prompt. A made-up stored session id is treated as a resume request
    // by Hermes and leaves a fresh conversation in an error state.
    router.push(threadPath('new'));
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.brandRow}>
          <Pressable
            accessibilityHint="Opens saved environments"
            accessibilityLabel={`Current environment: ${connection.name || 'Hermes'}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => router.push('/environments')}
            style={({ pressed }) => [styles.environmentButton, { opacity: pressed ? 0.6 : 1 }]}
          >
            <AppText style={styles.brand}>Brio</AppText>
            <View style={styles.environmentRow}>
              <StatusDot status={health.data?.hermes_ok ? 'online' : health.isError ? 'error' : 'busy'} />
              <AppText numberOfLines={1} style={[styles.environment, { color: colors.muted }]}>
                {connection.name || 'Hermes'}
              </AppText>
              <SymbolView name="chevron.down" size={10} tintColor={colors.tertiary} />
            </View>
          </Pressable>
          <View style={styles.headerActions}>
            <HeaderButton
              accessibilityLabel="Manage Hermes profiles"
              icon="person.2"
              onPress={() => router.push('/profiles')}
            />
            <HeaderButton
              accessibilityLabel="Open Command Center"
              icon="square.grid.2x2"
              onPress={() => router.push('/command-center')}
            />
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
        {profiles.length > 1 ? (
          <ScrollView
            contentContainerStyle={styles.profileChips}
            horizontal
            showsHorizontalScrollIndicator={false}>
            {profiles.map((profile) => {
              const selected = profile.name === activeProfile;
              return (
                <Pressable
                  accessibilityLabel={`Switch to profile ${profile.name}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={profile.name}
                  onPress={() =>
                    void setActiveProfile(
                      agentId,
                      isNamedProfile(profile.name) ? profile.name : undefined,
                    )
                  }
                  style={({ pressed }) => [
                    styles.profileChip,
                    {
                      backgroundColor: selected ? colors.primary : colors.subtleStrong,
                      borderColor: selected ? colors.primary : colors.border,
                      opacity: pressed ? 0.65 : 1,
                    },
                  ]}>
                  <StatusDot status={profile.gateway_running ? 'online' : 'offline'} />
                  <AppText
                    numberOfLines={1}
                    style={[
                      styles.profileLabel,
                      { color: selected ? colors.primaryForeground : colors.foreground },
                    ]}>
                    {profile.name}
                  </AppText>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
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
            <SessionRow session={item} onPress={() => router.push(threadPath(item.id))} />
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
  icon: 'folder' | 'gearshape' | 'person.2' | 'square.grid.2x2';
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
  environmentButton: { flexShrink: 1 },
  brand: { fontFamily: T3Typography.bold, fontSize: 26, lineHeight: 32 },
  environmentRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  environment: { fontSize: 13, lineHeight: 17, maxWidth: 220 },
  headerActions: { flexDirection: 'row', gap: T3Spacing.sm },
  profileChips: { gap: T3Spacing.sm },
  profileChip: {
    alignItems: 'center',
    borderRadius: T3Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: T3Spacing.sm,
    maxWidth: 180,
    paddingHorizontal: T3Spacing.md,
    paddingVertical: 7,
  },
  profileLabel: { fontFamily: T3Typography.medium, fontSize: 13, lineHeight: 17 },
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
