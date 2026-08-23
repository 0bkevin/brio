export type CompletionToken = {
  kind: 'context' | 'command';
  query: string;
  start: number;
  end: number;
};

export type SharedPayloadInput = {
  value: string;
  shareType: 'text' | 'url' | 'audio' | 'image' | 'video' | 'file';
  mimeType?: string;
  contentUri?: string | null;
  contentMimeType?: string | null;
  contentSize?: number | null;
  originalName?: string | null;
};

export type SharedAttachmentInput = {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
};

export function completionToken(text: string): CompletionToken | null {
  if (!text) return null;
  if (text.startsWith('/') && !text.includes('\n')) {
    return { kind: 'command', query: text, start: 0, end: text.length };
  }
  const match = text.match(/(?:^|\s)(@[^\s]*)$/);
  if (!match?.[1]) return null;
  const start = text.length - match[1].length;
  return { kind: 'context', query: match[1], start, end: text.length };
}

export function applyCompletion(text: string, token: CompletionToken, completion: string) {
  const suffix = completion.endsWith(':') || completion.endsWith('/') ? '' : ' ';
  return `${text.slice(0, token.start)}${completion}${suffix}${text.slice(token.end)}`;
}

export function commandParts(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.slice(1).match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  return { name: `/${match[1]}`, argument: match[2]?.trim() ?? '' };
}

export function composerContentFromSharedPayloads(payloads: SharedPayloadInput[]) {
  const text: string[] = [];
  const attachments: SharedAttachmentInput[] = [];
  payloads.forEach((payload, index) => {
    if (payload.shareType === 'text') {
      if (payload.value.trim()) text.push(payload.value.trim());
      return;
    }
    if (payload.shareType === 'url') {
      if (payload.value.trim()) text.push(`@url:${payload.value.trim()}`);
      return;
    }
    const uri = payload.contentUri || payload.value;
    if (!uri) return;
    attachments.push({
      uri,
      name: payload.originalName || sharedAttachmentName(uri, payload.mimeType, index),
      mimeType: payload.contentMimeType || payload.mimeType,
      size: payload.contentSize,
    });
  });
  return { text: text.join('\n'), attachments };
}

function sharedAttachmentName(uri: string, mimeType: string | undefined, index: number) {
  const rawName = uri.split(/[\\/]/).pop()?.split(/[?#]/)[0];
  if (rawName) {
    try {
      return decodeURIComponent(rawName);
    } catch {
      return rawName;
    }
  }
  const extension = mimeType?.split('/')[1]?.replace(/[^a-zA-Z0-9.+-]/g, '') || 'bin';
  return `shared_${index + 1}.${extension}`;
}
