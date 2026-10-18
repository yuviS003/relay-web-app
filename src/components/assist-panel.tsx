'use client';

import { useCallback, useEffect, useState } from 'react';

import { PasswordField } from '@/components/password-field';
import { generateAssertions } from '@/lib/analysis/testgen';
import {
  buildChatRequest,
  DEFAULT_ASSIST_SETTINGS,
  parseChatContent,
  stripCodeFences,
  type AssistContext,
  type AssistMode,
  type AssistSettings,
} from '@/lib/assist/ai';
import type { RequestSpec } from '@/lib/store/types';

type RelayLike = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  durationMs?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  reason?: string;
} | null;

const KEYS = {
  baseUrl: 'wac-assist-baseurl',
  model: 'wac-assist-model',
  apiKey: 'wac-assist-key',
} as const;

const PROVIDERS = [
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    baseUrl: DEFAULT_ASSIST_SETTINGS.baseUrl,
    model: DEFAULT_ASSIST_SETTINGS.model,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter free router',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
  },
  {
    id: 'ollama',
    label: 'Ollama local (free)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:3b',
  },
] as const;

function loadSettings(): AssistSettings {
  if (typeof window === 'undefined') return DEFAULT_ASSIST_SETTINGS;
  return {
    baseUrl: localStorage.getItem(KEYS.baseUrl) ?? DEFAULT_ASSIST_SETTINGS.baseUrl,
    model: localStorage.getItem(KEYS.model) ?? DEFAULT_ASSIST_SETTINGS.model,
    apiKey: sessionStorage.getItem(KEYS.apiKey) ?? '',
  };
}

const MODE_LABELS: Record<AssistMode, string> = {
  explain: 'Explain',
  tests: 'Suggest tests',
  improve: 'Improve',
};

function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function AssistPanel({
  spec,
  result,
  onInsertTests,
}: {
  spec: RequestSpec;
  result: RelayLike;
  onInsertTests: (code: string) => void;
}) {
  const [settings, setSettings] = useState<AssistSettings>(DEFAULT_ASSIST_SETTINGS);
  const [provider, setProvider] = useState('custom');
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<AssistMode>('explain');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSettings(loadSettings()), []);

  const update = useCallback((patch: Partial<AssistSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      if (typeof window !== 'undefined') {
        localStorage.setItem(KEYS.baseUrl, next.baseUrl);
        localStorage.setItem(KEYS.model, next.model);
        sessionStorage.setItem(KEYS.apiKey, next.apiKey);
      }
      return next;
    });
  }, []);

  const run = useCallback(
    async (selected: AssistMode) => {
      const local = isLocalEndpoint(settings.baseUrl);
      if (!local && settings.apiKey.trim() === '') {
        setError('Add an API key, choose OpenRouter, or use a local Ollama endpoint.');
        return;
      }
      if (settings.model.trim() === '') {
        setError('Enter a model name.');
        return;
      }
      setMode(selected);
      setRunning(true);
      setError(null);
      setOutput('');

      const ctx: AssistContext = {
        method: spec.method,
        url: spec.url,
        headers: spec.headers,
        body: spec.body,
        response: result
          ? { status: result.status, headers: result.headers, body: result.body }
          : null,
      };
      const { endpoint, payload } = buildChatRequest(settings, selected, ctx);

      try {
        const aiHeaders: Record<string, string> = {
          'content-type': 'application/json',
        };
        if (settings.apiKey.trim()) {
          aiHeaders.authorization = `Bearer ${settings.apiKey.trim()}`;
        }
        const relayed = await fetch('/api/relay', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: endpoint,
            method: 'POST',
            headers: aiHeaders,
            body: JSON.stringify(payload),
            script: '',
            tests: '',
            variables: {},
          }),
        });
        const data = (await relayed.json()) as RelayLike;
        if (!data || data.ok === false) {
          throw new Error(data?.error ?? data?.reason ?? 'The relay could not reach the AI endpoint.');
        }
        const content = parseChatContent(data.body ?? '');
        setOutput(selected === 'tests' ? stripCodeFences(content) : content);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setRunning(false);
      }
    },
    [result, settings, spec],
  );

  const localTests = () => {
    if (!result?.ok || typeof result.status !== 'number') {
      setError('Send a successful request first.');
      return;
    }
    const code = generateAssertions({
      status: result.status,
      statusText: result.statusText,
      durationMs: result.durationMs,
      headers: result.headers,
      body: result.body,
    });
    onInsertTests(code);
  };

  return (
    <div className="assist">
      <header className="labHeader">
        <div>
          <p className="labEyebrow">AI assist · optional</p>
          <h3>Explain, test, and improve this request</h3>
          <p>
            Use OpenRouter’s free router, a local Ollama model, or any
            OpenAI-compatible endpoint. Credential headers are redacted before
            request details are sent. No AI key is needed for local generated tests.
          </p>
        </div>
      </header>

      <div className="assistFree">
        <div>
          <strong>Free, private test suggestions</strong>
          <p>Generates deterministic assertions from the last response and runs with no model or key.</p>
        </div>
        <button type="button" className="primary" onClick={localTests}>
          Generate locally
        </button>
      </div>

      <div className="assistSettings">
        <label>
          Provider preset
          <select
            value={provider}
            onChange={(event) => {
              const id = event.target.value;
              setProvider(id);
              const preset = PROVIDERS.find((candidate) => candidate.id === id);
              if (preset) update({ baseUrl: preset.baseUrl, model: preset.model });
            }}
          >
            {PROVIDERS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
        </label>
        <label>
          Endpoint base URL
          <input
            type="url"
            spellCheck={false}
            value={settings.baseUrl}
            onChange={(event) => {
              setProvider('custom');
              update({ baseUrl: event.target.value });
            }}
          />
        </label>
        <label>
          Model
          <input
            type="text"
            spellCheck={false}
            value={settings.model}
            onChange={(event) => update({ model: event.target.value })}
          />
        </label>
        <label>
          API key (kept for this tab only; optional for local Ollama)
          <PasswordField
            autoComplete="off"
            spellCheck={false}
            value={settings.apiKey}
            placeholder="sk-…"
            onChange={(event) => update({ apiKey: event.target.value })}
          />
        </label>
      </div>

      {isLocalEndpoint(settings.baseUrl) ? (
        <p className="notice warn">
          Local Ollama requires <code>PROXY_ALLOW_PRIVATE=true</code> in local development. Never enable that on a public deployment.
        </p>
      ) : null}

      <div className="row assistModes">
        {(Object.keys(MODE_LABELS) as AssistMode[]).map((option) => (
          <button
            key={option}
            type="button"
            className={option === 'explain' ? 'primary' : undefined}
            disabled={running}
            onClick={() => void run(option)}
          >
            {running && mode === option ? 'Working…' : MODE_LABELS[option]}
          </button>
        ))}
      </div>

      {error ? <p className="notice bad">{error}</p> : null}

      {output ? (
        <div className="assistOutput">
          <pre>{output}</pre>
          {mode === 'tests' ? (
            <button type="button" className="primary" onClick={() => onInsertTests(output)}>
              Insert into Tests
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
