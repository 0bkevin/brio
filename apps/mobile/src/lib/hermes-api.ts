export type HermesSession = {
  id: string;
  source: string;
  user_id?: string;
  model?: string;
  started_at: number;
  ended_at?: number | null;
  message_count: number;
  title?: string;
};

export type HermesSessionMessage = {
  role: string;
  content: string;
  tool_name?: string;
  timestamp: number;
};

export function normalizeHermesSessions(result: { data?: HermesSession[] }) {
  return { sessions: Array.isArray(result.data) ? result.data : [] };
}

export function normalizeHermesSessionMessages(result: { data?: HermesSessionMessage[] }) {
  return { messages: Array.isArray(result.data) ? result.data : [] };
}
