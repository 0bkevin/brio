import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import {
  createAttachmentUpload,
  deleteAttachmentUpload,
  uploadAttachmentChunk,
  type AgentConnection,
} from '@/lib/brio';
import type { ComposerAttachment } from '@/state/composer-store-model';

// 96 KiB encodes to exactly 128 KiB of base64, matching the connector limit
// without ever loading the complete attachment into JavaScript memory.
const CHUNK_BYTES = 96 * 1024;

export type AttachmentSource = {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  file?: Blob | null;
};

export async function uploadComposerAttachment(
  connection: AgentConnection,
  sessionId: string,
  source: AttachmentSource,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<ComposerAttachment> {
  throwIfAborted(signal);
  onProgress(0.05);
  const sourceInfo = await attachmentSourceInfo(source);
  throwIfAborted(signal);
  onProgress(0.15);

  const created = await createAttachmentUpload(
    connection,
    {
      sessionId,
      name: source.name,
      mimeType: source.mimeType || 'application/octet-stream',
      size: sourceInfo.size,
    },
    signal,
  );

  try {
    let current = created;
    const chunks = Math.ceil(sourceInfo.size / CHUNK_BYTES);
    for (let index = 0; index < chunks; index += 1) {
      throwIfAborted(signal);
      const position = index * CHUNK_BYTES;
      const length = Math.min(CHUNK_BYTES, sourceInfo.size - position);
      const chunk = await readBase64Chunk(source, sourceInfo.blob, position, length);
      throwIfAborted(signal);
      current = await uploadAttachmentChunk(
        connection,
        created.id,
        index,
        chunk,
        index === chunks - 1,
        signal,
      );
      onProgress(0.15 + (0.85 * (index + 1)) / chunks);
    }
    if (!current.complete || !current.sha256) {
      throw new Error('Attachment upload did not finish');
    }
    return {
      id: current.id,
      name: current.name,
      mimeType: current.mime_type,
      kind: current.kind,
      size: current.size,
      sha256: current.sha256,
    };
  } catch (error) {
    await deleteAttachmentUpload(connection, created.id).catch(() => undefined);
    throw error;
  }
}

async function attachmentSourceInfo(
  source: AttachmentSource,
): Promise<{ size: number; blob: Blob | null }> {
  if (Platform.OS === 'web') {
    const blob = source.file ?? await fetch(source.uri).then((response) => response.blob());
    if (!blob || !blob.size) throw new Error('Attachment is empty');
    return { size: blob.size, blob };
  }
  if (source.size && source.size > 0) return { size: source.size, blob: null };
  const info = await FileSystem.getInfoAsync(source.uri);
  if (!info.exists || info.isDirectory || !info.size) throw new Error('Could not read attachment size');
  return { size: info.size, blob: null };
}

async function readBase64Chunk(
  source: AttachmentSource,
  blob: Blob | null,
  position: number,
  length: number,
) {
  if (Platform.OS !== 'web') {
    return FileSystem.readAsStringAsync(source.uri, {
      encoding: FileSystem.EncodingType.Base64,
      position,
      length,
    });
  }
  if (!blob) throw new Error('Could not read attachment');
  return blobToBase64(blob.slice(position, position + length));
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment'));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      const comma = value.indexOf(',');
      if (comma < 0) reject(new Error('Could not encode attachment'));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Attachment upload cancelled');
}
