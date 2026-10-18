import { describe, expect, it } from 'vitest';

import {
  buildChatRequest,
  buildUserPrompt,
  parseChatContent,
  stripCodeFences,
  type AssistContext,
  type AssistSettings,
} from '../src/lib/assist/ai';

const settings: AssistSettings = {
  baseUrl: 'https://api.openai.com/v1/',
  model: 'gpt-4o-mini',
  apiKey: 'sk-secret',
};

const ctx: AssistContext = {
  method: 'POST',
  url: 'https://api.example.com/login',
  headers: [
    { name: 'authorization', value: 'Bearer super-secret-token', enabled: true },
    { name: 'content-type', value: 'application/json', enabled: true },
  ],
  body: '{"user":"a"}',
  response: null,
};

describe('AI assist request building', () => {
  it('builds the chat endpoint and payload', () => {
    const { endpoint, payload } = buildChatRequest(settings, 'explain', ctx);
    expect(endpoint).toBe('https://api.openai.com/v1/chat/completions');
    expect(payload.model).toBe('gpt-4o-mini');
    expect(payload.messages[0]?.role).toBe('system');
    expect(payload.messages).toHaveLength(2);
  });

  it('redacts credential-shaped headers before they reach the model', () => {
    const prompt = buildUserPrompt('improve', ctx);
    expect(prompt).not.toContain('super-secret-token');
    expect(prompt).toContain('authorization: <redacted>');
    expect(prompt).toContain('content-type: application/json');
  });

  it('asks for bare DSL code in tests mode', () => {
    const { payload } = buildChatRequest(settings, 'tests', ctx);
    expect(payload.messages[0]?.content).toContain('test(');
    expect(payload.temperature).toBeLessThan(0.2);
  });
});

describe('AI assist response parsing', () => {
  it('extracts the assistant message', () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'hello' } }] });
    expect(parseChatContent(body)).toBe('hello');
  });

  it('surfaces a provider error', () => {
    const body = JSON.stringify({ error: { message: 'bad key' } });
    expect(() => parseChatContent(body)).toThrow('bad key');
  });

  it('rejects non-JSON', () => {
    expect(() => parseChatContent('<html>503</html>')).toThrow(/did not return JSON/);
  });

  it('strips markdown code fences', () => {
    expect(stripCodeFences("```js\ntest('x', () => {});\n```")).toBe(
      "test('x', () => {});",
    );
    expect(stripCodeFences('no fences here')).toBe('no fences here');
  });
});
