import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
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
  onOpenChange?: (open: boolean) => void;
  /** T3-style composer control: only the effective model name in a small pill. */
  variant?: 'bar' | 'inline';
  /** New-thread pickers do not have session usage to display yet. */
  showUsage?: boolean;
};

type PanelKind = 'closed' | 'models' | 'usage';
type ProviderFilter = 'favorites' | string;

const EMPTY_OPTIONS: HermesModelOptions = { model: null, provider: null, providers: [] };
const FAVORITE_MODELS_KEY = 'brio:favorite-models:v1';
const favoriteModelKey = (provider: string, model: string) => `${provider}/${model}`;

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
  onOpenChange,
  variant = 'bar',
  showUsage = true,
}: SessionModelControlsProps) {
  const colors = useTheme();
  const [panel, setPanel] = useState<PanelKind>('closed');
  const [draftOverride, setDraftOverride] = useState<ChatModelOverride | undefined>(
    thread.modelOverride,
  );
  const [draftDirty, setDraftDirty] = useState(false);
  const [pickerSession, setPickerSession] = useState(0);
  const draftOverrideRef = useRef<ChatModelOverride | undefined>(thread.modelOverride);
  const draftDirtyRef = useRef(false);

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
  const inlineLabel =
    override?.model ??
    options?.model ??
    (loadingSummary ? 'Loading models…' : errorSummary ? 'Models unavailable' : 'Choose model');
  const openModels = () => {
    draftOverrideRef.current = override;
    draftDirtyRef.current = false;
    setDraftOverride(override);
    setDraftDirty(false);
    setPickerSession((current) => current + 1);
    setPanel('models');
    onOpenChange?.(true);
  };
  const dismissPanel = () => {
    setPanel('closed');
    onOpenChange?.(false);
  };
  const commitAndClose = () => {
    if (draftDirtyRef.current) onOverrideChange(draftOverrideRef.current);
    dismissPanel();
  };
  const stageOverride = (nextOverride: ChatModelOverride | undefined) => {
    draftOverrideRef.current = nextOverride;
    draftDirtyRef.current = true;
    setDraftOverride(nextOverride);
    setDraftDirty(true);
  };

  return (
    <>
      <Pressable
        accessibilityLabel={
          override ? 'Session model picker: session override active' : 'Session model picker: profile default active'
        }
        accessibilityRole="button"
        onPress={openModels}
        style={({ pressed }) => [
          variant === 'inline' ? styles.inline : styles.bar,
          {
            backgroundColor:
              variant === 'inline' ? colors.backgroundSelected : colors.panel,
            borderColor: override ? colors.accent : colors.border,
            opacity: pressed ? 0.72 : 1,
          },
        ]}>
        {variant === 'bar' ? (
          <View
            style={[
              styles.barDot,
              { backgroundColor: override ? colors.warning : colors.success },
            ]}
          />
        ) : (
          <View style={[styles.inlineMark, { backgroundColor: override ? colors.warning : colors.accent }]} />
        )}
        <ThemedText
          numberOfLines={1}
          style={variant === 'inline' ? styles.inlineLabel : styles.barLabel}
          themeColor="textSecondary"
          type="smallBold">
          {variant === 'inline' ? inlineLabel : summaryLabel}
        </ThemedText>
        <ThemedText style={styles.inlineDisclosure} themeColor="textTertiary" type="small">⌄</ThemedText>
      </Pressable>

      <Modal
        animationType="fade"
        onRequestClose={dismissPanel}
        statusBarTranslucent
        transparent
        visible={panel !== 'closed'}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalRoot}>
          <Pressable accessibilityLabel="Close model picker" onPress={dismissPanel} style={styles.modalBackdrop}>
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={[styles.modalSheet, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
              <View style={styles.modalHeader}>
                <View style={styles.headerCopy}>
                  <ThemedText style={styles.headerTitle} type="subtitle">
                    {panel === 'usage' ? 'Usage' : 'Choose a model'}
                  </ThemedText>
                  <ThemedText numberOfLines={1} themeColor="textTertiary" type="small">
                    {draftOverride ? `${draftOverride.provider} · Session override` : 'Using profile default'}
                  </ThemedText>
                </View>
                <Pressable
                  accessibilityLabel={draftDirty ? 'Save thread settings' : 'Done'}
                  accessibilityRole="button"
                  onPress={commitAndClose}
                  style={[styles.doneButton, { backgroundColor: colors.accent }]}>
                  <ThemedText style={{ color: colors.accentText }} type="smallBold">Done</ThemedText>
                </Pressable>
              </View>
              {showUsage ? (
                <View style={[styles.panelSwitch, { backgroundColor: colors.backgroundElement }]}>
                  <PanelTab
                    active={panel === 'models'}
                    label="Models"
                    onPress={() => setPanel('models')}
                  />
                  <PanelTab
                    active={panel === 'usage'}
                    label="Usage"
                    onPress={() => setPanel('usage')}
                  />
                </View>
              ) : null}
              {showUsage && panel === 'usage' ? (
                <UsagePanel sessions={sessions} thread={thread} />
              ) : (
                <ModelPickerPanel
                  key={pickerSession}
                  onOverrideChange={stageOverride}
                  options={options}
                  optionsError={optionsError}
                  optionsLoading={optionsLoading}
                  override={draftOverride}
                  thread={thread}
                />
              )}
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
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

function ProviderChip({
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
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.providerChip,
        {
          backgroundColor: active ? colors.accent : colors.backgroundElement,
          borderColor: active ? colors.accent : colors.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <ThemedText
        numberOfLines={1}
        style={active ? { color: colors.accentText } : undefined}
        themeColor={active ? undefined : 'textSecondary'}
        type="smallBold">
        {label}
      </ThemedText>
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
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('');
  const [favoriteModels, setFavoriteModels] = useState<Set<string>>(new Set());
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
  const [reasoningExpanded, setReasoningExpanded] = useState(false);

  const safeOptions = options ?? EMPTY_OPTIONS;
  const effectiveProvider = override?.provider ?? safeOptions.provider ?? null;
  const effectiveModel = override?.model ?? safeOptions.model ?? null;
  const effectiveCaps = useMemo(
    () => selectedCapabilities(safeOptions, effectiveProvider, effectiveModel),
    [safeOptions, effectiveProvider, effectiveModel],
  );

  const appliedProvider = thread.modelOverride?.provider ?? safeOptions.provider ?? null;

  useEffect(() => {
    void AsyncStorage.getItem(FAVORITE_MODELS_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setFavoriteModels(new Set(parsed.filter((value): value is string => typeof value === 'string')));
        }
      })
      .catch(() => undefined);
  }, []);

  const activeProviderFilter = providerFilter || (
    safeOptions.providers.some((provider) => provider.slug === appliedProvider)
      ? (appliedProvider ?? safeOptions.providers[0]?.slug ?? '')
      : (safeOptions.providers[0]?.slug ?? '')
  );

  const toggleFavorite = (provider: string, model: string) => {
    const key = favoriteModelKey(provider, model);
    setFavoriteModels((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      void AsyncStorage.setItem(FAVORITE_MODELS_KEY, JSON.stringify([...next])).catch(() => undefined);
      return next;
    });
  };

  // Searching scans every provider. Without a query, the provider rail keeps
  // the catalog focused so opening the picker never produces a wall of models.
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return safeOptions.providers
      .map((provider) => ({
        provider,
        models: (provider.models ?? []).filter((model) => {
          if (query) {
            return `${provider.name} ${provider.slug} ${model}`.toLowerCase().includes(query);
          }
          if (activeProviderFilter === 'favorites') {
            return favoriteModels.has(favoriteModelKey(provider.slug, model));
          }
          return provider.slug === activeProviderFilter;
        }),
      }))
      .filter((group) => group.models.length > 0);
  }, [activeProviderFilter, favoriteModels, safeOptions.providers, search]);

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
    if (provider.slug === safeOptions.provider && model === safeOptions.model) {
      requestProfileDefault();
      return;
    }
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
    <ScrollView
      contentContainerStyle={styles.pickerContent}
      keyboardShouldPersistTaps="handled"
      style={styles.panelBody}>
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

      <View style={[styles.searchBox, { backgroundColor: colors.panel, borderColor: colors.border }]}> 
        <ThemedText style={styles.searchIcon} themeColor="textTertiary">⌕</ThemedText>
        <TextInput
          accessibilityLabel="Find a model"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setSearch}
          placeholder="Search models"
          placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.text }]}
          value={search}
        />
        {search ? (
          <Pressable accessibilityLabel="Clear model search" hitSlop={10} onPress={() => setSearch('')}>
            <ThemedText themeColor="textTertiary">×</ThemedText>
          </Pressable>
        ) : null}
      </View>

      {!search.trim() && safeOptions.providers.length > 0 ? (
        <ScrollView
          contentContainerStyle={styles.providerRail}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}>
          <ProviderChip
            active={activeProviderFilter === 'favorites'}
            label="★ Favorites"
            onPress={() => setProviderFilter('favorites')}
          />
          {safeOptions.providers.map((provider) => (
            <ProviderChip
              active={activeProviderFilter === provider.slug}
              key={provider.slug}
              label={provider.name}
              onPress={() => setProviderFilter(provider.slug)}
            />
          ))}
        </ScrollView>
      ) : null}

      {groups.map(({ provider, models }) => {
        return (
          <View key={provider.slug} style={styles.providerSection}>
            <View style={styles.groupHeader}>
              <View style={[styles.providerMark, { backgroundColor: colors.backgroundSelected }]}> 
                <ThemedText
                  style={styles.providerMarkText}
                  themeColor="textSecondary"
                  type="smallBold">
                  {(provider.name.trim()[0] ?? provider.slug.trim()[0] ?? '•').toUpperCase()}
                </ThemedText>
              </View>
              <ThemedText
                numberOfLines={1}
                style={styles.providerName}
                themeColor="textSecondary"
                type="smallBold">
                {provider.name}
              </ThemedText>
              <ThemedText themeColor="textTertiary" type="small">
                {models.length} {models.length === 1 ? 'model' : 'models'}
              </ThemedText>
            </View>
            {models.map((model, index) => {
              const unavailable = modelIsUnavailable(provider, model);
              const selected = provider.slug === effectiveProvider && model === effectiveModel;
              const isDefault =
                provider.slug === safeOptions.provider && model === safeOptions.model;
              const favorite = favoriteModels.has(favoriteModelKey(provider.slug, model));
              const metadata = [
                selected ? 'Selected' : null,
                provider.backend_provider?.trim() || null,
                ...modelCapabilityBadges(selectedCapabilities(safeOptions, provider.slug, model)),
                modelCostLabel(modelPricingFor(provider, model)),
              ].filter((value): value is string => Boolean(value));
              const first = index === 0;
              const last = index === models.length - 1;
              return (
                <Pressable
                  key={model}
                  accessibilityLabel={`Select model ${provider.name} ${model}${unavailable ? ', unavailable' : ''}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: unavailable }}
                  disabled={unavailable}
                  onPress={() => chooseModel(provider, model)}
                  style={({ pressed }) => [
                    styles.modelRow,
                    first ? styles.modelRowFirst : null,
                    last ? styles.modelRowLast : styles.modelRowDivider,
                    {
                      backgroundColor: selected ? colors.backgroundSelected : colors.panel,
                      borderColor: selected ? colors.accent : colors.border,
                      opacity: unavailable ? 0.4 : pressed ? 0.72 : 1,
                    },
                  ]}>
                  {selected ? <View style={[styles.selectionBar, { backgroundColor: colors.accent }]} /> : null}
                  <View style={styles.modelCopy}>
                    <View style={styles.modelTitleRow}>
                      <ThemedText numberOfLines={1} style={styles.modelName} type="default">
                        {model}
                      </ThemedText>
                      {isDefault ? <Badge color={colors.textTertiary} label="Default" /> : null}
                      {unavailable ? <Badge color={colors.textDisabled} label="Unavailable" /> : null}
                    </View>
                    <ThemedText numberOfLines={1} themeColor="textTertiary" type="small">
                      {metadata.length ? metadata.join(' · ') : provider.name}
                    </ThemedText>
                  </View>
                  <Pressable
                    accessibilityLabel={`${favorite ? 'Remove' : 'Add'} ${model} ${favorite ? 'from' : 'to'} favorites`}
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={(event) => {
                      event.stopPropagation();
                      toggleFavorite(provider.slug, model);
                    }}
                    style={styles.favoriteButton}>
                    <ThemedText style={styles.favoriteIcon} themeColor={favorite ? 'text' : 'textTertiary'}>
                      {favorite ? '★' : '☆'}
                    </ThemedText>
                  </Pressable>
                </Pressable>
              );
            })}
          </View>
        );
      })}
      {!optionsLoading && groups.length === 0 ? (
        <View style={styles.emptyModels}>
          <ThemedText style={styles.emptyTitle} type="smallBold">
            {activeProviderFilter === 'favorites' && !search.trim() ? 'No favorites yet' : 'No matching models'}
          </ThemedText>
          <ThemedText style={styles.emptyDetail} themeColor="textTertiary" type="small">
            {activeProviderFilter === 'favorites' && !search.trim()
              ? 'Tap the star beside any model to keep it close.'
              : 'Try a model name or another provider.'}
          </ThemedText>
        </View>
      ) : null}

      {effortChoices.length || effectiveCaps?.fast === true ? (
        <View style={styles.optionsSection}>
          <ThemedText style={styles.sectionLabel} themeColor="textSecondary" type="smallBold">
            Options
          </ThemedText>
          <View style={[styles.optionsCard, { backgroundColor: colors.panel }]}>
            {effortChoices.length ? (
              <>
                <Pressable
                  accessibilityLabel="Reasoning effort"
                  accessibilityRole="button"
                  accessibilityState={{ expanded: reasoningExpanded }}
                  onPress={() => setReasoningExpanded((expanded) => !expanded)}
                  style={[
                    styles.optionRow,
                    effectiveCaps?.fast === true || reasoningExpanded
                      ? {
                          borderBottomColor: colors.border,
                          borderBottomWidth: StyleSheet.hairlineWidth,
                        }
                      : null,
                  ]}>
                  <ThemedText type="smallBold">Reasoning effort</ThemedText>
                  <View style={styles.modelRowSpacer} />
                  <ThemedText themeColor="textSecondary" type="small">
                    {draftEffort ?? override?.reasoningEffort ?? 'Default'}
                  </ThemedText>
                  <ThemedText themeColor="textTertiary" type="small">›</ThemedText>
                </Pressable>
                {reasoningExpanded ? (
                  <View
                    style={[
                      styles.reasoningChoices,
                      effectiveCaps?.fast === true
                        ? {
                            borderBottomColor: colors.border,
                            borderBottomWidth: StyleSheet.hairlineWidth,
                          }
                        : null,
                    ]}>
                    {effortChoices.map((choice) => {
                      const active = (draftEffort ?? override?.reasoningEffort) === choice;
                      return (
                        <Pressable
                          key={choice}
                          accessibilityLabel={`Reasoning effort ${choice}`}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: active }}
                          onPress={() => {
                            setDraftEffort(choice);
                            setReasoningExpanded(false);
                            void updateOverride({ reasoningEffort: choice });
                          }}
                          style={[
                            styles.choice,
                            {
                              backgroundColor: active
                                ? colors.backgroundSelected
                                : colors.backgroundElement,
                            },
                          ]}>
                          <ThemedText type={active ? 'smallBold' : 'small'}>{choice}</ThemedText>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </>
            ) : null}
            {effectiveCaps?.fast === true ? (
              <View style={styles.optionRow}>
                <ThemedText type="smallBold">Fast mode</ThemedText>
                <View style={styles.modelRowSpacer} />
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
          </View>
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
    <ScrollView contentContainerStyle={styles.usageContent} style={styles.panelBody}>
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
  inline: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.one,
    height: 36,
    maxWidth: 220,
    paddingHorizontal: 12,
  },
  inlineMark: { borderRadius: 3, height: 6, width: 6 },
  inlineLabel: { flexShrink: 1 },
  inlineDisclosure: { fontSize: 12, lineHeight: 16, marginLeft: 1 },
  modalRoot: { flex: 1 },
  modalBackdrop: {
    backgroundColor: 'rgba(0,0,0,0.58)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    alignSelf: 'center',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    height: '90%',
    maxWidth: 720,
    overflow: 'hidden',
    width: '100%',
  },
  sheetHandle: {
    alignSelf: 'center',
    borderRadius: 3,
    height: 5,
    marginTop: 9,
    opacity: 0.8,
    width: 42,
  },
  modalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 72,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  headerCopy: { flex: 1 },
  headerTitle: { fontSize: 20, lineHeight: 25, textAlign: 'left' },
  doneButton: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: 18,
  },
  panelSwitch: {
    borderRadius: 12,
    flexDirection: 'row',
    gap: 2,
    marginHorizontal: Spacing.four,
    padding: 3,
  },
  panelTab: {
    alignItems: 'center',
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minHeight: 36,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
  panelBody: { flex: 1 },
  pickerContent: { paddingBottom: 40, paddingTop: 4 },
  usageContent: { gap: Spacing.two, paddingBottom: Spacing.five, paddingHorizontal: Spacing.four, paddingTop: Spacing.two },
  stateRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  searchBox: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    marginBottom: 10,
    marginHorizontal: Spacing.four,
    marginTop: 12,
    paddingHorizontal: Spacing.three,
  },
  searchIcon: { fontSize: 21, lineHeight: 24 },
  searchInput: { flex: 1, fontSize: 16, minHeight: 44, outlineStyle: 'none' } as never,
  providerRail: { gap: Spacing.two, paddingBottom: Spacing.two, paddingHorizontal: Spacing.four },
  providerChip: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 36,
    maxWidth: 210,
    paddingHorizontal: 14,
  },
  providerSection: { width: '100%' },
  groupHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: Spacing.four,
    marginTop: 2,
    minHeight: 42,
    paddingHorizontal: 4,
    paddingTop: 6,
  },
  providerMark: {
    alignItems: 'center',
    borderRadius: 8,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  providerMarkText: { fontSize: 11, lineHeight: 14 },
  providerName: { flex: 1 },
  modelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: Spacing.four,
    minHeight: 58,
    overflow: 'hidden',
    paddingHorizontal: Spacing.three,
    paddingVertical: 7,
  },
  modelRowFirst: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  modelRowLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  modelRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth },
  selectionBar: { alignSelf: 'stretch', borderRadius: 2, marginVertical: 3, width: 3 },
  modelCopy: { flex: 1 },
  modelTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  modelName: { flexShrink: 1, fontSize: 16, fontWeight: '600', lineHeight: 21 },
  modelRowSpacer: { flex: 1 },
  favoriteButton: { alignItems: 'center', height: 42, justifyContent: 'center', width: 42 },
  favoriteIcon: { fontSize: 21, lineHeight: 24 },
  badge: {
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  emptyModels: { alignItems: 'center', gap: 4, paddingHorizontal: Spacing.four, paddingVertical: 56 },
  emptyTitle: { textAlign: 'center' },
  emptyDetail: { maxWidth: 280, textAlign: 'center' },
  optionsSection: { marginTop: 8, paddingBottom: 12 },
  sectionLabel: { paddingBottom: 8, paddingHorizontal: 20, paddingTop: 8 },
  optionsCard: { borderRadius: 16, marginHorizontal: Spacing.four, overflow: 'hidden' },
  optionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: Spacing.four,
    paddingVertical: 6,
  },
  reasoningChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    padding: Spacing.three,
  },
  choice: {
    alignItems: 'center',
    borderRadius: 9,
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
