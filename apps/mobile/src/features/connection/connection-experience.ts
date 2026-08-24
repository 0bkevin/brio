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
      detail: 'Enter both the computer address and access token.',
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
  const hostPort = trimmed.split('/')[0] ?? '';
  const host = hostPort.startsWith('[')
    ? hostPort.slice(1, hostPort.indexOf(']'))
    : (hostPort.split(':')[0] ?? '');
  const local =
    host === 'localhost' ||
    host.endsWith('.local') ||
    isPrivateNetworkAddress(host);
  return `${local ? 'http' : 'https'}://${trimmed}`;
}

function isPrivateNetworkAddress(host: string) {
  if (host.includes(':')) {
    const normalized = host.toLowerCase();
    return normalized === '::1' || /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized);
  }
  const octets = host.split('.');
  if (
    octets.length !== 4 ||
    !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  ) {
    return false;
  }
  const [first, second] = octets.map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
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
  if (message.includes('development relay pairing')) {
    return {
      title: 'Use the Development Relay screen',
      detail: 'Close setup and choose Development Relay. Relay pairing is disabled here because this preview does not authenticate accounts.',
    };
  }
  if (message.includes('not supported by this version')) {
    return {
      title: 'This agent is not supported yet',
      detail: raw,
    };
  }
  if (message.includes('hermes agent') || message.includes('hermes_ok')) {
    return {
      title: 'Brio is ready, but Hermes is offline',
      detail: 'The connection bridge answered, but Hermes Agent did not.',
      checklist: ['Start or restart Hermes Agent', 'Keep the Brio connector running', 'Try again'],
    };
  }
  if (message.includes('unauthorized') || message.includes('401') || message.includes('token')) {
    return {
      title: 'That access token was rejected',
      detail: 'The saved details may no longer match the Brio connector on your computer.',
      checklist: ['Reconnect through Brio Relay', 'Use the latest enrollment details'],
    };
  }
  if (message.includes('expired') || message.includes('claim') || message.includes('not found')) {
    return {
      title: 'That connection code has expired',
      detail: 'Create a fresh code on your computer, then scan or paste it here.',
      checklist: ['Generate a new Relay enrollment code', 'Use the new code before it expires'],
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
        'Keep the Brio connector running',
        'Use the same Wi-Fi or connect both devices to the same private network or tailnet',
        'Allow Brio through your computer firewall',
      ],
    };
  }
  return {
    title: 'We could not finish connecting',
    detail: raw.length <= 160 ? raw : 'Check Brio on your computer, then try again.',
    checklist: ['Keep the Brio connector running', 'Create a fresh Relay enrollment', 'Try again'],
  };
}

export function friendlyPayloadError(message: string) {
  if (message.toLowerCase().includes('empty')) {
    return 'Copy the full enrollment command shown by Brio Relay, then try again.';
  }
  if (message.toLowerCase().includes('not ready')) return message;
  return 'Use the current enrollment command shown by Brio Relay.';
}
