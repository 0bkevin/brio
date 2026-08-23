import type { HermesLiveUsage } from './hermes-api';

export type HermesResponse = {
  id?: string;
  status?: string;
  model?: string;
  usage?: HermesLiveUsage;
  session_id?: string;
  output?: {
    type?: string;
    role?: string;
    content?: { type?: string; text?: string }[];
    name?: string;
  }[];
  output_text?: string;
  error?: { message?: string } | string;
};

export class ResponsesSSEParser {
  private buffer = '';
  private response: HermesResponse | null = null;
  private responseId = '';
  private text = '';
  private readonly onTextDelta?: (delta: string) => void;

  constructor(onTextDelta?: (delta: string) => void) {
    this.onTextDelta = onTextDelta;
  }

  push(chunk: string) {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n');
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.processBlock(block);
      boundary = this.buffer.indexOf('\n\n');
    }
  }

  finish() {
    if (this.buffer.trim()) this.processBlock(this.buffer);
    this.buffer = '';
    if (this.response) {
      if (!this.response.output_text && this.text) this.response.output_text = this.text;
      return this.response;
    }
    if (!this.text && !this.responseId) throw new Error('Agent stream ended without a response');
    return { id: this.responseId || undefined, status: 'completed', output_text: this.text };
  }

  private processBlock(block: string) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'response.created') {
      const response = event.response as HermesResponse | undefined;
      if (response?.id) this.responseId = response.id;
      return;
    }
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      this.text += event.delta;
      this.onTextDelta?.(event.delta);
      return;
    }
    if (type === 'response.output_text.done' && !this.text && typeof event.text === 'string') {
      this.text = event.text;
      this.onTextDelta?.(event.text);
      return;
    }
    if (type === 'response.completed') {
      this.response = (event.response as HermesResponse | undefined) ?? null;
      if (this.response?.id) this.responseId = this.response.id;
      return;
    }
    if (type === 'error' || type === 'response.failed') {
      const failedResponse = event.response as HermesResponse | undefined;
      const error = (event.error ?? failedResponse?.error) as { message?: unknown } | string | undefined;
      const message = typeof error === 'string' ? error : String(error?.message ?? 'Agent stream failed');
      throw new Error(message);
    }
  }
}
