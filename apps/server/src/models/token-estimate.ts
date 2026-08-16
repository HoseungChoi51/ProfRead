/**
 * A deliberately conservative, tokenizer-independent estimate of the input
 * tokens used by a text request. It accounts for the JSON request envelope as
 * well as message content, function tool schemas, and a forced tool choice.
 *
 * This is used for context-window admission, not billing. The safety margin
 * favours rejecting a borderline request over sending one that cannot fit.
 */

export interface TokenEstimateMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenEstimateTool {
  name: string;
  schema: unknown;
}

export interface ModelRequestTokenEstimateInput {
  messages: readonly TokenEstimateMessage[];
  tools?: readonly TokenEstimateTool[];
  requiredToolName?: string;
}

const REQUEST_OVERHEAD_TOKENS = 16;
const SAFETY_MARGIN = 1.05;

/**
 * Estimate all text-side input tokens needed for model routing.
 *
 * The wire shape is intentionally the more verbose chat-completions function
 * tool representation. That also safely bounds the equivalent Responses API
 * request without making routing depend on a model that has not been selected.
 */
export function estimateModelRequestTokens(input: ModelRequestTokenEstimateInput): number {
  const requestEnvelope = {
    messages: input.messages.map(message => ({ role: message.role, content: message.content })),
    ...(input.tools?.length ? {
      tools: input.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, parameters: tool.schema, strict: true },
      })),
    } : {}),
    ...(input.requiredToolName ? {
      tool_choice: { type: 'function', function: { name: input.requiredToolName } },
    } : {}),
  };
  const serialized = JSON.stringify(requestEnvelope);
  // A tokenizer cannot produce more ordinary text tokens than the UTF-8 bytes
  // representing that text: byte fallback is its most fragmented case. Using
  // the complete, deliberately verbose envelope also covers protocol framing;
  // a final fixed and percentage margin protects the admission boundary.
  return REQUEST_OVERHEAD_TOKENS + Math.ceil(Buffer.byteLength(serialized, 'utf8') * SAFETY_MARGIN);
}
