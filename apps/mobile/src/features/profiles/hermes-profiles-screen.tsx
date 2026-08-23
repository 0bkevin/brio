import { useMutation, useQuery, useQueryClient,
  type UseMutationResult } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { DashboardCard, SectionLabel, StatusBadge } from '@/components/dashboard';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { AgentConnection } from '@/lib/brio';
import {
  createProfile,
  deleteProfile,
  describeProfile,
  exportProfileArchive,
  getProfileSOUL,
  importProfileArchive,
  installProfileDistribution,
  listProfiles,
  previewProfileArchiveImport,
  previewProfileExport,
  previewProfileDistribution,
  profileGatewayAction,
  profileSetupCommand,
  renameProfile,
  updateProfileSOUL,
  updateProfileDistribution,
  useProfile as activateDefaultProfile,
  type DistributionPreview,
  type GatewayAction,
  type HermesProfile,
  type ImportPreview,
} from '@/lib/profiles';

type CreateKind = 'blank' | 'clone' | 'clone_all' | 'clone_from';

/**
 * Full Hermes profile management for the connected environment: create blank
 * or cloned profiles, edit SOUL/description, run setup, export/import
 * archives and install git-style distributions. Destructive operations mirror
 * Hermes guarantees: typed-name confirmation, default-profile protection, and
 * connector-side refusals while a profile gateway is running.
 */
export function HermesProfilesScreen({ connection }: { connection: AgentConnection }) {
  const theme = useTheme();
  const queryClient = useQueryClient();

  const profilesQuery = useQuery({
    queryKey: ['profiles', connection.url, connection.agentId ?? connection.id],
    queryFn: () => listProfiles(connection),
    staleTime: 15_000,
    retry: false,
  });
  const profiles: HermesProfile[] = profilesQuery.data?.profiles ?? [];
  const supported = !profilesQuery.isError;

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['profiles', connection.url, connection.agentId ?? connection.id],
    });
  };

  const [createKind, setCreateKind] = useState<CreateKind>('blank');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [cloneFrom, setCloneFrom] = useState('');

  const invalidateAll = async () => {
    await refresh();
    await queryClient.invalidateQueries({ queryKey: ['hermes-sessions'] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createProfile(connection, {
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        clone: createKind === 'clone',
        clone_all: createKind === 'clone_all',
        clone_from: createKind === 'clone_from' ? cloneFrom.trim() : undefined,
      }),
    onSuccess: async () => {
      setNewName('');
      setNewDescription('');
      setCloneFrom('');
      await invalidateAll();
    },
  });

  if (!supported) {
    return (
      <DashboardCard>
        <SectionLabel>Hermes profiles</SectionLabel>
        <ThemedText themeColor="textSecondary">
          This agent does not expose Brio&apos;s profile surface yet. Update the
          brio connector on that machine to manage multiple Hermes agents.
        </ThemedText>
        {profilesQuery.error ? (
          <ThemedText themeColor="textTertiary" type="small">
            {profilesQuery.error instanceof Error ? profilesQuery.error.message : ''}
          </ThemedText>
        ) : null}
      </DashboardCard>
    );
  }

  return (
    <DashboardCard>
      <SectionLabel>Hermes profiles</SectionLabel>
      <ThemedText themeColor="textSecondary">
        Multiple isolated agents on this machine — each with its own config,
        keys, memory, sessions, and gateway.
      </ThemedText>

      {profilesQuery.isLoading ? <ThemedText themeColor="textSecondary">Loading…</ThemedText> : null}
      {profiles.map((profile) => (
        <ProfileRow key={profile.name} connection={connection} onChanged={invalidateAll} profile={profile} />
      ))}

      <View style={styles.divider} />
      <ThemedText type="smallBold">Create a profile</ThemedText>
      <View style={styles.kindRow}>
        {(
          [
            ['blank', 'Blank'],
            ['clone', 'Clone config'],
            ['clone_all', 'Clone all'],
            ['clone_from', 'From profile'],
          ] as [CreateKind, string][]
        ).map(([kind, label]) => (
          <Pressable
            key={kind}
            onPress={() => setCreateKind(kind)}
            style={({ pressed }) => [
              styles.kindChip,
              {
                borderColor: createKind === kind ? theme.accent : theme.border,
                backgroundColor: createKind === kind ? theme.backgroundSelected : 'transparent',
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <ThemedText type="small">{label}</ThemedText>
          </Pressable>
        ))}
      </View>
      <ThemedInput label="Profile name" onChangeText={setNewName} value={newName} placeholder="research-bot" />
      <ThemedInput
        label="Role description"
        onChangeText={setNewDescription}
        value={newDescription}
        placeholder="Reads source code and writes findings."
      />
      {createKind === 'clone_from' ? (
        <ThemedInput label="Clone from" onChangeText={setCloneFrom} value={cloneFrom} placeholder="coder" />
      ) : null}
      <PrimaryButton
        disabled={createMutation.isPending || !newName.trim() || (createKind === 'clone_from' && !cloneFrom.trim())}
        label={createMutation.isPending ? 'Creating…' : 'Create Profile'}
        onPress={() => createMutation.mutate()}
      />
      {createMutation.error ? (
        <ErrorText error={createMutation.error} />
      ) : (
        <ThemedText themeColor="textTertiary" type="small">
          Clones copy config, keys, SOUL and skills; “clone all” also copies
          memories and cron jobs but never another profile&apos;s session history.
        </ThemedText>
      )}

      <View style={styles.divider} />
      <ImportArchiveCard connection={connection} onDone={invalidateAll} />
      <InstallDistributionCard connection={connection} onDone={invalidateAll} />
    </DashboardCard>
  );
}

function ProfileRow({
  connection,
  onChanged,
  profile,
}: {
  connection: AgentConnection;
  onChanged: () => Promise<void>;
  profile: HermesProfile;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={[styles.profileBlock, { borderColor: theme.border }]}>
      <Pressable
        accessibilityLabel={`Manage profile ${profile.name}`}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ([styles.profileHeader, { opacity: pressed ? 0.7 : 1 }])}>
        <View style={styles.profileCopy}>
          <View style={styles.profileTitleRow}>
            <ThemedText type="smallBold">{profile.name}</ThemedText>
            {profile.is_default ? <StatusBadge tone="neutral">default</StatusBadge> : null}
            {profile.active && !profile.is_default ? <StatusBadge tone="success">active</StatusBadge> : null}
            <StatusBadge tone={profile.gateway_running ? 'success' : 'neutral'}>
              {profile.gateway_running ? `gateway ${profile.gateway_pid ?? ''}` : 'gateway off'}
            </StatusBadge>
          </View>
          <ThemedText numberOfLines={2} themeColor="textSecondary" type="small">
            {profile.description?.trim() ||
              (profile.model ? `Model ${profile.model}` : profile.path)}
          </ThemedText>
        </View>
        <ThemedText themeColor="textTertiary">{expanded ? '▾' : '›'}</ThemedText>
      </Pressable>

      {expanded ? <ProfileActions connection={connection} onChanged={onChanged} profile={profile} /> : null}
    </View>
  );
}

function ProfileActions({
  connection,
  onChanged,
  profile,
}: {
  connection: AgentConnection;
  onChanged: () => Promise<void>;
  profile: HermesProfile;
}) {
  const theme = useTheme();
  const [confirmName, setConfirmName] = useState('');
  const [renameTarget, setRenameTarget] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState(profile.description ?? '');
  const [exportPreviewLines, setExportPreviewLines] = useState<string[] | null>(null);
  const [notice, setNotice] = useState('');
  const [soulOpen, setSoulOpen] = useState(false);
  const [soulDraft, setSoulDraft] = useState<string | null>(null);

  const soul = useQuery({
    queryKey: ['profile-soul', connection.url, connection.agentId ?? connection.id, profile.name],
    enabled: soulOpen && soulDraft === null,
    queryFn: () => getProfileSOUL(connection, profile.name),
    retry: false,
  });

  const finish = async (message?: string) => {
    setNotice(message ?? '');
    await onChanged();
  };

  const activateMutation = useMutation({
    mutationFn: () => activateDefaultProfile(connection, profile.name),
    onSuccess: () => void finish(`${profile.name} is now Brio's default for this machine.`),
    onError: (error) => setNotice(errorMessage(error)),
  });
  const describeMutation = useMutation({
    mutationFn: () => describeProfile(connection, profile.name, descriptionDraft),
    onSuccess: () => void finish('Description saved.'),
    onError: (error) => setNotice(errorMessage(error)),
  });
  const soulMutation = useMutation({
    mutationFn: () => updateProfileSOUL(connection, profile.name, soulDraft ?? ''),
    onSuccess: () => {
      setSoulDraft(null);
      void finish('SOUL.md saved. New sessions pick it up.');
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  // Gateway lifecycle runs through the real `hermes [-p <name>] gateway <action>`.
  const gatewayMutation = useMutation({
    mutationFn: (action: GatewayAction) => profileGatewayAction(connection, profile.name, action),
    onSuccess: async (result) => {
      setNotice(result.output || `${result.profile.name}: gateway ${result.profile.gateway_running ? 'running' : 'stopped'}.`);
      await onChanged();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const updateDistMutation = useMutation({
    mutationFn: () => updateProfileDistribution(connection, profile.name),
    onSuccess: async (result) => {
      const envList = (result.env_requires ?? []).map((req) => req.name).join(', ');
      setNotice(
        `Updated from ${result.provenance}.${envList ? ` Needs: ${envList}` : ''}`,
      );
      await onChanged();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const renameMutation = useMutation({
    mutationFn: () => renameProfile(connection, profile.name, renameTarget.trim(), profile.name),
    onSuccess: async () => {
      setRenameTarget('');
      setConfirmName('');
      await finish('Profile renamed. Hermes migrated the alias and service.');
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteProfile(connection, profile.name, confirmName),
    onSuccess: async (result) => {
      setConfirmName('');
      const warnings = result.warnings ?? [];
      await finish(
        warnings.length ? `Deleted. Note: ${warnings.join(' ')}` : `${profile.name} deleted.`,
      );
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const previewExportMutation = useMutation({
    mutationFn: () => previewProfileExport(connection, profile.name),
    onSuccess: (result) => {
      const lines = [
        `${result.file_count} files · ${(result.total_bytes / 1024).toFixed(1)} KiB`,
        result.credentials_included
          ? '⚠ Includes credentials'
          : `No credentials (.env defines: ${(result.required_env_vars ?? []).join(', ') || 'none'})`,
        ...(result.files ?? []),
      ];
      setExportPreviewLines(lines.slice(0, 24));
    },
    onError: () => setExportPreviewLines(['Could not build the export preview.']),
  });
  const exportMutation = useMutation({
    mutationFn: () => exportProfileArchive(connection, profile.name),
    onSuccess: async (result) => {
      await Clipboard.setStringAsync(result.data_base64);
      await finish(
        `${result.filename} copied to the clipboard as base64 (${result.file_count} files, no credentials).`,
      );
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  return (
    <View style={styles.actionsColumn}>
      {notice ? <ThemedText type="small" themeColor="textSecondary">{notice}</ThemedText> : null}

      <View style={styles.buttonRow}>
        <GatewayButton action="start" label="Start" pendingAction={gatewayPendingAction(gatewayMutation)} onRun={gatewayMutation} />
        <GatewayButton action="stop" label="Stop" pendingAction={gatewayPendingAction(gatewayMutation)} onRun={gatewayMutation} />
        <GatewayButton action="restart" label="Restart" pendingAction={gatewayPendingAction(gatewayMutation)} onRun={gatewayMutation} />
      </View>

      {!profile.is_default ? (
        <PrimaryButton
          disabled={activateMutation.isPending || profile.active}
          label={profile.active ? 'Brio default' : 'Set as Brio default'}
          onPress={() => activateMutation.mutate()}
        />
      ) : null}

      <ThemedText type="smallBold">Setup command</ThemedText>
      <SelectableCode text={profileSetupCommand(profile.name)} />

      {profile.distribution_name ? (
        <SecondaryButton
          disabled={updateDistMutation.isPending}
          label={`Update distribution (${profile.distribution_name}${profile.distribution_version ? ` ${profile.distribution_version}` : ''})`}
          onPress={() => updateDistMutation.mutate()}
        />
      ) : null}

      <ThemedInput
        label="Role description"
        onChangeText={setDescriptionDraft}
        value={descriptionDraft}
        placeholder="What is this agent good at?"
      />
      <SecondaryButton
        disabled={describeMutation.isPending}
        label="Save description"
        onPress={() => describeMutation.mutate()}
      />

      <SecondaryButton
        label={soulOpen ? 'Hide SOUL editor' : 'Edit SOUL.md'}
        onPress={() => {
          setSoulOpen(!soulOpen);
          setSoulDraft(null);
        }}
      />
      {soulOpen ? (
        soul.isLoading ? (
          <ThemedText themeColor="textSecondary" type="small">Loading SOUL.md…</ThemedText>
        ) : (
          <>
            <TextInput
              accessibilityLabel="SOUL.md content"
              multiline
              onChangeText={setSoulDraft}
              placeholder="Personality and instructions for this agent."
              placeholderTextColor={theme.textTertiary}
              style={[styles.soulInput, { color: theme.text, borderColor: theme.backgroundSelected }]}
              textAlignVertical="top"
              value={soulDraft ?? soul.data?.content ?? ''}
            />
            <PrimaryButton disabled={soulMutation.isPending} label="Save SOUL" onPress={() => soulMutation.mutate()} />
          </>
        )
      ) : null}

      {!profile.is_default ? (
        <>
          <ThemedText type="smallBold">Rename</ThemedText>
          <ThemedText themeColor="textTertiary" type="small">
            Hermes stops the gateway and migrates the command alias and managed service.
            Type &quot;{profile.name}&quot; to confirm.
          </ThemedText>
          <ThemedInput label="New name" onChangeText={setRenameTarget} value={renameTarget} placeholder="dev-bot" />
          <ThemedInput label={`Type "${profile.name}" to confirm`} onChangeText={setConfirmName} value={confirmName} placeholder={profile.name} />
          <SecondaryButton
            disabled={renameMutation.isPending || renameTarget.trim().length === 0 || confirmName !== profile.name}
            label="Rename profile"
            onPress={() => renameMutation.mutate()}
          />

          <ThemedText type="smallBold">Delete</ThemedText>
          <ThemedText themeColor="textTertiary" type="small">
            Hermes stops the gateway and its service, removes the alias, then deletes every
            file in this profile. The default profile can never be deleted. Type &quot;{profile.name}&quot; to arm the button.
          </ThemedText>
          <SecondaryButton
            danger
            disabled={deleteMutation.isPending || confirmName !== profile.name}
            label={deleteMutation.isPending ? 'Deleting…' : `Delete ${profile.name}`}
            onPress={() =>
              Alert.alert(
                `Delete ${profile.name}?`,
                'This permanently removes config, keys, memory, sessions, and skills of this profile.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete forever', style: 'destructive', onPress: () => deleteMutation.mutate() },
                ],
              )
            }
          />
        </>
      ) : null}

      <ThemedText type="smallBold">Export archive</ThemedText>
      <ThemedText themeColor="textTertiary" type="small">
        Built by the hermes CLI on the machine; exports never contain credentials.
      </ThemedText>
      <SecondaryButton
        disabled={previewExportMutation.isPending}
        label="Preview files"
        onPress={() => previewExportMutation.mutate()}
      />
      {exportPreviewLines ? (
        <View style={styles.previewBox}>
          {exportPreviewLines.map((line, index) => (
            <SelectableCode key={`${index}-${line}`} hideOnTap text={line} />
          ))}
        </View>
      ) : null}
      <SecondaryButton
        disabled={exportMutation.isPending}
        label={exportMutation.isPending ? 'Packing…' : 'Export & copy base64'}
        onPress={() => exportMutation.mutate()}
      />
    </View>
  );
}

function gatewayPendingAction(
  mutation: UseMutationResult<{ output: string; profile: HermesProfile }, Error, GatewayAction>,
): GatewayAction | null {
  if (!mutation.isPending) return null;
  return (mutation.variables as GatewayAction | undefined) ?? null;
}

function GatewayButton({
  action,
  label,
  onRun,
  pendingAction,
}: {
  action: GatewayAction;
  label: string;
  onRun: UseMutationResult<{ output: string; profile: HermesProfile }, Error, GatewayAction>;
  pendingAction: GatewayAction | null;
}) {
  const theme = useTheme();
  const busy = pendingAction !== null;
  return (
    <Pressable
      accessibilityLabel={`${label} gateway`}
      disabled={busy}
      onPress={() => onRun.mutate(action)}
      style={({ pressed }) => [
        styles.gatewayButton,
        {
          backgroundColor: theme.backgroundSelected,
          borderColor: theme.border,
          opacity: pressed || busy ? 0.6 : 1,
        },
      ]}>
      <ThemedText type="smallBold">{pendingAction === action ? `${label}…` : label}</ThemedText>
    </Pressable>
  );
}

function ImportArchiveCard({
  connection,
  onDone,
}: {
  connection: AgentConnection;
  onDone: () => Promise<void>;
}) {
  const theme = useTheme();
  const [archiveB64, setArchiveB64] = useState('');
  const [targetName, setTargetName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewInput, setPreviewInput] = useState<{ archiveB64: string; name: string } | null>(null);
  // Consent is bound to the exact current preview: it resets whenever the
  // preview changes and only appears when that preview reported secrets.
  const [secretsConsent, setSecretsConsent] = useState(false);
  const [notice, setNotice] = useState('');

  const invalidatePreview = () => {
    setPreview(null);
    setPreviewInput(null);
    setSecretsConsent(false);
  };

  const dryRun = useMutation({
    mutationFn: () => previewProfileArchiveImport(connection, { archiveB64, name: targetName }),
    onSuccess: (result) => {
      setNotice(
        `${result.has_secrets_file ? '⚠ Credential files inside: ' + (result.secret_files ?? []).join(', ') : 'No credential files'} · files: ${result.file_count}${(result.required_env_vars ?? []).length ? ` · env vars: ${(result.required_env_vars ?? []).join(', ')}` : ''}`,
      );
      setPreview(result);
      setPreviewInput({ archiveB64: archiveB64.trim(), name: targetName.trim() });
      setSecretsConsent(false);
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const apply = useMutation({
    mutationFn: () =>
      importProfileArchive(connection, {
        archiveB64,
        name: targetName,
        previewToken: preview?.preview_token ?? '',
        allowSecrets: secretsConsent,
      }),
    onSuccess: async () => {
      setArchiveB64('');
      setTargetName('');
      setPreview(null);
      setPreviewInput(null);
      setSecretsConsent(false);
      await onDone();
      setNotice('Import complete.');
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const previewMatchesCurrentInput = Boolean(
    dryRun.isSuccess &&
      preview?.preview_token.trim() &&
      previewInput?.archiveB64 === archiveB64.trim() &&
      previewInput?.name === targetName.trim(),
  );

  return (
    <View style={styles.importCard}>
      <ThemedText type="smallBold">Import an exported profile archive</ThemedText>
      <ThemedInput
        label="Target profile name"
        onChangeText={(value) => {
          setTargetName(value);
          invalidatePreview();
        }}
        value={targetName}
        placeholder="restored-bot"
      />
      <ThemedInput
        label="Archive (base64)"
        multiline
        onChangeText={(value) => {
          setArchiveB64(value);
          invalidatePreview();
        }}
        value={archiveB64}
        placeholder="H4sIAA…"
      />
      {dryRun.isSuccess && preview?.has_secrets_file ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: secretsConsent }}
          onPress={() => setSecretsConsent((value) => !value)}
          style={styles.consentRow}>
          <View style={[styles.checkbox, { borderColor: theme.border }, secretsConsent && { backgroundColor: theme.danger }]}>
            {secretsConsent ? <ThemedText type="small">✓</ThemedText> : null}
          </View>
          <ThemedText themeColor="textSecondary" type="small">
            Include the credential files this archive carries (explicit consent)
          </ThemedText>
        </Pressable>
      ) : null}
      <View style={styles.buttonRow}>
        <SecondaryButton disabled={dryRun.isPending || !archiveB64.trim() || !targetName.trim()} label="Preview" onPress={() => dryRun.mutate()} />
        <PrimaryButton
          disabled={
            !previewMatchesCurrentInput ||
            apply.isPending ||
            !archiveB64.trim() ||
            !targetName.trim() ||
            (Boolean(preview?.has_secrets_file) && !secretsConsent)
          }
          label={apply.isPending ? 'Importing…' : 'Import'}
          onPress={() => apply.mutate()}
        />
      </View>
      {notice ? <ThemedText themeColor="textSecondary" type="small">{notice}</ThemedText> : null}
    </View>
  );
}

function InstallDistributionCard({
  connection,
  onDone,
}: {
  connection: AgentConnection;
  onDone: () => Promise<void>;
}) {
  const theme = useTheme();
  const [source, setSource] = useState('');
  const [targetName, setTargetName] = useState('');
  const [force, setForce] = useState(false);
  const [alias, setAlias] = useState(false);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<DistributionPreview | null>(null);
  const [previewInput, setPreviewInput] = useState<{ source: string; name: string } | null>(null);

  const describe = (result: DistributionPreview, extra?: string) => {
    const envList = (result.env_requires ?? [])
      .map((req) => `${req.name}${req.required ? '' : ' (optional)'}`)
      .join(', ');
    return [
      `${result.manifest_name}@${result.version || '?'} → profile "${result.target_name}"${result.existing ? ' (update)' : ' (new)'}`,
      `${result.file_count} files · keeps local .env/memories/sessions`,
      envList ? `Needs env: ${envList}` : null,
      extra,
    ]
      .filter(Boolean)
      .join('\n');
  };

  // Preview tokens bind apply to the exact staged tree, so input handlers
  // invalidate both the preview and token in the same user event.
  const invalidatePreview = () => {
    setPreview(null);
    setPreviewInput(null);
  };

  const dryRun = useMutation({
    mutationFn: () => previewProfileDistribution(connection, { source, name: targetName }),
    onSuccess: (result) => {
      setPreview(result);
      setPreviewInput({ source: source.trim(), name: targetName.trim() });
      setNotice(describe(result));
    },
    onError: (error) => {
      setPreview(null);
      setNotice(errorMessage(error));
    },
  });
  const apply = useMutation({
    mutationFn: () =>
      installProfileDistribution(connection, {
        source,
        name: targetName,
        force,
        alias,
        previewToken: preview?.preview_token ?? '',
      }),
    onSuccess: async (result) => {
      setPreview(null);
      setPreviewInput(null);
      setForce(false);
      await onDone();
      setNotice(describe(result, `Installed ${result.target_name}.`));
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const previewMatchesCurrentInput = Boolean(
    dryRun.isSuccess &&
      preview?.preview_token.trim() &&
      previewInput?.source === source.trim() &&
      previewInput?.name === targetName.trim(),
  );

  return (
    <View style={styles.importCard}>
      <ThemedText type="smallBold">Install an agent distribution</ThemedText>
      <ThemedText themeColor="textTertiary" type="small">
        Git URL (github.com/user/repo, https/ssh, optional #ref pin) or a local checkout path
        containing distribution.yaml. Applied through the hermes CLI.
      </ThemedText>
      <ThemedInput
        label="Source"
        onChangeText={(value) => {
          setSource(value);
          invalidatePreview();
        }}
        value={source}
        placeholder="github.com/you/research-bot#v1.2.0"
      />
      <ThemedInput
        label="Profile name (optional — defaults to the manifest)"
        onChangeText={(value) => {
          setTargetName(value);
          invalidatePreview();
        }}
        value={targetName}
        placeholder="from manifest"
      />
      {dryRun.isSuccess && preview?.existing ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: force }}
          onPress={() => setForce((value) => !value)}
          style={styles.consentRow}>
          <View style={[styles.checkbox, { borderColor: theme.border }, force && { backgroundColor: theme.danger }]}>
            {force ? <ThemedText type="small">✓</ThemedText> : null}
          </View>
          <ThemedText themeColor="textSecondary" type="small">
            Overwrite the existing target profile (--force)
          </ThemedText>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: alias }}
        onPress={() => setAlias((value) => !value)}
        style={styles.consentRow}>
        <View style={[styles.checkbox, { borderColor: theme.border }, alias && { backgroundColor: theme.accent }]}>
          {alias ? <ThemedText type="small">✓</ThemedText> : null}
        </View>
        <ThemedText themeColor="textSecondary" type="small">
          Create the shell command alias (--alias)
        </ThemedText>
      </Pressable>
      <View style={styles.buttonRow}>
        <SecondaryButton disabled={dryRun.isPending || !source.trim()} label="Preview" onPress={() => dryRun.mutate()} />
        <PrimaryButton
          disabled={!previewMatchesCurrentInput || apply.isPending}
          label={apply.isPending ? 'Installing…' : 'Install'}
          onPress={() => apply.mutate()}
        />
      </View>
      {preview?.files?.length ? (
        <View style={styles.previewBox}>
          {preview.files.slice(0, 16).map((file) => (
            <SelectableCode key={file} hideOnTap text={file} />
          ))}
          {(preview.skipped_user_owned ?? []).slice(0, 6).map((entry) => (
            <SelectableCode key={entry} hideOnTap text={`skipped: ${entry}`} />
          ))}
        </View>
      ) : null}
      {notice ? <ThemedText themeColor="textSecondary" type="small">{notice}</ThemedText> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function ThemedInput({
  label,
  ...props
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.inputGroup}>
      <ThemedText type="smallBold">{label}</ThemedText>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.textTertiary}
        style={[
          props.multiline ? styles.multilineInput : styles.textInput,
          { color: theme.text, borderColor: theme.backgroundSelected },
        ]}
        {...props}
      />
    </View>
  );
}

function SelectableCode({ text, hideOnTap }: { text: string; hideOnTap?: boolean }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  if (hideOnTap) {
    return (
      <ThemedText selectable type="code" style={styles.codeLine}>
        {text}
      </ThemedText>
    );
  }
  return (
    <Pressable
      onPress={() => {
        void Clipboard.setStringAsync(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      style={({ pressed }) => [styles.codeBox, { backgroundColor: theme.backgroundSelected, opacity: pressed ? 0.75 : 1 }]}>
      <ThemedText selectable type="code" style={styles.codeLine}>
        {copied ? `${text}  ✓ copied` : text}
      </ThemedText>
    </Pressable>
  );
}

function PrimaryButton({
  disabled,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.primaryButton,
        { backgroundColor: disabled ? theme.backgroundSelected : theme.accent },
      ]}>
      <ThemedText style={{ color: disabled ? theme.textDisabled : theme.accentText }} type="smallBold">
        {label}
      </ThemedText>
    </Pressable>
  );
}

function SecondaryButton({
  danger,
  disabled,
  label,
  onPress,
}: {
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondaryButton,
        {
          backgroundColor: theme.backgroundSelected,
          borderColor: danger && !disabled ? theme.danger : theme.border,
          opacity: pressed || disabled ? 0.6 : 1,
        },
      ]}>
      <ThemedText style={{ color: danger && !disabled ? theme.danger : theme.text }} type="smallBold">
        {label}
      </ThemedText>
    </Pressable>
  );
}

function ErrorText({ error }: { error: unknown }) {
  const theme = useTheme();
  return (
    <ThemedText style={{ color: theme.danger }} type="small">
      {errorMessage(error)}
    </ThemedText>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

const styles = StyleSheet.create({
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    marginVertical: Spacing.two,
  },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  kindChip: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 32,
    paddingHorizontal: Spacing.two,
    paddingVertical: 4,
    justifyContent: 'center',
  },
  inputGroup: { gap: Spacing.one },
  textInput: {
    backgroundColor: 'rgba(0,0,0,0.12)',
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
  },
  multilineInput: {
    backgroundColor: 'rgba(0,0,0,0.12)',
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 96,
    padding: Spacing.three,
    textAlignVertical: 'top',
  },
  soulInput: {
    backgroundColor: 'rgba(0,0,0,0.12)',
    borderRadius: Spacing.two,
    borderWidth: 1,
    fontFamily: 'monospace',
    minHeight: 160,
    padding: Spacing.three,
    textAlignVertical: 'top',
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
  },
  secondaryButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
  },
  buttonRow: { flexDirection: 'row', gap: Spacing.two },
  gatewayButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
  },
  profileBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: Spacing.two,
    paddingTop: Spacing.two,
  },
  profileHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: Spacing.two, justifyContent: 'space-between' },
  profileCopy: { flex: 1, gap: 2, minWidth: 0 },
  profileTitleRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  actionsColumn: { gap: Spacing.one, paddingTop: Spacing.two },
  consentRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two },
  checkbox: {
    alignItems: 'center',
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  previewBox: {
    gap: Spacing.one,
    maxHeight: 220,
    overflow: 'hidden',
  },
  codeBox: {
    borderRadius: Spacing.one,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
  },
  codeLine: { lineHeight: 16 },
  importCard: { gap: Spacing.two, marginTop: Spacing.two },
});
