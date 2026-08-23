import { useQuery } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useIncomingShareContext } from '@/features/threads/incoming-share-context';
import { useTheme } from '@/hooks/use-theme';
import {
  completeContextReference,
  completeSlashCommand,
  deleteAttachmentUpload,
  getCommandCatalog,
  getComposerCapabilities,
  type AgentConnection,
  type CommandCatalog,
} from '@/lib/brio';
import { applyCompletion, completionToken, composerContentFromSharedPayloads } from '@/lib/composer-model';
import { uploadComposerAttachment, type AttachmentSource } from '@/lib/composer';
import type { ComposerAttachment, PromptDeliveryMode } from '@/state/composer-store-model';

type UploadState = {
  key: string;
  name: string;
  progress: number;
  controller: AbortController;
  error?: string;
};

export function ComposerControls({
  active,
  attachments,
  canRedo,
  canUndo,
  connection,
  draft,
  history,
  hydrated,
  onAddAttachment,
  onDraftChange,
  onRedo,
  onRemoveAttachment,
  onSend,
  onUndo,
  sessionId,
}: {
  active: boolean;
  attachments: ComposerAttachment[];
  canRedo: boolean;
  canUndo: boolean;
  connection: AgentConnection;
  draft: string;
  history: string[];
  hydrated: boolean;
  onAddAttachment: (attachment: ComposerAttachment) => Promise<void>;
  onDraftChange: (text: string) => void;
  onRedo: () => void;
  onRemoveAttachment: (attachmentId: string) => Promise<boolean>;
  onSend: (mode: PromptDeliveryMode) => void;
  onUndo: () => void;
  sessionId: string;
}) {
  const colors = useTheme();
  const incomingShare = useIncomingShareContext();
  const processedShare = useRef<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [error, setError] = useState('');
  const token = completionToken(draft);

  const capabilities = useQuery({
    queryKey: ['composer-capabilities', connection.id, connection.url],
    queryFn: () => getComposerCapabilities(connection),
    staleTime: 5 * 60_000,
  });
  const suggestions = useQuery({
    queryKey: ['composer-completion', connection.id, token?.kind, token?.query],
    queryFn: () =>
      token?.kind === 'command'
        ? completeSlashCommand(connection, token.query)
        : completeContextReference(connection, token?.query ?? ''),
    enabled: Boolean(token),
    staleTime: 15_000,
  });
  const commands = useQuery({
    queryKey: ['composer-commands', connection.id],
    queryFn: () => getCommandCatalog(connection),
    enabled: commandsOpen,
    staleTime: 60_000,
  });
  const canSend = hydrated && (Boolean(draft.trim()) || attachments.length > 0) && uploads.length === 0;

  const uploadSources = useCallback(async (sources: AttachmentSource[]) => {
    setPickerOpen(false);
    setError('');
    const perFileLimit = capabilities.data?.attachment_file_bytes ?? 8 * 1024 * 1024;
    const totalLimit = capabilities.data?.attachment_total_bytes ?? 20 * 1024 * 1024;
    const countLimit = capabilities.data?.attachment_max_count ?? 20;
    const selectedTotal = sources.reduce((sum, source) => sum + (source.size ?? 0), 0);
    const currentTotal = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
    if (attachments.length + sources.length > countLimit) {
      setError(`One prompt can include at most ${countLimit} attachments.`);
      return false;
    }
    if (sources.some((source) => source.size && source.size > perFileLimit)) {
      setError(`Each attachment must be ${formatBytes(perFileLimit)} or smaller.`);
      return false;
    }
    if (currentTotal + selectedTotal > totalLimit) {
      setError(`Attachments for one prompt are limited to ${formatBytes(totalLimit)}.`);
      return false;
    }

    let succeeded = true;
    for (const source of sources) {
      const key = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      setUploads((current) => [...current, { key, name: source.name, progress: 0, controller }]);
      try {
        const uploaded = await uploadComposerAttachment(
          connection,
          sessionId,
          source,
          (progress) => setUploads((current) => current.map((item) => item.key === key ? { ...item, progress } : item)),
          controller.signal,
        );
        await onAddAttachment(uploaded);
        setUploads((current) => current.filter((item) => item.key !== key));
      } catch (reason) {
        succeeded = false;
        const message = reason instanceof Error ? reason.message : 'Attachment upload failed';
        setUploads((current) => current.map((item) => item.key === key ? { ...item, error: message } : item));
      } finally {
        if (Platform.OS === 'web' && source.uri.startsWith('blob:')) URL.revokeObjectURL(source.uri);
      }
    }
    return succeeded;
  }, [attachments, capabilities.data, connection, onAddAttachment, sessionId]);

  useEffect(() => {
    if (incomingShare.isResolving || incomingShare.error || incomingShare.sharedPayloads.length === 0) return;
    const payloads = incomingShare.resolvedSharedPayloads.length
      ? incomingShare.resolvedSharedPayloads
      : incomingShare.sharedPayloads;
    const fingerprint = JSON.stringify(payloads.map((payload) => [payload.shareType, payload.mimeType, payload.value]));
    if (processedShare.current === fingerprint) return;
    processedShare.current = fingerprint;
    void (async () => {
      const shared = composerContentFromSharedPayloads(payloads);
      if (shared.text) onDraftChange([draft.trimEnd(), shared.text].filter(Boolean).join('\n\n'));
      const succeeded = shared.attachments.length === 0 || await uploadSources(shared.attachments);
      incomingShare.consumeSharedPayloads();
      if (!succeeded) setError('Some shared files could not be imported. Share them again to retry.');
    })();
  }, [draft, incomingShare, onDraftChange, uploadSources]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const sourcesFromFiles = (files: FileList | null): AttachmentSource[] => files
      ? Array.from(files).map((file) => ({
          uri: URL.createObjectURL(file), name: file.name, mimeType: file.type, size: file.size, file,
        }))
      : [];
    const onDrop = (event: DragEvent) => {
      const sources = sourcesFromFiles(event.dataTransfer?.files ?? null);
      if (!sources.length) return;
      event.preventDefault();
      void uploadSources(sources);
    };
    const onPaste = (event: ClipboardEvent) => {
      const sources = sourcesFromFiles(event.clipboardData?.files ?? null);
      if (!sources.length) return;
      event.preventDefault();
      void uploadSources(sources);
    };
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    document.addEventListener('drop', onDrop);
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragover', onDragOver);
    return () => {
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragover', onDragOver);
    };
  }, [uploadSources]);

  const chooseDocuments = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true, type: '*/*' });
    if (!result.canceled) {
      await uploadSources(result.assets.map((asset) => ({
        uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size, file: asset.file,
      })));
    }
  };
  const chooseImages = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError('Photo library access is required to attach an image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ allowsMultipleSelection: true, mediaTypes: ['images'], quality: 1 });
    if (!result.canceled) await uploadSources(result.assets.map(imageAssetSource));
  };
  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera access is required to take a photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
    if (!result.canceled) await uploadSources(result.assets.map(imageAssetSource));
  };
  const removeAttachment = async (attachment: ComposerAttachment) => {
    try {
      if (await onRemoveAttachment(attachment.id)) await deleteAttachmentUpload(connection, attachment.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove attachment');
    }
  };

  return (
    <>
      {suggestions.data?.items.length && token ? (
        <ScrollView keyboardShouldPersistTaps="handled" style={[styles.completions, { backgroundColor: colors.panelStrong, borderColor: colors.border }]}>
          {suggestions.data.items.slice(0, 12).map((item) => (
            <Pressable key={`${item.text}:${item.meta}`} onPress={() => onDraftChange(applyCompletion(draft, token, item.text))} style={styles.completionRow}>
              <ThemedText numberOfLines={1} type="smallBold">{item.display || item.text}</ThemedText>
              {item.meta ? <ThemedText numberOfLines={1} themeColor="textTertiary" type="small">{item.meta}</ThemedText> : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {attachments.length || uploads.length ? (
        <ScrollView horizontal contentContainerStyle={styles.attachmentList} keyboardShouldPersistTaps="handled">
          {attachments.map((attachment) => (
            <AttachmentChip
              detail={`${attachment.kind === 'image' ? 'Image' : 'File'} · ${formatBytes(attachment.size)}`}
              key={attachment.id}
              name={attachment.name}
              onRemove={() => void removeAttachment(attachment)}
            />
          ))}
          {uploads.map((upload) => (
            <AttachmentChip
              detail={upload.error ?? `Uploading ${Math.round(upload.progress * 100)}%`}
              key={upload.key}
              name={upload.name}
              onRemove={() => {
                upload.controller.abort();
                setUploads((current) => current.filter((item) => item.key !== upload.key));
              }}
              tone={upload.error ? 'danger' : 'normal'}
            />
          ))}
        </ScrollView>
      ) : null}

      {error || incomingShare.error ? (
        <View accessibilityRole="alert" style={[styles.error, { backgroundColor: colors.backgroundSelected }]}>
          <ThemedText style={{ color: colors.danger, flex: 1 }} type="small">
            {error || `Could not import shared content: ${incomingShare.error?.message}`}
          </ThemedText>
          <Pressable onPress={() => { setError(''); incomingShare.consumeSharedPayloads(); }}>
            <ThemedText style={{ color: colors.danger }} type="smallBold">Dismiss</ThemedText>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.toolbar}>
        <ToolbarAction label="Attach" onPress={() => setPickerOpen(true)} />
        <ToolbarAction label="Commands" onPress={() => setCommandsOpen(true)} />
        <ToolbarAction label="History" onPress={() => setHistoryOpen(true)} />
        <ToolbarAction disabled={!canUndo} label="Undo" onPress={onUndo} />
        <ToolbarAction disabled={!canRedo} label="Redo" onPress={onRedo} />
        {active ? <ToolbarAction disabled={!canSend} label="Redirect" onPress={() => onSend('redirect')} tone="warning" /> : null}
      </View>

      <View style={[styles.composer, { backgroundColor: colors.panelStrong, borderColor: colors.border }]}>
        <TextInput
          accessibilityLabel="Message Brio"
          maxLength={20000}
          multiline
          onChangeText={onDraftChange}
          placeholder={active ? 'Queue a follow-up or redirect this run…' : 'Message Brio…'}
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, { color: colors.text }]}
          textAlignVertical="top"
          value={draft}
        />
        <Pressable
          accessibilityLabel={active ? 'Queue message' : 'Send message'}
          disabled={!canSend}
          onPress={() => onSend('queue')}
          style={({ pressed }) => [styles.send, { backgroundColor: canSend ? colors.accent : colors.backgroundSelected, opacity: pressed ? 0.72 : 1 }]}>
          <ThemedText style={{ color: canSend ? colors.accentText : colors.textDisabled, fontSize: 20 }}>↑</ThemedText>
        </Pressable>
      </View>

      <PickerModal onClose={() => setPickerOpen(false)} onDocuments={() => void chooseDocuments()} onImages={() => void chooseImages()} onPhoto={() => void takePhoto()} visible={pickerOpen} />
      <HistoryModal history={history} onChoose={(text) => { onDraftChange(text); setHistoryOpen(false); }} onClose={() => setHistoryOpen(false)} visible={historyOpen} />
      <CommandModal catalog={commands.data} error={commands.error instanceof Error ? commands.error.message : ''} loading={commands.isLoading} onChoose={(command) => { onDraftChange(`${command} `); setCommandsOpen(false); }} onClose={() => setCommandsOpen(false)} visible={commandsOpen} />
    </>
  );
}

function AttachmentChip({ detail, name, onRemove, tone = 'normal' }: { detail: string; name: string; onRemove: () => void; tone?: 'normal' | 'danger' }) {
  const colors = useTheme();
  return (
    <View style={[styles.attachmentChip, { backgroundColor: colors.panel, borderColor: colors.border }]}>
      <View style={{ maxWidth: 180 }}>
        <ThemedText numberOfLines={1} type="smallBold">{name}</ThemedText>
        <ThemedText numberOfLines={1} style={tone === 'danger' ? { color: colors.danger } : undefined} themeColor={tone === 'danger' ? undefined : 'textTertiary'} type="small">{detail}</ThemedText>
      </View>
      <Pressable accessibilityLabel={`Remove ${name}`} onPress={onRemove}><ThemedText themeColor="textTertiary">×</ThemedText></Pressable>
    </View>
  );
}

function ToolbarAction({ disabled, label, onPress, tone = 'normal' }: { disabled?: boolean; label: string; onPress: () => void; tone?: 'normal' | 'warning' }) {
  const colors = useTheme();
  return (
    <Pressable accessibilityLabel={label} disabled={disabled} onPress={onPress}>
      <ThemedText style={{ color: tone === 'warning' ? colors.warning : colors.textSecondary, opacity: disabled ? 0.35 : 1 }} type="smallBold">{label}</ThemedText>
    </Pressable>
  );
}

function SheetModal({ children, onClose, title, visible }: { children: ReactNode; onClose: () => void; title: string; visible: boolean }) {
  const colors = useTheme();
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <Pressable onPress={onClose} style={styles.backdrop}>
        <Pressable onPress={(event) => event.stopPropagation()} style={[styles.modal, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.modalHeader}><ThemedText type="subtitle">{title}</ThemedText><Pressable onPress={onClose}><ThemedText>×</ThemedText></Pressable></View>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PickerModal({ onClose, onDocuments, onImages, onPhoto, visible }: { onClose: () => void; onDocuments: () => void; onImages: () => void; onPhoto: () => void; visible: boolean }) {
  return <SheetModal onClose={onClose} title="Attach context" visible={visible}><ModalAction label="Choose images" onPress={onImages} /><ModalAction label="Take a photo" onPress={onPhoto} /><ModalAction label="Choose files" onPress={onDocuments} /></SheetModal>;
}

function HistoryModal({ history, onChoose, onClose, visible }: { history: string[]; onChoose: (text: string) => void; onClose: () => void; visible: boolean }) {
  return (
    <SheetModal onClose={onClose} title="Prompt history" visible={visible}>
      {history.length === 0 ? <ThemedText themeColor="textTertiary">Sent prompts will appear here on this device.</ThemedText> : (
        <ScrollView style={styles.modalList}>{[...history].reverse().map((text, index) => <Pressable key={`${index}:${text}`} onPress={() => onChoose(text)} style={styles.historyRow}><ThemedText numberOfLines={4}>{text}</ThemedText></Pressable>)}</ScrollView>
      )}
    </SheetModal>
  );
}

function CommandModal({ catalog, error, loading, onChoose, onClose, visible }: { catalog?: CommandCatalog; error: string; loading: boolean; onChoose: (command: string) => void; onClose: () => void; visible: boolean }) {
  const colors = useTheme();
  const commands = useMemo(() => catalogCommands(catalog), [catalog]);
  return (
    <SheetModal onClose={onClose} title="Hermes commands" visible={visible}>
      {loading ? <ThemedText themeColor="textTertiary">Discovering commands from Hermes…</ThemedText> : error ? <ThemedText style={{ color: colors.danger }}>{error}</ThemedText> : commands.length === 0 ? <ThemedText themeColor="textTertiary">Hermes returned no commands for this profile.</ThemedText> : (
        <ScrollView style={styles.modalList}>{commands.map((command) => <Pressable key={command.name} onPress={() => onChoose(command.name)} style={styles.commandRow}><View style={{ flex: 1 }}><ThemedText type="smallBold">{command.name}</ThemedText><ThemedText themeColor="textTertiary" type="small">{command.description}</ThemedText></View><ThemedText style={{ color: command.permission === 'computer-exec' ? colors.warning : colors.accent }} type="small">{permissionLabel(command.permission)}</ThemedText></Pressable>)}</ScrollView>
      )}
    </SheetModal>
  );
}

function ModalAction({ label, onPress }: { label: string; onPress: () => void }) {
  const colors = useTheme();
  return <Pressable onPress={onPress} style={[styles.modalAction, { backgroundColor: colors.backgroundSelected }]}><ThemedText type="smallBold">{label}</ThemedText></Pressable>;
}

function catalogCommands(catalog?: CommandCatalog) {
  const commands: { name: string; description: string; permission: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, description = '', permission?: string) => {
    const normalized = name.startsWith('/') ? name : `/${name}`;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    commands.push({ name: normalized, description, permission: permission ?? catalog?.permissions?.[normalized] ?? catalog?.permissions?.[name] ?? (catalog?.skills?.[normalized] || catalog?.skills?.[name] ? 'agent-turn' : 'command') });
  };
  catalog?.pairs?.forEach(([name, description]) => add(name, description));
  catalog?.categories?.forEach((category) => category.pairs.forEach(([name, description]) => add(name, description)));
  catalog?.commands?.forEach((command) => add(command.name, command.description, command.permission));
  return commands;
}

function imageAssetSource(asset: ImagePicker.ImagePickerAsset): AttachmentSource {
  return { uri: asset.uri, name: asset.fileName || `photo_${Date.now()}.${asset.mimeType?.split('/')[1] || 'jpg'}`, mimeType: asset.mimeType, size: asset.fileSize, file: asset.file };
}

function permissionLabel(permission: string) {
  if (permission === 'computer-exec') return 'Computer';
  if (permission === 'agent-turn') return 'Agent';
  return 'Session';
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

const styles = StyleSheet.create({
  toolbar: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.three, paddingBottom: Spacing.two },
  composer: { alignItems: 'flex-end', borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: Spacing.two, minHeight: 58, padding: Spacing.two, paddingLeft: Spacing.three },
  input: { flex: 1, fontSize: 16, lineHeight: 23, maxHeight: 150, minHeight: 40, outlineStyle: 'none', paddingBottom: 8, paddingTop: 8 } as never,
  send: { alignItems: 'center', borderRadius: 13, height: 42, justifyContent: 'center', width: 42 },
  attachmentList: { gap: Spacing.two, paddingBottom: Spacing.two },
  attachmentChip: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: Spacing.two, paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
  completions: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: Spacing.two, maxHeight: 220 },
  completionRow: { gap: Spacing.one, minHeight: 42, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  error: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: Spacing.two, marginBottom: Spacing.two, padding: Spacing.two },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.5)', flex: 1, justifyContent: 'flex-end' },
  modal: { alignSelf: 'center', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, gap: Spacing.three, maxHeight: '82%', maxWidth: 680, padding: Spacing.four, width: '100%' },
  modalHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  modalList: { maxHeight: 460 },
  modalAction: { borderRadius: 10, minHeight: 46, paddingHorizontal: Spacing.three, paddingVertical: 12 },
  historyRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: Spacing.three },
  commandRow: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: Spacing.three, minHeight: 58, paddingVertical: Spacing.two },
});
