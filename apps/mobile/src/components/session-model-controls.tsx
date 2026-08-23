import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { getModelPreset, setModelPreset } from '@/lib/model-presets';
import {
  aggregateSessionAnalytics,
  modelCapabilityBadges,
  modelCostLabel,
  modelIncompatibilities,
  modelIsUnavailable,
  modelPricingFor,
  reasoningEffortChoices,
  selectedCapabilities,
  type ReasoningEffortChoice,
} from '@/lib/session-runtime';
import type { HermesModelOptions, HermesSession, ModelOptionProvider } from '@/lib/hermes-api';
import type { ChatModelOverride, ChatThread } from '@/state/chat-thread-model';

export type SessionModelControlsProps = {
  thread: ChatThread;
  options?: HermesModelOptions;
  optionsLoading: boolean;
  optionsError: boolean;
  /** Loaded sessions feed the analytics panel; insertion/backend order is kept. */
  sessions?: HermesSession[];
  onOverrideChange: (override: ChatModelOverride | undefined) => void;
};

type PanelKind = 'closed' | 'models' | 'usage';

const EMPTY_OPTIONS: HermesModelOptions = { model: null, provider: null, providers: [] };

/**
 * Compact bar above the composer distinguishing "Profile default" from
 * "Session override", plus the picker/usage modal it opens.
 */
export function SessionModelControls({
  thread,
  options,
  optionsLoading,
  optionsError,
  sessions,
  onOverrideChange,
}: SessionModelControlsProps) {
  const colors = useTheme();
  const [panel, setPanel] = useState<PanelKind>('closed');

  const override = thread.modelOverride;
  const loadingSummary = optionsLoading && !options;
  const errorSummary = optionsError && !options;

  let summaryLabel: string;
  if (override) {
    summaryLabel = `Session override · ${override.provider}/${override.model}`;
  } else if (loadingSummary) {
    summaryLabel = 'Loading models…';
  } else if (errorSummary) {
    summaryLabel = 'Model options unavailable';
  } else if (options?.provider && options?.model) {
    summaryLabel = `Profile default · ${options.provider}/${options.model}`;
  } else {
    summaryLabel = 'Profile default · unknown';
  }

  return (
    <>
      <Pressable
        accessibilityLabel={
          override ? 'Session model picker: session override active' : 'Session model picker: profile default active'
        }
        accessibilityRole="button"
        onPress={() => setPanel('models')}
        style={({ pressed }) => [
          styles.bar,
          {
            backgroundColor: colors.panel,
            borderColor: override ? colors.accent : colors.border,
            opacity: pressed ? 0.72 : 1,
          },
        ]}>
        <View
          style={[
            styles.barDot,
            { backgroundColor: override ? colors.warning : colors.success },
          ]}
        />
        <ThemedText numberOfLines={1} style={styles.barLabel} themeColor="textSecondary" type="small">
          {summaryLabel}
        </ThemedText>
        <ThemedText themeColor="textTertiary" type="small">▾</ThemedText>
      </Pressable>

      <Modal
        animationType="slide"
        onRequestClose={() => setPanel('closed')}
        transparent={false}
        visible={panel !== 'closed'}>
        <View style={[styles.modalRoot, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderColor: colors.border }]}>
            <ThemedText type="smallBold">Model &amp; session</ThemedText>
            <Pressable
              accessibilityLabel="Close model picker"
              accessibilityRole="button"
              onPress={() => setPanel('closed')}>
              <ThemedText themeColor="textSecondary" type="smallBold">Done</ThemedText>
            </Pressable>
          </View>
          <View style={styles.panelSwitch}>
            <PanelTab
              active={panel === 'models'}
              label="Model"
              onPress={() => setPanel('models')}
            />
            <PanelTab
              active={panel === 'usage'}
              label="Usage"
              onPress={() => setPanel('usage')}
            />
          </View>
          {panel === 'usage' ? (
            <UsagePanel sessions={sessions} thread={thread} />
          ) : (
            <ModelPickerPanel
              onOverrideChange={onOverrideChange}
              options={options}
              optionsError={optionsError}
              optionsLoading={optionsLoading}
              override={override}
              thread={thread}
            />
          )}
        </View>
      </Modal>
    </>
  );
}

function PanelTab({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const colors = useTheme();
  return (
    <Pressable
      accessibilityLabel={`${label} panel`}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[
        styles.panelTab,
        active
          ? { backgroundColor: colors.backgroundSelected, borderColor: colors.border }
          : { borderColor: 'transparent' },
      ]}>
      <ThemedText type={active ? 'smallBold' : 'small'}>{label}</ThemedText>
    </Pressable>
  );
}

function ModelPickerPanel({
  onOverrideChange,
  options,
  optionsError,
  optionsLoading,
  override,
  thread,
}: {
  onOverrideChange: SessionModelControlsProps['onOverrideChange'];
  options?: HermesModelOptions;
  optionsError: boolean;
  optionsLoading: boolean;
  override?: ChatModelOverride;
  thread: ChatThread;
}) {
  const colors = useTheme();
  const [search, setSearch] = useState('');
  // A pending change awaits explicit confirmation when switching models — or
  // clearing the override back to the profile default — on a thread that
  // already has traffic (prompt cache may be invalidated).
  const [pending, setPending] = useState<
    | { type: 'model'; provider: ModelOptionProvider; model: string }
    | { type: 'profile-default' }
    | null
  >(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [draftFast, setDraftFast] = useState<boolean | null>(null);

  const safeOptions = options ?? EMPTY_OPTIONS;
  const effectiveProvider = override?.provider ?? safeOptions.provider ?? null;
  const effectiveModel = override?.model ?? safeOptions.model ?? null;
  const effectiveCaps = useMemo(
    () => selectedCapabilities(safeOptions, effectiveProvider, effectiveModel),
    [safeOptions, effectiveProvider, effectiveModel],
  );

  // Search filters dynamically but never reorders: providers stay in backend
  // order and models stay in each provider's backend order.
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return safeOptions.providers.map((provider) => ({ provider, models: provider.models ?? [] }));
    }
    return safeOptions.providers
      .map((provider) => ({
        provider,
        matchesProvider:
          provider.name.toLowerCase().includes(query) || provider.slug.toLowerCase().includes(query),
        models: (provider.models ?? []).filter((model) => model.toLowerCase().includes(query)),
      }))
      .map(({ provider, matchesProvider, models }) => ({
        provider,
        models: matchesProvider ? (provider.models ?? []) : models,
      }))
      .filter((group) => group.models.length > 0);
  }, [safeOptions.providers, search]);

  const applySelection = useCallback(
    async (provider: ModelOptionProvider, model: string) => {
      setPending(null);
      const caps = selectedCapabilities(safeOptions, provider.slug, model);
      const choices = reasoningEffortChoices(caps);
      const preset = await getModelPreset(provider.slug, model).catch(() => undefined);
      const effort =
        preset?.effort && choices.includes(preset.effort as ReasoningEffortChoice)
          ? preset.effort
          : undefined;
      const fast =
        caps?.fast === true && typeof preset?.fast === 'boolean' ? preset.fast : undefined;
      setDraftEffort(effort ?? null);
      setDraftFast(fast ?? null);
      onOverrideChange({
        provider: provider.slug,
        model,
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(fast !== undefined ? { fast } : {}),
      });
    },
    [onOverrideChange, safeOptions],
  );

  function chooseModel(provider: ModelOptionProvider, model: string) {
    if (modelIsUnavailable(provider, model)) return;
    const changed = provider.slug !== effectiveProvider || model !== effectiveModel;
    const hasTraffic = thread.messages.length > 0 || Boolean(thread.lastResponseId);
    if (changed && hasTraffic) {
      setPending({ type: 'model', provider, model });
      return;
    }
    void applySelection(provider, model);
  }

  // Only a provider/model change needs the cache warning; reasoning/fast-only
  // differences on the same model apply immediately.
  function requestProfileDefault() {
    const changed =
      Boolean(override) &&
      (override?.provider !== (safeOptions.provider ?? null) ||
        override?.model !== (safeOptions.model ?? null));
    const hasTraffic = thread.messages.length > 0 || Boolean(thread.lastResponseId);
    if (changed && hasTraffic) {
      setPending({ type: 'profile-default' });
      return;
    }
    clearOverride();
  }

  function clearOverride() {
    setPending(null);
    setDraftEffort(null);
    setDraftFast(null);
    onOverrideChange(undefined);
  }

  async function updateOverride(patch: { reasoningEffort?: string; fast?: boolean }) {
    if (!effectiveProvider || !effectiveModel) return;
    // Fall back through the draft and then the existing override so changing
    // one setting never drops the other persisted one (false and "none" kept).
    const nextEffort =
      patch.reasoningEffort ?? draftEffort ?? override?.reasoningEffort ?? undefined;
    const nextFast = patch.fast ?? draftFast ?? override?.fast ?? undefined;
    onOverrideChange({
      provider: effectiveProvider,
      model: effectiveModel,
      ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
      ...(nextFast !== undefined ? { fast: nextFast } : {}),
    });
    await setModelPreset(effectiveProvider, effectiveModel, patch).catch(() => undefined);
  }

  const effortChoices = reasoningEffortChoices(effectiveCaps);

  return (
    <ScrollView contentContainerStyle={styles.pickerContent} keyboardShouldPersistTaps="handled">
      {optionsLoading && !options ? (
        <View style={styles.stateRow}>
          <ActivityIndicator size="small" />
          <ThemedText themeColor="textSecondary" type="small">Loading model options…</ThemedText>
        </View>
      ) : null}
      {optionsError && !options ? (
        <View style={styles.stateRow}>
          <ThemedText style={{ color: colors.danger }} type="small">
            Model options are unavailable right now.
          </ThemedText>
        </View>
      ) : null}

      <View
        style={[styles.searchBox, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
        <ThemedText themeColor="textTertiary">⌕</ThemedText>
        <TextInput
          accessibilityLabel="Search models"
          onChangeText={setSearch}
          placeholder="Search providers or models"
          placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.text }]}
          value={search}
        />
      </View>

      <Pressable
        accessibilityLabel="Use profile default"
        accessibilityRole="button"
        onPress={requestProfileDefault}
        style={({ pressed }) => [
          styles.defaultAction,
          {
            backgroundColor: override ? colors.backgroundElement : colors.backgroundSelected,
            borderColor: colors.border,
            opacity: pressed ? 0.72 : 1,
          },
        ]}>
        <ThemedText type={override ? 'small' : 'smallBold'}>
          {options?.provider && options?.model
            ? `Use profile default · ${options.provider}/${options.model}`
            : 'Use profile default'}
        </ThemedText>
        {!override ? <ThemedText style={{ color: colors.success }} type="small">✓</ThemedText> : null}
      </Pressable>

      {groups.map(({ provider, models }) => {
        const providerCaps = selectedCapabilities(safeOptions, provider.slug, null);
        return (
          <View key={provider.slug}>
            <View style={styles.groupHeader}>
              <ThemedText themeColor="textTertiary" type="eyebrow">{provider.name}</ThemedText>
              {provider.authenticated === false ? (
                <Badge color={colors.warning} label="Not authenticated" />
              ) : null}
              {provider.free_tier === true ? <Badge color={colors.success} label="Free tier" /> : null}
              {typeof provider.warning === 'string' && provider.warning.trim() ? (
                <Badge color={colors.warning} label={provider.warning.trim()} />
              ) : null}
              {provider.is_user_defined === true ? (
                <Badge color={colors.textTertiary} label="Custom" />
              ) : null}
              {!providerCaps ? <Badge color={colors.textTertiary} label="capabilities unknown" /> : null}
            </View>
            {models.map((model) => {
              const unavailable = modelIsUnavailable(provider, model);
              const selected = provider.slug === effectiveProvider && model === effectiveModel;
              const caps = selectedCapabilities(safeOptions, provider.slug, model);
              const pricing = modelPricingFor(provider, model);
              const cost = modelCostLabel(pricing);
              const badges = modelCapabilityBadges(caps);
              return (
                <Pressable
                  key={model}
                  accessibilityLabel={`Select model ${provider.name} ${model}${unavailable ? ', unavailable' : ''}`}
                  accessibilityRole="button"
                  disabled={unavailable}
                  onPress={() => chooseModel(provider, model)}
                  style={({ pressed }) => [
                    styles.modelRow,
                    {
                      backgroundColor: selected ? colors.backgroundSelected : 'transparent',
                      borderColor: selected ? colors.border : 'transparent',
                      opacity: unavailable ? 0.4 : pressed ? 0.72 : 1,
                    },
                  ]}>
                  <View style={styles.modelCopy}>
                    <View style={styles.modelTitleRow}>
                      <ThemedText numberOfLines={1} type="smallBold">{model}</ThemedText>
                      {selected ? (
                        <ThemedText style={{ color: colors.success }} type="small">✓</ThemedText>
                      ) : null}
                    </View>
                    <ThemedText themeColor="textTertiary" type="small">
                      {cost ?? 'Cost unavailable'}
                    </ThemedText>
                    <View style={styles.badgeRow}>
                      {badges.length ? (
                        badges.map((badge) => (
                          <Badge key={badge} color={colors.textTertiary} label={badge} />
                        ))
                      ) : (
                        <Badge color={colors.textDisabled} label="capabilities unknown" />
                      )}
                      {unavailable ? <Badge color={colors.danger} label="Unavailable" /> : null}
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        );
      })}
      {!optionsLoading && groups.length === 0 ? (
        <ThemedText style={styles.emptyModels} themeColor="textTertiary" type="small">
          No models match “{search.trim()}”.
        </ThemedText>
      ) : null}

      {effortChoices.length ? (
        <View style={[styles.settingBlock, { borderColor: colors.border }]}>
          <ThemedText type="smallBold">Reasoning effort</ThemedText>
          <View style={styles.choiceRow}>
            {effortChoices.map((choice) => {
              const active = (draftEffort ?? override?.reasoningEffort) === choice;
              return (
                <Pressable
                  key={choice}
                  accessibilityLabel={`Reasoning effort ${choice}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    setDraftEffort(choice);
                    void updateOverride({ reasoningEffort: choice });
                  }}
                  style={[
                    styles.choice,
                    {
                      backgroundColor: active ? colors.accent : colors.backgroundElement,
                      borderColor: colors.border,
                    },
                  ]}>
                  <ThemedText
                    style={{ color: active ? colors.accentText : colors.text }}
                    type="small">
                    {choice}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {effectiveCaps?.fast === true ? (
        <View style={[styles.settingBlock, { borderColor: colors.border }]}>
          <ThemedText type="smallBold">Fast mode</ThemedText>
          <Switch
            accessibilityLabel="Fast mode toggle"
            onValueChange={(value) => {
              setDraftFast(value);
              void updateOverride({ fast: value });
            }}
            value={draftFast ?? override?.fast ?? false}
          />
        </View>
      ) : null}

      {pending ? (
        <View style={[styles.confirmCard, { backgroundColor: colors.panelStrong, borderColor: colors.warning }]}>
          <ThemedText type="smallBold">Change model mid-conversation?</ThemedText>
          <ThemedText themeColor="textSecondary" type="small">
            {pending.type === 'model'
              ? `Switching to ${pending.provider.name}/${pending.model} may invalidate this conversation's prompt cache, making follow-up requests slower or more expensive.`
              : `Clearing the session override${
                  safeOptions.provider && safeOptions.model
                    ? ` back to ${safeOptions.provider}/${safeOptions.model}`
                    : ''
                } may invalidate this conversation's prompt cache, making follow-up requests slower or more expensive.`}
          </ThemedText>
          <View style={styles.confirmActions}>
            <Pressable
              accessibilityLabel="Cancel model change"
              accessibilityRole="button"
              onPress={() => setPending(null)}>
              <ThemedText themeColor="textSecondary" type="smallBold">Cancel</ThemedText>
            </Pressable>
            <Pressable
              accessibilityLabel="Apply model change anyway"
              accessibilityRole="button"
              onPress={() => {
                if (pending.type === 'model') void applySelection(pending.provider, pending.model);
                else clearOverride();
              }}>
              <ThemedText style={{ color: colors.warning }} type="smallBold">
                Apply anyway
              </ThemedText>
            </Pressable>
          </View>
        </View>
      ) : null}

      {override ? (
        (() => {
          const blockers = modelIncompatibilities(
            selectedCapabilities(safeOptions, override.provider, override.model),
            { vision: false, tools: true },
          );
          if (!blockers.length) return null;
          return (
            <View style={[styles.incompatibleCard, { backgroundColor: colors.panelStrong, borderColor: colors.danger }]}>
              <ThemedText style={{ color: colors.danger }} type="small">
                This model does not support: {blockers.join(', ')}. Brio agent turns require tool
                calling, so sending is disabled while it is selected.
              </ThemedText>
            </View>
          );
        })()
      ) : null}
    </ScrollView>
  );
}

function UsagePanel({
  sessions,
  thread,
}: {
  sessions?: HermesSession[];
  thread: ChatThread;
}) {
  const colors = useTheme();
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('7d');
  // Stable reference time captured once so period math stays pure in render.
  const [analyticsNow] = useState(() => Date.now());

  const usage = thread.usage;
  const breakdown = thread.contextBreakdown;

  const contextUsed = breakdown?.contextUsed ?? usage?.contextUsed;
  const contextMax = breakdown?.contextMax ?? usage?.contextMax;
  const contextPercent =
    breakdown?.contextPercent ??
    usage?.contextPercent ??
    (contextUsed !== undefined && contextMax ? (contextUsed / contextMax) * 100 : undefined);
  const contextKnown =
    contextUsed !== undefined || contextMax !== undefined || contextPercent !== undefined;

  const actualCost = usage?.actualCostUsd;
  const estimatedCost = usage?.estimatedCostUsd;

  const since = analyticsWindowStart(period, analyticsNow);
  const analytics = useMemo(
    () => aggregateSessionAnalytics(sessions ?? [], { since }),
    [sessions, since],
  );
  const costLabel =
    analytics.costKnown === 0
      ? 'Cost unavailable'
      : `$${analytics.costUsd.toFixed(4)}${
          analytics.costKnown < analytics.sessions
            ? ` (partial · ${analytics.costKnown}/${analytics.sessions} sessions)`
            : ''
        }`;

  return (
    <ScrollView contentContainerStyle={styles.usageContent}>
      <ThemedText themeColor="textTertiary" type="eyebrow">Current session</ThemedText>
      <View style={[styles.usageCard, { borderColor: colors.border }]}>
        <UsageRow label="Input tokens" value={usage?.inputTokens} />
        <UsageRow label="Output tokens" value={usage?.outputTokens} />
        <UsageRow label="Total tokens" value={usage?.totalTokens} />
        <UsageRow label="Reasoning tokens" value={usage?.reasoningTokens} />
        <UsageRow label="Cache read" value={usage?.cacheReadTokens} />
        <UsageRow label="Cache write" value={usage?.cacheWriteTokens} />
        <UsageRow label="API calls" value={usage?.apiCalls} />
        <UsageRow label="Duration" text={usage?.durationSeconds !== undefined ? formatDuration(usage.durationSeconds) : undefined} />
        <UsageRow
          label="Cost"
          text={
            actualCost !== undefined
              ? `$${actualCost.toFixed(4)} (actual)`
              : estimatedCost !== undefined
                ? `$${estimatedCost.toFixed(4)} (estimated)`
                : undefined
          }
        />
      </View>

      <ThemedText themeColor="textTertiary" type="eyebrow">Context</ThemedText>
      <View style={[styles.usageCard, { borderColor: colors.border }]}>
        {contextKnown ? (
          <>
            <View style={[styles.contextMeterTrack, { backgroundColor: colors.backgroundElement }]}>
              <View
                style={[
                  styles.contextMeterFill,
                  {
                    backgroundColor: colors.accent,
                    width: `${Math.min(100, Math.max(0, contextPercent ?? 0))}%`,
                  },
                ]}
              />
            </View>
            <ThemedText themeColor="textSecondary" type="small">
              {[
                contextUsed !== undefined ? `${formatNumber(contextUsed)} used` : null,
                contextMax !== undefined ? `${formatNumber(contextMax)} max` : null,
                contextPercent !== undefined ? `${contextPercent.toFixed(1)}%` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Context'}
            </ThemedText>
            {(breakdown?.categories ?? []).map((category) => (
              <View key={category.id || category.label} style={styles.breakdownRow}>
                <View style={[styles.breakdownDot, { backgroundColor: category.color || colors.accent }]} />
                <ThemedText numberOfLines={1} themeColor="textSecondary" type="small">
                  {category.label}
                </ThemedText>
                <ThemedText themeColor="textTertiary" type="small">
                  {category.tokens !== undefined ? formatNumber(category.tokens) : '—'}
                </ThemedText>
              </View>
            ))}
          </>
        ) : (
          <ThemedText themeColor="textTertiary" type="small">Context unavailable</ThemedText>
        )}
      </View>

      <ThemedText themeColor="textTertiary" type="eyebrow">Analytics</ThemedText>
      <View style={styles.periodRow}>
        {(['7d', '30d', 'all'] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityLabel={`Analytics period: ${
              value === '7d' ? '7 days' : value === '30d' ? '30 days' : 'loaded history'
            }`}
            accessibilityRole="button"
            accessibilityState={{ selected: period === value }}
            onPress={() => setPeriod(value)}
            style={[
              styles.periodButton,
              {
                backgroundColor: period === value ? colors.accent : colors.backgroundElement,
                borderColor: colors.border,
              },
            ]}>
            <ThemedText
              style={{ color: period === value ? colors.accentText : colors.text }}
              type="small">
              {value === '7d' ? '7 days' : value === '30d' ? '30 days' : 'History'}
            </ThemedText>
          </Pressable>
        ))}
      </View>
      <View style={[styles.usageCard, { borderColor: colors.border }]}>
        <UsageRow label="Sessions" value={analytics.sessions} />
        <UsageRow label="Input tokens" value={analytics.inputTokens} />
        <UsageRow label="Output tokens" value={analytics.outputTokens} />
        <UsageRow label="Cache read" value={analytics.cacheReadTokens} />
        <UsageRow label="Cache write" value={analytics.cacheWriteTokens} />
        <UsageRow label="Reasoning tokens" value={analytics.reasoningTokens} />
        <UsageRow label="API calls" value={analytics.apiCalls} />
        <UsageRow label="Duration" text={formatDuration(analytics.durationSeconds)} />
        <UsageRow label="Cost" text={costLabel} />
      </View>
      {Object.keys(analytics.byModel).length ? (
        <View style={[styles.usageCard, { borderColor: colors.border }]}>
          <ThemedText type="smallBold">By model</ThemedText>
          {/* Insertion order mirrors the backend data order. */}
          {Object.entries(analytics.byModel).map(([model, bucket]) => (
            <View key={model} style={styles.byModelRow}>
              <ThemedText numberOfLines={1} style={styles.byModelName} themeColor="textSecondary" type="small">
                {model}
              </ThemedText>
              <ThemedText themeColor="textTertiary" type="small">
                {bucket.sessions} · {formatNumber(bucket.inputTokens + bucket.outputTokens)} tok ·{' '}
                {bucket.costKnown === 0
                  ? 'cost unavailable'
                  : `$${bucket.costUsd.toFixed(4)}${
                      bucket.costKnown < bucket.sessions ? ' (partial)' : ''
                    }`}
              </ThemedText>
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function UsageRow({ label, text, value }: { label: string; text?: string; value?: number }) {
  const colors = useTheme();
  const display = text ?? (value !== undefined ? formatNumber(value) : undefined);
  return (
    <View style={styles.usageRow}>
      <ThemedText themeColor="textSecondary" type="small">{label}</ThemedText>
      <ThemedText
        style={{ color: display === undefined ? colors.textTertiary : colors.text }}
        type="small">
        {display ?? 'Unavailable'}
      </ThemedText>
    </View>
  );
}

function Badge({ color, label }: { color: string; label: string }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <ThemedText style={{ color, fontSize: 10, lineHeight: 14 }} numberOfLines={1}>
        {label}
      </ThemedText>
    </View>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function analyticsWindowStart(period: '7d' | '30d' | 'all', nowMs: number) {
  if (period === '7d') return nowMs - 7 * 86_400_000;
  if (period === '30d') return nowMs - 30 * 86_400_000;
  return undefined;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    marginBottom: Spacing.two,
    minHeight: 36,
    paddingHorizontal: Spacing.three,
  },
  barDot: { borderRadius: 4, height: 7, width: 7 },
  barLabel: { flex: 1 },
  modalRoot: { flex: 1 },
  modalHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: Spacing.four,
  },
  panelSwitch: { flexDirection: 'row', gap: Spacing.two, paddingHorizontal: Spacing.four, paddingVertical: Spacing.two },
  panelTab: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 36,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
  pickerContent: { paddingBottom: Spacing.five, paddingHorizontal: Spacing.four, paddingTop: Spacing.two },
  usageContent: { gap: Spacing.two, paddingBottom: Spacing.five, paddingHorizontal: Spacing.four, paddingTop: Spacing.two },
  stateRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two, paddingVertical: Spacing.two },
  searchBox: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    marginBottom: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  searchInput: { flex: 1, fontSize: 14, minHeight: 40, outlineStyle: 'none' } as never,
  defaultAction: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'space-between',
    marginBottom: Spacing.three,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
  },
  groupHeader: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, marginTop: Spacing.two, paddingHorizontal: Spacing.one },
  modelRow: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: Spacing.one,
    minHeight: 56,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  modelCopy: { gap: 2 },
  modelTitleRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two, justifyContent: 'space-between' },
  badgeRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, marginTop: 2 },
  badge: {
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  emptyModels: { paddingVertical: Spacing.three, textAlign: 'center' },
  settingBlock: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    marginTop: Spacing.three,
    padding: Spacing.three,
  },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  choice: {
    alignItems: 'center',
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
  },
  confirmCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    marginTop: Spacing.three,
    padding: Spacing.three,
  },
  confirmActions: { alignItems: 'center', flexDirection: 'row', gap: Spacing.four, justifyContent: 'flex-end' },
  incompatibleCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: Spacing.three,
    padding: Spacing.three,
  },
  usageCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  usageRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 26 },
  contextMeterTrack: { borderRadius: 5, height: 10, overflow: 'hidden' },
  contextMeterFill: { height: '100%', borderRadius: 5 },
  breakdownRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two, justifyContent: 'space-between' },
  breakdownDot: { borderRadius: 3, height: 6, width: 6 },
  periodRow: { flexDirection: 'row', gap: Spacing.two },
  periodButton: {
    alignItems: 'center',
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minHeight: 34,
    justifyContent: 'center',
  },
  byModelRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two, justifyContent: 'space-between', minHeight: 26 },
  byModelName: { flex: 1 },
});
