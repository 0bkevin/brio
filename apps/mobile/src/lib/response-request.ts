export type ResponseRequestOptions = {
  conversation?: string;
  previousResponseId?: string;
  conversationHistory?: { role: string; content: string }[];
  provider?: string;
  model?: string;
  modelOptions?: Record<string, unknown>;
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
        ? {
            conversation: options.conversation,
            conversation_history: options.conversationHistory,
          }
        : options.conversation
          ? { conversation: options.conversation }
          : {}),
  };
}
