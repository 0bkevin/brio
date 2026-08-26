import { useQuery } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SessionModelControls } from '@/components/session-model-controls';
import { AppText, AppTextInput, EmptyState, StatusDot } from '@/components/t3-ui';
import { SPLIT_LAYOUT_MIN_WIDTH, T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  getHealth,
  getModelOptions,
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
import { modelIncompatibilities, selectedCapabilities } from '@/lib/session-runtime';
import { useComposerStore } from '@/state/composer-store';
import type { ChatModelOverride, ChatThread } from '@/state/chat-thread-model';
import { useDeepLinkStore } from '@/state/deep-link-store';
import { useProfileStore } from '@/state/profile-store';

const SWIPE_DISTANCE = 64;

export function HermesHomeScreen({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [startError, setStartError] = useState('');
  const [starting, setStarting] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [newThreadModels, setNewThreadModels] = useState<
    Record<string, ChatModelOverride | undefined>
  >({});
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
  const activeProfileData = profiles.find((profile) => profile.name === activeProfile);
  const composerKey = `${connection.id}:${activeProfile}:new`;
  const newThreadModel = newThreadModels[composerKey];
  const composerHydrated = useComposerStore((state) => state.hydrated);
  const draft = useComposerStore((state) => state.drafts[composerKey] ?? '');
  const setDraft = useComposerStore((state) => state.setDraft);
  const enqueueDraft = useComposerStore((state) => state.enqueueDraft);

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
  const modelOptions = useQuery({
    queryKey: ['model-options', connection.id, connection.url, activeProfile],
    queryFn: () => getModelOptions(connection, false, activeProfile),
    staleTime: 5 * 60_000,
    retry: 1,
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
  const threadPath = (sessionId: string, override?: ChatModelOverride) => {
    const params: string[] = [];
    if (isNamedProfile(activeProfile)) {
      params.push(`profile=${encodeURIComponent(activeProfile)}`);
    }
    if (override) {
      params.push(`provider=${encodeURIComponent(override.provider)}`);
      params.push(`model=${encodeURIComponent(override.model)}`);
      if (override.reasoningEffort) {
        params.push(`effort=${encodeURIComponent(override.reasoningEffort)}`);
      }
      if (typeof override.fast === 'boolean') params.push(`fast=${String(override.fast)}`);
    }
    return `/thread/${encodeURIComponent(sessionId)}${params.length ? `?${params.join('&')}` : ''}` as const;
  };

  const homeSwipe = useMemo(
    () =>
      createHorizontalSwipe({
        onLeft: () => setHistoryOpen(true),
        onRight: () => setSettingsOpen(true),
      }),
    [],
  );
  const historySwipe = useMemo(
    () => createHorizontalSwipe({ onRight: () => setHistoryOpen(false) }),
    [],
  );
  const settingsSwipe = useMemo(
    () => createHorizontalSwipe({ onLeft: () => setSettingsOpen(false) }),
    [],
  );

  const startNewTask = async () => {
    if (!composerHydrated || !draft.trim() || starting) return;
    setStartError('');
    setStarting(true);
    try {
      const queued = await enqueueDraft(composerKey, 'queue', newThreadModel);
      if (!queued) {
        setStartError('Write a message for Hermes before starting.');
        return;
      }
      router.push(threadPath('new', newThreadModel));
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : 'Could not start this conversation.');
    } finally {
      setStarting(false);
    }
  };
  const openThread = (sessionId: string) => {
    setHistoryOpen(false);
    router.push(threadPath(sessionId));
  };
  const openTool = (href: Href) => {
    setSettingsOpen(false);
    router.push(href);
  };
  const agentStatus = activeProfileData?.gateway_running === false
    ? 'offline'
    : health.isError
      ? 'error'
      : health.data?.hermes_ok
        ? 'online'
        : 'busy';
  const newThread: ChatThread = {
    id: 'new',
    profile: activeProfile,
    title: 'New Thread',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    ...(newThreadModel ? { modelOverride: newThreadModel } : {}),
  };
  const composerDestination =
    activeProfileData?.alias_name?.trim() || connection.name?.trim() || 'Hermes';
  const selectedModelBlocked = Boolean(
    newThreadModel &&
      modelIncompatibilities(
        selectedCapabilities(
          modelOptions.data ?? { model: null, provider: null, providers: [] },
          newThreadModel.provider,
          newThreadModel.model,
        ),
        { vision: false, tools: true },
      ).length,
  );
  const canStart =
    composerHydrated && Boolean(draft.trim()) && !starting && !selectedModelBlocked;
  const composerExpanded = composerFocused || modelPickerOpen;

  return (
    <SafeAreaView
      {...(historyOpen || settingsOpen ? {} : homeSwipe.panHandlers)}
      edges={['top', 'bottom', 'left', 'right']}
      style={[styles.safe, { backgroundColor: colors.screen }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.safe}>
        <View style={[styles.threadHeader, { borderBottomColor: colors.border }]}>
          <Pressable
            accessibilityHint="Opens conversation history"
            accessibilityLabel="Conversation history"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setHistoryOpen(true)}
            style={({ pressed }) => [styles.backButton, { opacity: pressed ? 0.5 : 1 }]}>
            <AppText style={styles.backChevron}>‹</AppText>
          </Pressable>
          <AppText style={styles.threadTitle}>New Thread</AppText>
        </View>

        <View style={styles.conversationCanvas}>
          <EmptyState
            detail="Describe the outcome you want. Brio will keep the session running even when you leave this screen."
            title={`What should ${composerDestination} work on?`}
          />
        </View>

        <View style={[styles.composerDock, split && styles.composerDockWide]}>
          {startError ? (
            <AppText style={[styles.startError, { color: colors.danger }]}>{startError}</AppText>
          ) : null}
          <View
            style={[
              styles.promptComposer,
              composerExpanded ? styles.promptComposerExpanded : styles.promptComposerCollapsed,
              { backgroundColor: colors.cardAlt, borderColor: colors.border },
            ]}>
            <View style={composerExpanded ? styles.expandedInputRow : styles.collapsedInputRow}>
              <AppTextInput
                accessibilityLabel="Describe a coding task"
                maxLength={20000}
                multiline
                onChangeText={(value) => setDraft(composerKey, value)}
                onBlur={() => setComposerFocused(false)}
                onFocus={() => setComposerFocused(true)}
                placeholder={`Describe a coding task in ${composerDestination}`}
                style={[
                  styles.promptInput,
                  composerExpanded ? styles.promptInputExpanded : styles.promptInputCollapsed,
                  { backgroundColor: 'transparent', borderColor: 'transparent' },
                ]}
                textAlignVertical="top"
                value={draft}
              />
            </View>
            <View style={styles.promptFooter}>
              <SessionModelControls
                onOverrideChange={(override) =>
                  setNewThreadModels((current) => ({ ...current, [composerKey]: override }))
                }
                onOpenChange={setModelPickerOpen}
                options={modelOptions.data}
                optionsError={modelOptions.isError}
                optionsLoading={modelOptions.isLoading}
                showUsage={false}
                thread={newThread}
                variant="inline"
              />
              <View style={styles.footerSpacer} />
              <Pressable
                accessibilityLabel="Send to Hermes"
                accessibilityRole="button"
                disabled={!canStart}
                onPress={() => void startNewTask()}
                style={({ pressed }) => [
                  styles.sendButton,
                  {
                    backgroundColor: canStart ? colors.primary : colors.subtleStrong,
                    opacity: pressed ? 0.65 : 1,
                  },
                ]}>
                <AppText
                  style={[
                    styles.sendLabel,
                    { color: canStart ? colors.primaryForeground : colors.tertiary },
                  ]}>
                  {starting ? '…' : '↑'}
                </AppText>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal animationType="fade" onRequestClose={() => setHistoryOpen(false)} visible={historyOpen}>
        <SafeAreaView
          {...historySwipe.panHandlers}
          edges={['top', 'bottom', 'left', 'right']}
          style={[styles.panel, { backgroundColor: colors.screen }]}>
          <PanelHeader
            detail="Swipe right to return"
            onClose={() => setHistoryOpen(false)}
            title="History"
          />
          <View style={[styles.panelSearch, split && styles.panelWide]}>
            <AppTextInput
              accessibilityLabel="Search conversations"
              onChangeText={setSearch}
              placeholder="Search conversations"
              returnKeyType="search"
              style={[
                styles.search,
                { backgroundColor: colors.subtleStrong, borderColor: 'transparent' },
              ]}
              value={search}
            />
          </View>
          <FlatList
            contentContainerStyle={[
              styles.historyContent,
              split && styles.panelWide,
              visibleSessions.length === 0 && styles.emptyHistory,
            ]}
            data={sessions.isError ? [] : visibleSessions}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={
              sessions.isLoading ? (
                <EmptyState
                  detail="Loading your Hermes conversations."
                  loading
                  title="Connecting to Hermes"
                />
              ) : sessions.isError ? (
                <EmptyState
                  action={
                    <Pressable onPress={() => void sessions.refetch()} style={styles.retry}>
                      <AppText style={{ color: colors.userBubble }}>Try again</AppText>
                    </Pressable>
                  }
                  detail={
                    sessions.error instanceof Error
                      ? sessions.error.message
                      : 'The environment is unavailable.'
                  }
                  title="History unavailable"
                />
              ) : (
                <EmptyState
                  detail={
                    search
                      ? 'No messages or conversations match this search.'
                      : 'Your conversations with Hermes will appear here.'
                  }
                  title={search ? 'No results' : 'No conversations yet'}
                />
              )
            }
            refreshControl={
              <RefreshControl
                refreshing={sessions.isRefetching}
                onRefresh={() => void sessions.refetch()}
              />
            }
            renderItem={({ item }) => (
              <SessionRow session={item} onPress={() => openThread(item.id)} />
            )}
          />
        </SafeAreaView>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setSettingsOpen(false)} visible={settingsOpen}>
        <SafeAreaView
          {...settingsSwipe.panHandlers}
          edges={['top', 'bottom', 'left', 'right']}
          style={[styles.panel, { backgroundColor: colors.screen }]}>
          <PanelHeader
            detail="Swipe left to return"
            onClose={() => setSettingsOpen(false)}
            title="Settings & tools"
          />
          <ScrollView
            contentContainerStyle={[styles.settingsContent, split && styles.panelWide]}
            showsVerticalScrollIndicator={false}>
            <Pressable
              accessibilityLabel={`Current environment: ${connection.name || 'Hermes'}`}
              accessibilityRole="button"
              onPress={() => openTool('/environments')}
              style={({ pressed }) => [
                styles.environmentCard,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  opacity: pressed ? 0.6 : 1,
                },
              ]}>
              <StatusDot status={agentStatus} />
              <View style={styles.environmentCopy}>
                <AppText style={styles.environmentName}>{connection.name || 'Hermes'}</AppText>
                <AppText numberOfLines={1} style={[styles.environmentMeta, { color: colors.muted }]}>
                  {activeProfile}
                  {activeProfileData?.model ? ` · ${activeProfileData.model}` : ''}
                </AppText>
              </View>
              <AppText style={{ color: colors.tertiary }}>›</AppText>
            </Pressable>
            <View style={[styles.menu, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <MenuRow
                detail="Agents, models, and identity"
                label="Profiles"
                onPress={() => openTool('/profiles')}
              />
              <MenuRow
                detail="Runs, sessions, and controls"
                label="Command Center"
                onPress={() => openTool('/command-center')}
              />
              <MenuRow
                detail="Browse the connected workspace"
                label="Files"
                onPress={() => openTool('/files')}
              />
              <MenuRow
                detail="Hermes and connection preferences"
                label="Settings"
                onPress={() => openTool('/settings')}
              />
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function createHorizontalSwipe({
  onLeft,
  onRight,
}: {
  onLeft?: () => void;
  onRight?: () => void;
}) {
  const wantsHorizontalSwipe = (_: unknown, gesture: { dx: number; dy: number }) =>
    Math.abs(gesture.dx) > 18 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4;
  return PanResponder.create({
    onMoveShouldSetPanResponder: wantsHorizontalSwipe,
    onMoveShouldSetPanResponderCapture: wantsHorizontalSwipe,
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx <= -SWIPE_DISTANCE) onLeft?.();
      if (gesture.dx >= SWIPE_DISTANCE) onRight?.();
    },
    onPanResponderTerminationRequest: () => true,
  });
}

function PanelHeader({
  detail,
  onClose,
  title,
}: {
  detail: string;
  onClose: () => void;
  title: string;
}) {
  const colors = useT3Theme();
  return (
    <View style={[styles.panelHeader, { borderBottomColor: colors.border }]}>
      <View style={styles.panelHeaderCopy}>
        <AppText style={styles.panelTitle}>{title}</AppText>
        <AppText style={[styles.panelDetail, { color: colors.muted }]}>{detail}</AppText>
      </View>
      <Pressable
        accessibilityLabel="Return to chat"
        accessibilityRole="button"
        onPress={onClose}
        style={({ pressed }) => [
          styles.chatButton,
          { backgroundColor: colors.subtleStrong, opacity: pressed ? 0.6 : 1 },
        ]}>
        <AppText style={styles.chatButtonLabel}>Chat</AppText>
      </Pressable>
    </View>
  );
}

function MenuRow({ detail, label, onPress }: { detail: string; label: string; onPress: () => void }) {
  const colors = useT3Theme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuRow,
        { borderTopColor: colors.separator, opacity: pressed ? 0.55 : 1 },
      ]}>
      <View style={styles.menuCopy}>
        <AppText style={styles.menuLabel}>{label}</AppText>
        <AppText style={[styles.menuDetail, { color: colors.muted }]}>{detail}</AppText>
      </View>
      <AppText style={{ color: colors.tertiary }}>›</AppText>
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
  threadHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 62,
    paddingHorizontal: T3Spacing.lg,
  },
  backButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    marginLeft: -8,
    width: 44,
  },
  backChevron: { fontSize: 42, fontFamily: T3Typography.regular, lineHeight: 42 },
  threadTitle: {
    fontFamily: T3Typography.bold,
    fontSize: 22,
    letterSpacing: -0.25,
    lineHeight: 28,
  },
  conversationCanvas: { flex: 1 },
  composerDock: { paddingBottom: T3Spacing.sm, paddingHorizontal: T3Spacing.lg, paddingTop: T3Spacing.sm },
  composerDockWide: { alignSelf: 'center', maxWidth: 760, width: '100%' },
  promptComposer: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  promptComposerCollapsed: {
    borderRadius: 26,
    minHeight: 104,
    paddingBottom: 7,
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  promptComposerExpanded: {
    borderRadius: 26,
    minHeight: 140,
    paddingBottom: 6,
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  collapsedInputRow: { alignItems: 'center', flexDirection: 'row' },
  expandedInputRow: { minHeight: 78 },
  promptInput: {
    flex: 1,
    fontSize: 17,
    lineHeight: 24,
  },
  promptInputCollapsed: { borderWidth: 0, height: 44, minHeight: 44, paddingHorizontal: T3Spacing.xs, paddingVertical: 4 },
  promptInputExpanded: { borderWidth: 0, maxHeight: 150, minHeight: 78, paddingHorizontal: T3Spacing.xs, paddingTop: T3Spacing.xs },
  promptFooter: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.md },
  footerSpacer: { flex: 1 },
  sendButton: {
    alignItems: 'center',
    borderRadius: T3Radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  sendLabel: { fontFamily: T3Typography.bold, fontSize: 21, lineHeight: 24 },
  startError: { fontSize: 13, lineHeight: 17, paddingBottom: T3Spacing.sm, paddingHorizontal: T3Spacing.xs },
  panel: { flex: 1 },
  panelHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingHorizontal: T3Spacing.xl,
    paddingVertical: T3Spacing.md,
  },
  panelHeaderCopy: { flex: 1 },
  panelTitle: { fontFamily: T3Typography.bold, fontSize: 21, lineHeight: 27 },
  panelDetail: { fontSize: 12, lineHeight: 16 },
  chatButton: { borderRadius: T3Radius.pill, paddingHorizontal: 14, paddingVertical: 9 },
  chatButtonLabel: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 17 },
  panelSearch: { paddingHorizontal: T3Spacing.xl, paddingTop: T3Spacing.lg },
  panelWide: { alignSelf: 'center', maxWidth: 760, width: '100%' },
  search: { minHeight: 44, paddingVertical: 8 },
  historyContent: { flexGrow: 1, paddingBottom: T3Spacing.huge, paddingHorizontal: T3Spacing.xl },
  emptyHistory: { flexGrow: 1 },
  sessionRow: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 76,
    paddingVertical: T3Spacing.md,
  },
  sessionCopy: { flex: 1, gap: 2 },
  sessionTitleRow: { alignItems: 'baseline', flexDirection: 'row', gap: T3Spacing.sm },
  sessionTitle: { flex: 1, fontFamily: T3Typography.medium, fontSize: 16 },
  sessionDate: { fontSize: 12, lineHeight: 16 },
  sessionMeta: { fontSize: 13, lineHeight: 17 },
  retry: { padding: T3Spacing.md },
  settingsContent: {
    gap: T3Spacing.lg,
    padding: T3Spacing.xl,
    paddingBottom: T3Spacing.huge,
  },
  environmentCard: {
    alignItems: 'center',
    borderRadius: T3Radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: T3Spacing.md,
    minHeight: 76,
    padding: T3Spacing.lg,
  },
  environmentCopy: { flex: 1 },
  environmentName: { fontFamily: T3Typography.bold, fontSize: 16, lineHeight: 21 },
  environmentMeta: { fontSize: 12, lineHeight: 16 },
  menu: {
    borderRadius: T3Radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    paddingHorizontal: T3Spacing.lg,
  },
  menuRow: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 70,
    paddingVertical: T3Spacing.sm,
  },
  menuCopy: { flex: 1 },
  menuLabel: { fontFamily: T3Typography.medium, fontSize: 15, lineHeight: 20 },
  menuDetail: { fontSize: 12, lineHeight: 16 },
});
