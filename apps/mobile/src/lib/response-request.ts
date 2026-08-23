// Pure construction of /v1/responses request payloads. Kept free of any
// React Native or Expo imports so the merge-sensitive behavior (model
// overrides riding along with composer fields on every request, including
// retries) can be regression-tested in Node.

export type ResponseRequestOptions = {
  conversation?: string;
  previousResponseId?: string;
  conversationHistory?: { role: string; content: string }[];
  provider?: string;
  model?: string;
  modelOptions?: Record<string, unknown>;
  // Stable runtime session identity sent as X-Hermes-Session-Id.
  sessionId?: string;
};

export function responseRequestBody(
  prompt: unknown,
  options: ResponseRequestOptions & {
    composerSessionId?: string;
    attachmentIds?: string[];
  },
  stream: boolean,
) {
  // A per-thread model override must ride along on every request, including
  // retries and continuations. Without an override the profile default
  // (`hermes-agent`) is left untouched; require_model_lock is never set here
  // and profile config is never mutated.
  const hasOverride = Boolean(
    options.model?.trim() || options.provider?.trim() || options.modelOptions,
  );
  return {
    ...(hasOverride
      ? {
          ...(options.model?.trim() ? { model: options.model } : {}),
          ...(options.provider?.trim() ? { provider: options.provider } : {}),
          ...(options.modelOptions ? { model_options: options.modelOptions } : {}),
        }
      : { model: 'hermes-agent' }),
    input: prompt,
    stream,
    ...(options.composerSessionId ? { brio_session_id: options.composerSessionId } : {}),
    ...(options.attachmentIds?.length ? { brio_attachments: options.attachmentIds } : {}),
    ...(options.previousResponseId
      ? { previous_response_id: options.previousResponseId }
      : options.conversationHistory?.length
        ? { conversation: options.conversation, conversation_history: options.conversationHistory }
        : options.conversation
          ? { conversation: options.conversation }
          : {}),
  };
}
