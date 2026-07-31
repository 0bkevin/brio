import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card, EmptyState } from '@/components/t3-ui';
import { T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  listFiles,
  readFile,
  writeFile,
  type AgentConnection,
  type HermesFileEntry,
} from '@/lib/brio';

export function HermesFilesScreen({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const [path, setPath] = useState<string | undefined>();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const files = useQuery({
    queryKey: ['files', connection.id, path ?? 'root'],
    queryFn: () => listFiles(connection, path),
  });
  const entries = [...(files.data?.entries ?? [])].sort((left, right) => {
    if (left.dir !== right.dir) return left.dir ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  const currentPath = files.data?.path ?? path;

  if (selectedFile) {
    return (
      <FileEditor
        connection={connection}
        onClose={() => setSelectedFile(null)}
        path={selectedFile}
      />
    );
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <View style={[styles.pathBar, { borderBottomColor: colors.border }]}>
        <Pressable
          accessibilityLabel="Go to parent folder"
          disabled={!currentPath}
          onPress={() => setPath(parentPath(currentPath))}
          style={({ pressed }) => [styles.upButton, { opacity: pressed ? 0.5 : currentPath ? 1 : 0.35 }]}>
          <SymbolView name="arrow.up" size={17} tintColor={colors.foreground} />
        </Pressable>
        <AppText numberOfLines={1} style={[styles.path, { color: colors.muted }]}>
          {currentPath ?? 'Workspace'}
        </AppText>
      </View>

      {files.isLoading ? (
        <EmptyState detail="Reading the workspace from your Hermes machine." loading title="Loading files" />
      ) : files.isError ? (
        <EmptyState
          action={<Button onPress={() => void files.refetch()}>Try again</Button>}
          detail={files.error instanceof Error ? files.error.message : 'The folder could not be read.'}
          title="Folder unavailable"
        />
      ) : entries.length === 0 ? (
        <EmptyState detail="This folder does not contain any files." title="Empty folder" />
      ) : (
        <ScrollView contentContainerStyle={styles.fileList}>
          <Card style={styles.fileCard}>
            {entries.map((entry, index) => (
              <View key={entry.path}>
                {index > 0 ? <View style={[styles.divider, { backgroundColor: colors.separator }]} /> : null}
                <FileRow
                  entry={entry}
                  onPress={() => (entry.dir ? setPath(entry.path) : setSelectedFile(entry.path))}
                />
              </View>
            ))}
          </Card>
          {files.data?.roots && files.data.roots.length > 1 ? (
            <View style={styles.roots}>
              <AppText style={[styles.rootsLabel, { color: colors.muted }]}>Allowed roots</AppText>
              {files.data.roots.map((root) => (
                <Pressable key={root} onPress={() => setPath(root)}>
                  <AppText numberOfLines={1} style={[styles.rootLink, { color: colors.userBubble }]}>
                    {root}
                  </AppText>
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function FileRow({ entry, onPress }: { entry: HermesFileEntry; onPress: () => void }) {
  const colors = useT3Theme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.fileRow, { opacity: pressed ? 0.55 : 1 }]}>
      <SymbolView
        name={entry.dir ? 'folder' : 'doc.text'}
        size={19}
        tintColor={entry.dir ? colors.warning : colors.secondary}
      />
      <View style={styles.fileCopy}>
        <AppText numberOfLines={1} style={styles.fileName}>
          {entry.name}
        </AppText>
        {!entry.dir ? (
          <AppText style={[styles.fileSize, { color: colors.tertiary }]}>{formatBytes(entry.size)}</AppText>
        ) : null}
      </View>
      <AppText style={{ color: colors.tertiary }}>›</AppText>
    </Pressable>
  );
}

function FileEditor({
  connection,
  onClose,
  path,
}: {
  connection: AgentConnection;
  onClose: () => void;
  path: string;
}) {
  const colors = useT3Theme();
  const file = useQuery({
    queryKey: ['file', connection.id, path],
    queryFn: () => readFile(connection, path),
  });
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <View style={[styles.editorHeader, { borderBottomColor: colors.border }]}>
        <Button onPress={onClose} tone="plain">Back</Button>
        <View style={styles.editorTitle}>
          <AppText numberOfLines={1} style={styles.fileName}>{basename(path)}</AppText>
          <AppText numberOfLines={1} style={[styles.fileSize, { color: colors.tertiary }]}>{path}</AppText>
        </View>
        <View style={styles.headerActionSpacer} />
      </View>
      {file.isLoading ? (
        <EmptyState detail="Reading file contents." loading title="Opening file" />
      ) : file.isError ? (
        <EmptyState detail={file.error instanceof Error ? file.error.message : 'The file could not be read.'} title="File unavailable" />
      ) : file.data ? (
        <LoadedFileEditor connection={connection} initialContent={file.data.content} path={path} />
      ) : null}
    </SafeAreaView>
  );
}

function LoadedFileEditor({
  connection,
  initialContent,
  path,
}: {
  connection: AgentConnection;
  initialContent: string;
  path: string;
}) {
  const colors = useT3Theme();
  const queryClient = useQueryClient();
  const [content, setContent] = useState(initialContent);
  const dirty = content !== initialContent;
  const save = useMutation({
    mutationFn: () => writeFile(connection, path, content),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['file', connection.id, path] }),
  });

  return (
    <>
      <AppTextInput
        accessibilityLabel="File contents"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        onChangeText={setContent}
        spellCheck={false}
        style={[styles.editor, { backgroundColor: colors.screen, borderColor: 'transparent' }]}
        textAlignVertical="top"
        value={content}
      />
      <View style={[styles.saveBar, { borderTopColor: colors.border }]}>
        {save.isError ? (
          <AppText numberOfLines={1} style={[styles.saveMessage, { color: colors.danger }]}>
            {save.error instanceof Error ? save.error.message : 'The file could not be saved.'}
          </AppText>
        ) : (
          <AppText style={[styles.saveMessage, { color: colors.muted }]}>
            {save.isSuccess ? 'Saved' : dirty ? 'Unsaved changes' : 'No changes'}
          </AppText>
        )}
        <Button disabled={!dirty} loading={save.isPending} onPress={() => save.mutate()}>
          Save
        </Button>
      </View>
    </>
  );
}

function parentPath(path?: string) {
  if (!path) return undefined;
  const separator = path.includes('\\') ? '\\' : '/';
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = trimmed.lastIndexOf(separator);
  if (index <= 0) return undefined;
  return trimmed.slice(0, index);
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  pathBar: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: T3Spacing.sm,
    paddingHorizontal: T3Spacing.lg,
    paddingVertical: T3Spacing.sm,
  },
  upButton: { alignItems: 'center', height: 38, justifyContent: 'center', width: 38 },
  path: { flex: 1, fontFamily: T3Typography.mono, fontSize: 12, lineHeight: 17 },
  fileList: {
    alignSelf: 'center',
    gap: T3Spacing.xxl,
    maxWidth: 840,
    padding: T3Spacing.xl,
    width: '100%',
  },
  fileCard: { paddingHorizontal: T3Spacing.lg },
  fileRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: T3Spacing.md,
    minHeight: 58,
    paddingVertical: T3Spacing.sm,
  },
  fileCopy: { flex: 1 },
  fileName: { fontFamily: T3Typography.medium, fontSize: 15, lineHeight: 20 },
  fileSize: { fontSize: 11, lineHeight: 15 },
  divider: { height: StyleSheet.hairlineWidth },
  roots: { gap: T3Spacing.sm, paddingHorizontal: T3Spacing.xs },
  rootsLabel: { fontFamily: T3Typography.medium, fontSize: 12, textTransform: 'uppercase' },
  rootLink: { fontSize: 13, lineHeight: 18 },
  editorHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 58,
    paddingHorizontal: T3Spacing.sm,
  },
  editorTitle: { alignItems: 'center', flex: 1 },
  headerActionSpacer: { width: 70 },
  editor: {
    borderRadius: 0,
    flex: 1,
    fontFamily: T3Typography.mono,
    fontSize: 13,
    lineHeight: 20,
    padding: T3Spacing.lg,
  },
  saveBar: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: T3Spacing.md,
    padding: T3Spacing.md,
  },
  saveMessage: { flex: 1, fontSize: 13, lineHeight: 17 },
});
