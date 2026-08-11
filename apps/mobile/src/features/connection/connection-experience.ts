export type ConnectionIssue = {
  title: string;
  detail: string;
  checklist?: string[];
};

export function validateManualConnection(host: string, code: string): ConnectionIssue | null {
  const normalizedHost = normalizeHostForValidation(host);
  if (!normalizedHost || !code.trim()) {
    return {
      title: 'A little more information is needed',
      detail: 'Enter both the computer address and the pairing code.',
    };
  }
  try {
    const parsed = new URL(normalizedHost);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch {
    return {
      title: 'Check the computer address',
      detail: 'Use an address like 192.168.1.100:8787 or https://brio.example.com.',
    };
  }
  return null;
}

function normalizeHostForValidation(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed || /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;
  const host = trimmed.split('/')[0]?.split(':')[0] ?? '';
  const local =
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    trimmed.startsWith('[');
  return `${local ? 'http' : 'https'}://${trimmed}`;
}

export function explainConnectionError(reason: unknown): ConnectionIssue {
  const raw = reason instanceof Error ? reason.message : 'The connection could not be completed.';
  const message = raw.toLowerCase();

  if (message.includes('cancel')) {
    return {
      title: 'Connection cancelled',
      detail: 'Your details are still here whenever you are ready to try again.',
    };
  }
  if (message.includes('hermes agent') || message.includes('hermes_ok')) {
    return {
      title: 'Brio is ready, but Hermes is offline',
      detail: 'The connection bridge answered, but Hermes Agent did not.',
      checklist: ['Start or restart Hermes Agent', 'Keep Brio Companion running', 'Try again'],
    };
  }
  if (message.includes('unauthorized') || message.includes('401') || message.includes('token')) {
    return {
      title: 'That pairing code was rejected',
      detail: 'Pairing codes are temporary. Create a fresh one on your computer and try again.',
      checklist: ['Run `brio companion pair` again', 'Scan or paste the new code'],
    };
  }
  if (message.includes('expired') || message.includes('claim') || message.includes('not found')) {
    return {
      title: 'That connection code has expired',
      detail: 'Create a fresh code on your computer, then scan or paste it here.',
      checklist: ['Run `brio companion pair` again', 'Use the new code within 10 minutes'],
    };
  }
  if (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('timed out') ||
    message.includes('abort') ||
    message.includes('socket') ||
    message.includes('reach')
  ) {
    return {
      title: 'We could not reach your computer',
      detail: 'Nothing was saved. Check these common causes, then retry.',
      checklist: [
        'Keep Brio Companion running',
        'Use the same Wi-Fi network for a local connection',
        'Allow Brio through your computer firewall',
      ],
    };
  }
  return {
    title: 'We could not finish connecting',
    detail: raw.length <= 160 ? raw : 'Check Brio on your computer, then try again.',
    checklist: ['Keep Brio Companion running', 'Create a fresh connection code', 'Try again'],
  };
}

export function friendlyPayloadError(message: string) {
  if (message.toLowerCase().includes('empty')) {
    return 'Copy the full code shown by `brio companion pair`, then try again.';
  }
  if (message.toLowerCase().includes('not ready')) return message;
  return 'Use the QR code or full connection code shown by `brio companion pair`.';
}
