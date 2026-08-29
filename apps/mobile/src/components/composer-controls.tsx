import { useQuery } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useIsFocused } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from 'react-native-reanimated';

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
import {
  abortSpeechRecognition,
  claimSpeechRecognition,
  isSpeechRecognitionAvailable,
  ownsSpeechRecognition,
  releaseSpeechRecognitionBeforeStart,
  requestSpeechRecognitionPermissions,
  startSpeechRecognition,
  stopSpeechRecognition,
} from '@/lib/speech-recognition-controller';
import {
  appendSpeechTranscript,
  mergeSpeechSegment,
  normalizeSpeechRecognitionLocale,
  speechRecognitionErrorMessage,
} from '@/lib/speech-recognition-model';
import type { ComposerAttachment, PromptDeliveryMode } from '@/state/composer-store-model';

type UploadState = {
  key: string;
  name: string;
  progress: number;
  controller: AbortController;
  error?: string;
};

type SpeechState = 'idle' | 'starting' | 'listening' | 'stopping';

const COMPOSER_MOTION = {
  duration: 230,
  easing: Easing.bezier(0.2, 0, 0, 1),
};
const FOOTER_ENTER = FadeIn.duration(140).delay(80).easing(Easing.out(Easing.cubic));
const FOOTER_EXIT = FadeOut.duration(70).easing(Easing.in(Easing.quad));

export function ComposerControls({
  active,
  attachments,
  canRedo,
  canUndo,
  connection,
  draft,
  history,
  hydrated,
  keyboardVisible,
  forceExpanded = false,
  visible = true,
  modelControl,
  onAddAttachment,
  onDraftChange,
  onRedo,
  onRemoveAttachment,
  onSend,
  onUndo,
  profile,
  sendDisabled = false,
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
  keyboardVisible?: boolean;
  forceExpanded?: boolean;
  visible?: boolean;
  modelControl?: ReactNode;
  onAddAttachment: (attachment: ComposerAttachment) => Promise<void>;
  onDraftChange: (text: string) => void;
  onRedo: () => void;
  onRemoveAttachment: (attachmentId: string) => Promise<boolean>;
  onSend: (mode: PromptDeliveryMode) => void;
  onUndo: () => void;
  profile: string;
  sendDisabled?: boolean;
  sessionId: string;
}) {
  const colors = useTheme();
  const incomingShare = useIncomingShareContext();
  const isFocused = useIsFocused();
  const processedShare = useRef<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  const previousKeyboardVisible = useRef(keyboardVisible);
  const speechBaseDraft = useRef('');
  const committedSpeech = useRef('');
  const speechOwner = useRef(Symbol('composer-speech-owner'));
  const speechRequest = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState(42);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [error, setError] = useState('');
  const [speechState, setSpeechState] = useState<SpeechState>('idle');
  const token = completionToken(draft);

  const capabilities = useQuery({
    queryKey: ['composer-capabilities', connection.id, connection.url, profile],
    queryFn: () => getComposerCapabilities(connection, profile),
    staleTime: 5 * 60_000,
  });
  const suggestions = useQuery({
    queryKey: ['composer-completion', connection.id, profile, token?.kind, token?.query],
    queryFn: () =>
      token?.kind === 'command'
        ? completeSlashCommand(connection, token.query, profile)
        : completeContextReference(connection, token?.query ?? '', profile),
    enabled: Boolean(token),
    staleTime: 15_000,
  });
  const commands = useQuery({
    queryKey: ['composer-commands', connection.id, profile],
    queryFn: () => getCommandCatalog(connection, profile),
    enabled: commandsOpen,
    staleTime: 60_000,
  });
  const speechActive = speechState !== 'idle';
  const hasPrompt = Boolean(draft.trim()) || attachments.length > 0;
  const canSend =
    hydrated &&
    !sendDisabled &&
    hasPrompt &&
    uploads.length === 0 &&
    !speechActive;
  const expanded =
    forceExpanded ||
    inputFocused ||
    pickerOpen ||
    historyOpen ||
    commandsOpen ||
    speechActive ||
    attachments.length > 0 ||
    uploads.length > 0 ||
    Boolean(error) ||
    Boolean(incomingShare.error);
  const expansionProgress = useDerivedValue(
    () => withTiming(expanded ? 1 : 0, COMPOSER_MOTION),
    [expanded],
  );
  const expandedComposerHeight = Math.max(98, inputHeight + 54);
  const composerHeight = useDerivedValue(
    () => withTiming(expanded ? expandedComposerHeight : 52, COMPOSER_MOTION),
    [expanded, expandedComposerHeight],
  );
  const composerAnimatedStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(expansionProgress.value, [0, 1], [26, 24]),
    height: composerHeight.value,
    paddingBottom: interpolate(expansionProgress.value, [0, 1], [4, 5]),
    paddingHorizontal: interpolate(expansionProgress.value, [0, 1], [4, 12]),
    paddingTop: interpolate(expansionProgress.value, [0, 1], [4, 9]),
  }));
  const compactLeftStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expansionProgress.value, [0, 0.35, 1], [1, 0, 0]),
    width: interpolate(expansionProgress.value, [0, 1], [41, 0]),
  }));
  const compactRightStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expansionProgress.value, [0, 0.35, 1], [1, 0, 0]),
    width: interpolate(expansionProgress.value, [0, 1], [45, 0]),
  }));

  useEffect(() => {
    const previous = previousKeyboardVisible.current;
    previousKeyboardVisible.current = keyboardVisible;
    if (previous !== true || keyboardVisible !== false || !inputFocused) return;
    const timer = setTimeout(() => {
      inputRef.current?.blur();
      setInputFocused(false);
    }, Platform.OS === 'android' ? 180 : 0);
    return () => clearTimeout(timer);
  }, [inputFocused, keyboardVisible]);

  useEffect(() => {
    if (isFocused) return;
    speechRequest.current += 1;
    abortSpeechRecognition(speechOwner.current);
    if (!ownsSpeechRecognition(speechOwner.current)) setSpeechState('idle');
  }, [isFocused]);

  useEffect(() => {
    if (visible) return;
    speechRequest.current += 1;
    abortSpeechRecognition(speechOwner.current);
    if (!ownsSpeechRecognition(speechOwner.current)) setSpeechState('idle');
  }, [visible]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      // iOS permission sheets can transiently report `inactive`; only a real
      // background transition should cancel the permission/start sequence.
      if (state !== 'background') return;
      speechRequest.current += 1;
      abortSpeechRecognition(speechOwner.current);
      if (!ownsSpeechRecognition(speechOwner.current)) setSpeechState('idle');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    speechRequest.current += 1;
    abortSpeechRecognition(speechOwner.current);
  }, [connection.id, profile, sessionId]);

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
          profile,
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
  }, [attachments, capabilities.data, connection, onAddAttachment, profile, sessionId]);

  useEffect(() => {
    if (speechActive || incomingShare.isResolving || incomingShare.error || incomingShare.sharedPayloads.length === 0) return;
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
  }, [draft, incomingShare, onDraftChange, speechActive, uploadSources]);

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
      if (await onRemoveAttachment(attachment.id)) {
        await deleteAttachmentUpload(connection, attachment.id, profile);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove attachment');
    }
  };
  const setFocused = (focused: boolean) => {
    if (focused === inputFocused) return;
    setInputFocused(focused);
  };
  const startSpeech = async () => {
    const owner = speechOwner.current;
    const request = ++speechRequest.current;
    setError('');
    inputRef.current?.blur();
    setInputFocused(false);
    setSpeechState('starting');
    try {
      if (!isSpeechRecognitionAvailable()) {
        setError('Speech recognition is not available on this device or browser.');
        setSpeechState('idle');
        return;
      }
      const permission = await requestSpeechRecognitionPermissions();
      if (request !== speechRequest.current) return;
      if (!permission.granted) {
        setError('Microphone and speech recognition access are required. Enable them in device settings.');
        setSpeechState('idle');
        return;
      }
      if (AppState.currentState !== 'active' || !visible || !isFocused) {
        setSpeechState('idle');
        return;
      }
      const claimed = claimSpeechRecognition(owner, {
        onStart: () => setSpeechState('listening'),
        onResult: (event) => {
          const segment = event.results[0]?.transcript ?? '';
          if (!segment.trim()) return;
          if (event.isFinal) committedSpeech.current = mergeSpeechSegment(committedSpeech.current, segment);
          const transcript = event.isFinal
            ? committedSpeech.current
            : mergeSpeechSegment(committedSpeech.current, segment);
          onDraftChange(appendSpeechTranscript(speechBaseDraft.current, transcript));
        },
        onNoMatch: () => setError("I didn't hear any speech. Tap the mic and try again."),
        onError: (event) => {
          const message = speechRecognitionErrorMessage(event.error);
          if (message) setError(message);
          setSpeechState('stopping');
        },
        onEnd: () => setSpeechState('idle'),
      });
      if (!claimed) {
        setError('Dictation is already active in another composer.');
        setSpeechState('idle');
        return;
      }
      speechBaseDraft.current = draft;
      committedSpeech.current = '';
      startSpeechRecognition(owner, {
        addsPunctuation: true,
        continuous: false,
        interimResults: true,
        lang: normalizeSpeechRecognitionLocale(Intl.DateTimeFormat().resolvedOptions().locale),
        maxAlternatives: 1,
      });
    } catch (reason) {
      releaseSpeechRecognitionBeforeStart(owner);
      setSpeechState('idle');
      setError(reason instanceof Error ? reason.message : 'Could not start speech recognition.');
    }
  };
  const stopSpeech = () => {
    if (speechState === 'starting') {
      speechRequest.current += 1;
      abortSpeechRecognition(speechOwner.current);
      if (!ownsSpeechRecognition(speechOwner.current)) setSpeechState('idle');
      return;
    }
    if (speechState === 'stopping') {
      abortSpeechRecognition(speechOwner.current);
      return;
    }
    setSpeechState('stopping');
    stopSpeechRecognition(speechOwner.current);
  };

  return (
    <>
      {!speechActive && suggestions.data?.items.length && token ? (
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

      <Animated.View
        style={[
          styles.composer,
          composerAnimatedStyle,
          { backgroundColor: colors.panelStrong, borderColor: colors.border },
        ]}>
        <View style={styles.composerInputRow}>
          <Animated.View
            pointerEvents={expanded ? 'none' : 'auto'}
            style={[styles.compactLeftSlot, compactLeftStyle]}>
            <Pressable
              accessibilityElementsHidden={expanded}
              accessibilityLabel="Attach context"
              accessible={!expanded}
              hitSlop={4}
              onPress={() => setPickerOpen(true)}
              style={({ pressed }) => [styles.compactControlPressable, { opacity: pressed ? 0.65 : 1 }]}>
              <ThemedText style={styles.compactAttachLabel} themeColor="textSecondary">+</ThemedText>
            </Pressable>
          </Animated.View>
          <TextInput
            accessibilityLabel="Ask Hermes anything"
            editable={!speechActive}
            maxLength={20000}
            multiline
            onBlur={() => {
              if (Platform.OS === 'android' && keyboardVisible) return;
              setFocused(false);
            }}
            onChangeText={onDraftChange}
            onContentSizeChange={(event) => {
              const nativeHeight = event.nativeEvent.contentSize.height;
              const measuredHeight = Platform.OS === 'android' ? nativeHeight - 32 : nativeHeight;
              const nextHeight = Math.min(96, Math.max(42, Math.ceil(measuredHeight)));
              setInputHeight(nextHeight);
            }}
            onFocus={() => setFocused(true)}
            placeholder={speechActive ? 'Listening…' : active ? 'Ask a follow-up…' : 'Ask Hermes anything…'}
            placeholderTextColor={colors.textTertiary}
            ref={inputRef}
            scrollEnabled={expanded && inputHeight >= 96}
            selectionColor={colors.accent}
            style={[
              styles.input,
              expanded ? styles.inputExpanded : styles.inputCollapsed,
              expanded ? { height: inputHeight } : null,
              { color: colors.text },
            ]}
            textAlignVertical={expanded ? 'top' : 'center'}
            value={draft}
          />
          <Animated.View
            pointerEvents={expanded ? 'none' : 'auto'}
            style={[styles.compactRightSlot, compactRightStyle]}>
            {!hasPrompt && uploads.length === 0 ? (
              <VoiceAction compact hidden={expanded} onPress={() => void startSpeech()} state={speechState} />
            ) : (
              <Pressable
                accessibilityElementsHidden={expanded}
                accessibilityLabel={active ? 'Queue message' : 'Send message'}
                accessible={!expanded}
                disabled={!canSend}
                onPress={() => onSend('queue')}
                style={({ pressed }) => [
                  styles.sendPressable,
                  {
                    backgroundColor: canSend ? colors.accent : colors.backgroundSelected,
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}>
                <ThemedText
                  style={{ color: canSend ? colors.accentText : colors.textDisabled, fontSize: 20 }}>
                  ↑
                </ThemedText>
              </Pressable>
            )}
          </Animated.View>
        </View>
        {expanded ? (
          <Animated.View entering={FOOTER_ENTER} exiting={FOOTER_EXIT} style={styles.composerFooter}>
            <ScrollView
              contentContainerStyle={styles.toolbar}
              horizontal
              keyboardShouldPersistTaps="handled"
              style={styles.toolbarScroller}
              showsHorizontalScrollIndicator={false}>
              <ToolbarAction bare disabled={speechActive} label="+" accessibilityLabel="Attach context" onPress={() => setPickerOpen(true)} />
              <VoiceAction
                onPress={speechActive ? stopSpeech : () => void startSpeech()}
                state={speechState}
              />
              {speechActive ? null : modelControl}
              <ToolbarAction disabled={speechActive} accessibilityLabel="Commands" label="/" onPress={() => setCommandsOpen(true)} />
              {history.length > 0 ? <ToolbarAction disabled={speechActive} accessibilityLabel="Prompt history" label="↶" onPress={() => setHistoryOpen(true)} /> : null}
              {canUndo ? <ToolbarAction disabled={speechActive} label="Undo" onPress={onUndo} /> : null}
              {canRedo ? <ToolbarAction disabled={speechActive} label="Redo" onPress={onRedo} /> : null}
              {active ? <ToolbarAction disabled={!canSend} label="Redirect" onPress={() => onSend('redirect')} tone="warning" /> : null}
            </ScrollView>
            <Pressable
              accessibilityLabel={active ? 'Queue message' : 'Send message'}
              disabled={!canSend}
              onPress={() => onSend('queue')}
              style={({ pressed }) => [styles.send, { backgroundColor: canSend ? colors.accent : colors.backgroundSelected, opacity: pressed ? 0.72 : 1 }]}>
              <ThemedText style={{ color: canSend ? colors.accentText : colors.textDisabled, fontSize: 20 }}>↑</ThemedText>
            </Pressable>
          </Animated.View>
        ) : null}
      </Animated.View>

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

function VoiceAction({
  compact = false,
  hidden = false,
  onPress,
  state,
}: {
  compact?: boolean;
  hidden?: boolean;
  onPress: () => void;
  state: SpeechState;
}) {
  const colors = useTheme();
  const active = state !== 'idle';
  const label = state === 'starting'
    ? 'Starting dictation'
    : state === 'stopping'
      ? 'Force stop dictation'
      : state === 'listening'
        ? 'Stop dictation'
        : 'Dictate prompt';
  const symbol = active
    ? ({ ios: 'stop.fill', android: 'stop', web: 'stop' } as const)
    : ({ ios: 'mic.fill', android: 'mic_none', web: 'mic_none' } as const);

  return (
    <Pressable
      accessibilityElementsHidden={hidden}
      accessibilityLabel={label}
      accessible={!hidden}
      onPress={onPress}
      style={({ pressed }) => [
        compact ? styles.sendPressable : styles.voiceAction,
        {
          backgroundColor: active ? colors.danger : colors.backgroundSelected,
          opacity: state === 'stopping' ? 0.72 : pressed ? 0.62 : 1,
        },
      ]}>
      <SymbolView
        fallback={<ThemedText style={{ color: active ? '#fff' : colors.textSecondary }} type="smallBold">Mic</ThemedText>}
        name={symbol}
        size={compact ? 20 : 18}
        tintColor={active ? '#fff' : colors.textSecondary}
      />
      {!compact && active ? (
        <ThemedText style={{ color: '#fff' }} type="smallBold">
          {state === 'stopping' ? 'Finishing…' : state === 'starting' ? 'Starting…' : 'Listening…'}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

function ToolbarAction({ accessibilityLabel, bare = false, disabled, label, onPress, tone = 'normal' }: { accessibilityLabel?: string; bare?: boolean; disabled?: boolean; label: string; onPress: () => void; tone?: 'normal' | 'warning' }) {
  const colors = useTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      hitSlop={bare ? 4 : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolbarAction,
        bare ? styles.toolbarActionBare : null,
        {
          backgroundColor: bare ? 'transparent' : colors.backgroundSelected,
          opacity: disabled ? 0.35 : pressed ? 0.6 : 1,
        },
      ]}>
      <ThemedText
        style={[
          { color: tone === 'warning' ? colors.warning : colors.textSecondary },
          bare ? styles.toolbarActionBareLabel : null,
        ]}
        type="smallBold">
        {label}
      </ThemedText>
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
  toolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    flexGrow: 1,
    gap: Spacing.two,
    justifyContent: 'space-between',
    paddingRight: Spacing.two,
  },
  toolbarScroller: { flex: 1 },
  toolbarAction: {
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: 11,
  },
  toolbarActionBare: { alignItems: 'center', minWidth: 36, paddingHorizontal: 0 },
  toolbarActionBareLabel: { fontSize: 27, fontWeight: '300', lineHeight: 29 },
  composer: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  composerInputRow: { alignItems: 'center', flexDirection: 'row', minHeight: 42 },
  input: { fontSize: 16, lineHeight: 23, outlineStyle: 'none' } as never,
  inputCollapsed: { flex: 1, height: 42, paddingBottom: 3, paddingHorizontal: 4, paddingTop: 3 },
  inputExpanded: { flex: 1, maxHeight: 96, minHeight: 42, paddingHorizontal: 4, paddingVertical: 3 },
  composerFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 40,
  },
  send: { alignItems: 'center', borderRadius: 20, height: 40, justifyContent: 'center', width: 40 },
  sendPressable: { alignItems: 'center', borderRadius: 20, height: 40, justifyContent: 'center', width: 40 },
  voiceAction: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 34,
    minWidth: 38,
    paddingHorizontal: 10,
  },
  compactLeftSlot: { height: 40, justifyContent: 'center', overflow: 'hidden' },
  compactRightSlot: { alignItems: 'flex-end', height: 40, justifyContent: 'center', overflow: 'hidden' },
  compactControlPressable: { alignItems: 'center', height: 40, justifyContent: 'center', width: 36 },
  compactAttachLabel: { fontSize: 27, fontWeight: '300', lineHeight: 30 },
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
