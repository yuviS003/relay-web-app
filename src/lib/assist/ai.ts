/*
 * Optional AI assist, built on a bring-your-own-key, OpenAI-compatible chat
 * endpoint (OpenAI, OpenRouter's free tier, Groq, a local Ollama, anything
 * speaking /chat/completions). There is no built-in key or hosted model: the
 * user supplies an endpoint and key, the key lives only in their browser, and
 * the call travels through the same guarded relay as any other request.
 *
 * Privacy is explicit. The request being worked on is summarised for the
 * model, but header values that look like credentials are redacted first — the
 * model does not need a live token to suggest tests or explain a call, so it
 * never receives one.
 */

import { isSensitiveHeader } from '@/lib/headers-catalog';

export type AssistSettings = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type AssistMode = 'explain' | 'tests' | 'improve';

export type AssistHeader = { name: string; value: string; enabled: boolean };

export type AssistContext = {
  method: string;
  url: string;
  headers: readonly AssistHeader[];
  body: string;
  response?: {
    status?: number | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
  } | null;
};

export const DEFAULT_ASSIST_SETTINGS: AssistSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
};

/** Replaces credential-shaped header values so they never reach the model. */
function redactHeaders(headers: readonly AssistHeader[]): string {
  const active = headers.filter((h) => h.enabled && h.name.trim() !== '');
  if (active.length === 0) return '(none)';
  return active
    .map((h) => `${h.name}: ${isSensitiveHeader(h.name) ? '<redacted>' : h.value}`)
    .join('\n');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…(truncated)` : value;
}

const SYSTEM_PROMPTS: Record<AssistMode, string> = {
  explain:
    'You are a precise API engineer. Explain what the given HTTP request does and what a correct response should look like. Be concise. Do not invent endpoints or fields that are not implied by the request.',
  tests:
    "You generate post-response tests for an HTTP API client. Output ONLY JavaScript using this DSL, no prose and no markdown fences: test('name', () => { expect(actual).toBe(expected) }). Available: response.status, response.durationMs, response.header(name), response.json(). Matchers: toBe, toEqual, toContain, toBeTruthy, toBeFalsy, toBeLessThan, toBeGreaterThan, toHaveProperty. Base the tests on the actual response when one is provided.",
  improve:
    'You are a precise API engineer. Suggest concrete improvements to the given HTTP request: missing or incorrect headers, body issues, and likely mistakes. Be specific and brief. Never ask for the real value of a redacted credential.',
};

export function buildUserPrompt(mode: AssistMode, ctx: AssistContext): string {
  const lines = [
    `Method: ${ctx.method}`,
    `URL: ${ctx.url}`,
    `Headers:\n${redactHeaders(ctx.headers)}`,
  ];
  if (ctx.body.trim() !== '') {
    lines.push(`Request body:\n${truncate(ctx.body, 4000)}`);
  }
  if (ctx.response && typeof ctx.response.status === 'number') {
    lines.push(`\nLast response status: ${ctx.response.status}`);
    const ct = ctx.response.headers?.['content-type'];
    if (ct) lines.push(`Response content-type: ${ct}`);
    if (ctx.response.body) {
      lines.push(`Response body:\n${truncate(ctx.response.body, 4000)}`);
    }
  }
  const task =
    mode === 'tests'
      ? '\nWrite the tests now.'
      : mode === 'improve'
        ? '\nList the improvements now.'
        : '\nExplain the request now.';
  return `${lines.join('\n')}\n${task}`;
}

export type ChatRequest = {
  endpoint: string;
  payload: {
    model: string;
    messages: { role: 'system' | 'user'; content: string }[];
    temperature: number;
  };
};

export function buildChatRequest(
  settings: AssistSettings,
  mode: AssistMode,
  ctx: AssistContext,
): ChatRequest {
  const base = settings.baseUrl.trim().replace(/\/+$/, '');
  return {
    endpoint: `${base}/chat/completions`,
    payload: {
      model: settings.model.trim(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPTS[mode] },
        { role: 'user', content: buildUserPrompt(mode, ctx) },
      ],
      temperature: mode === 'tests' ? 0.1 : 0.3,
    },
  };
}

/** Pulls the assistant text out of an OpenAI-compatible chat response body. */
export function parseChatContent(body: string): string {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('The AI endpoint did not return JSON.');
  }
  const record = data as {
    choices?: { message?: { content?: unknown } }[];
    error?: { message?: unknown } | string;
  };
  if (record.error) {
    const message =
      typeof record.error === 'string'
        ? record.error
        : String(record.error.message ?? 'AI endpoint returned an error');
    throw new Error(message);
  }
  const content = record.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('The AI response contained no message.');
  }
  return content;
}

/** Strips markdown code fences so generated test code is paste-ready. */
export function stripCodeFences(text: string): string {
  const fenced = /^```(?:[a-zA-Z]+)?\n([\s\S]*?)\n```$/m.exec(text.trim());
  return (fenced?.[1] ?? text).trim();
}
