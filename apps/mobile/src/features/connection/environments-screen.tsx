import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card, StatusDot } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import { getHealth, normalizeConnectionURL, type AgentConnection } from '@/lib/brio';
import { useConnectionStore } from '@/state/connection-store';

export function EnvironmentsScreen() {
  const colors = useT3Theme();
  const router = useRouter();
  const connections = useConnectionStore((state) => state.connections);
  const activeConnectionId = useConnectionStore((state) => state.activeConnectionId);

  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.safe, { backgroundColor: colors.sheet }]}
    >
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {connections.length ? (
          <Card>
            {connections.map((connection, index) => (
              <View key={connection.id}>
                {index ? (
                  <View style={[styles.divider, { backgroundColor: colors.separator }]} />
                ) : null}
                <EnvironmentRow
                  active={connection.id === activeConnectionId}
                  connection={connection}
                />
              </View>
            ))}
          </Card>
        ) : (
          <Card style={styles.emptyCard}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.subtle }]}>
              <SymbolView
                name="point.3.connected.trianglepath.dotted"
                size={22}
                tintColor={colors.secondary}
              />
            </View>
            <AppText style={styles.emptyTitle}>No environments connected</AppText>
            <AppText style={[styles.emptyDetail, { color: colors.muted }]}>
              Add a Hermes machine to access its conversations and tools.
            </AppText>
          </Card>
        )}

        <Button onPress={() => router.push('/relay')}>Add environment</Button>
        <AppText style={[styles.note, { color: colors.muted }]}>
          Switching environments keeps every saved connection available on this device.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

function EnvironmentRow({ active, connection }: { active: boolean; connection: AgentConnection }) {
  const colors = useT3Theme();
  const router = useRouter();
  const selectConnection = useConnectionStore((state) => state.selectConnection);
  const removeConnection = useConnectionStore((state) => state.removeConnection);
  const updateSavedConnection = useConnectionStore((state) => state.updateSavedConnection);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(connection.name);
  const [url, setURL] = useState(connection.url);
  const [saveError, setSaveError] = useState('');
  const health = useQuery({
    queryKey: ['environment-health', connection.id, connection.url],
    queryFn: () => getHealth(connection),
    retry: false,
  });

  const choose = async () => {
    try {
      await selectConnection(connection.id);
      router.dismissTo('/');
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : 'Could not switch environments.');
    }
  };

  const save = async () => {
    const normalizedURL = normalizeConnectionURL(url);
    try {
      const parsed = new URL(normalizedURL);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch {
      setSaveError('Enter a valid HTTP or HTTPS server address.');
      return;
    }
    if (!name.trim()) {
      setSaveError('Give this environment a recognizable name.');
      return;
    }
    try {
      await updateSavedConnection(connection.id, { name: name.trim(), url: normalizedURL });
      setURL(normalizedURL);
      setSaveError('');
      setExpanded(false);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : 'Could not save this environment.');
    }
  };

  const remove = () => {
    const perform = () => {
      void removeConnection(connection.id).catch((reason: unknown) => {
        setSaveError(reason instanceof Error ? reason.message : 'Could not remove this environment.');
      });
    };
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(`Remove ${connection.name || 'this environment'}?`)) perform();
      return;
    }
    Alert.alert(
      'Remove environment?',
      'Its saved connection will be removed from this device. You can pair it again later.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: perform },
      ],
    );
  };

  const status = health.data?.hermes_ok ? 'online' : health.isError ? 'error' : 'busy';
  const statusLabel = health.data?.hermes_ok
    ? 'Connected'
    : health.isFetching
      ? 'Checking…'
      : 'Unavailable';

  return (
    <View>
      <Pressable
        accessibilityHint="Shows connection details and actions"
        accessibilityRole="button"
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
      >
        <StatusDot status={status} />
        <View style={styles.rowCopy}>
          <View style={styles.nameRow}>
            <AppText numberOfLines={1} style={styles.rowName}>
              {connection.name || 'Hermes'}
            </AppText>
            {active ? (
              <View style={[styles.activeBadge, { backgroundColor: colors.subtleStrong }]}>
                <AppText style={[styles.activeText, { color: colors.secondary }]}>Active</AppText>
              </View>
            ) : null}
          </View>
          <AppText numberOfLines={1} style={[styles.rowURL, { color: colors.muted }]}>
            {connection.url}
          </AppText>
          <AppText
            style={[styles.rowStatus, { color: health.isError ? colors.danger : colors.tertiary }]}
          >
            {statusLabel}
          </AppText>
        </View>
        <SymbolView
          name="chevron.down"
          size={13}
          tintColor={colors.tertiary}
          style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
        />
      </Pressable>

      {expanded ? (
        <View style={[styles.expanded, { borderTopColor: colors.separator }]}>
          {connection.transport === 'direct' ? (
            <>
              <FieldLabel>Name</FieldLabel>
              <AppTextInput
                autoCapitalize="words"
                autoCorrect={false}
                onChangeText={(value) => {
                  setName(value);
                  setSaveError('');
                }}
                value={name}
              />
              <FieldLabel>Server address</FieldLabel>
              <AppTextInput
                autoCapitalize="none"
                autoCorrect={false}
                inputMode="url"
                onChangeText={(value) => {
                  setURL(value);
                  setSaveError('');
                }}
                value={url}
              />
            </>
          ) : (
            <AppText style={[styles.managedNote, { color: colors.muted }]}>
              Managed through Brio Relay. Its tunnel details update automatically.
            </AppText>
          )}

          {saveError ? (
            <AppText style={[styles.saveError, { color: colors.danger }]}>{saveError}</AppText>
          ) : null}

          <View style={styles.actions}>
            {!active ? (
              <Button onPress={() => void choose()} style={styles.actionButton}>
                Use environment
              </Button>
            ) : null}
            {connection.transport === 'direct' ? (
              <Button onPress={() => void save()} style={styles.actionButton} tone="secondary">
                Save details
              </Button>
            ) : null}
            <Button
              loading={health.isFetching}
              onPress={() => void health.refetch()}
              style={styles.iconAction}
              tone="secondary"
            >
              Retry
            </Button>
            <Button onPress={remove} style={styles.iconAction} tone="danger">
              Remove
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function FieldLabel({ children }: { children: string }) {
  const colors = useT3Theme();
  return <AppText style={[styles.fieldLabel, { color: colors.muted }]}>{children}</AppText>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    gap: T3Spacing.xl,
    maxWidth: 720,
    padding: T3Spacing.xl,
    paddingBottom: T3Spacing.huge,
    width: '100%',
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 42 },
  emptyCard: { alignItems: 'center', gap: T3Spacing.md, padding: T3Spacing.xxl },
  emptyIcon: {
    alignItems: 'center',
    borderRadius: T3Radius.medium,
    height: 50,
    justifyContent: 'center',
    width: 50,
  },
  emptyTitle: { fontFamily: T3Typography.bold, fontSize: 17, textAlign: 'center' },
  emptyDetail: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  note: { fontSize: 12, lineHeight: 17, textAlign: 'center' },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: T3Spacing.md,
    minHeight: 80,
    padding: T3Spacing.lg,
  },
  rowCopy: { flex: 1, gap: 2 },
  nameRow: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.sm },
  rowName: { flexShrink: 1, fontFamily: T3Typography.bold, fontSize: 15, lineHeight: 20 },
  rowURL: { fontSize: 12, lineHeight: 17 },
  rowStatus: { fontSize: 11, lineHeight: 15 },
  activeBadge: { borderRadius: T3Radius.pill, paddingHorizontal: T3Spacing.sm, paddingVertical: 2 },
  activeText: { fontFamily: T3Typography.bold, fontSize: 10, lineHeight: 14 },
  expanded: { borderTopWidth: StyleSheet.hairlineWidth, gap: T3Spacing.md, padding: T3Spacing.lg },
  fieldLabel: {
    fontFamily: T3Typography.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  managedNote: { fontSize: 13, lineHeight: 18 },
  saveError: { fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: T3Spacing.sm },
  actionButton: { flexGrow: 1, minWidth: 140 },
  iconAction: { minWidth: 92 },
});
