'use client';

import { useEffect, useState } from 'react';

import { importOpenApi, type ImportResult } from '@/lib/import/openapi';
import { importPostman } from '@/lib/import/postman';

import { AppDialog } from './app-dialog';

type Source = 'openapi' | 'postman';

type ImportDialogProps = {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onImport: (result: ImportResult) => void | Promise<void>;
};

/**
 * Bringing an existing API description in.
 *
 * Parsed in the browser, before anything is saved, so the preview is the real
 * result rather than a promise about it: the request count, the names, and
 * every warning the importer produced. Warnings are shown as prominently as
 * the success, because "imported, but your multipart bodies were dropped" is
 * the part worth reading.
 */
export function ImportDialog({
  open,
  busy,
  error,
  onClose,
  onImport,
}: ImportDialogProps) {
  const [source, setSource] = useState<Source>('openapi');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setText('');
    setResult(null);
    setParseError(null);
    setSource('openapi');
  }, [open]);

  const parse = (raw: string, kind: Source): void => {
    setParseError(null);
    setResult(null);
    if (raw.trim() === '') return;

    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch (problem) {
      setParseError(
        `That is not valid JSON: ${
          problem instanceof Error ? problem.message : 'parse error'
        }. YAML has to be converted first.`,
      );
      return;
    }
    setResult(kind === 'openapi' ? importOpenApi(document) : importPostman(document));
  };

  const readFile = async (file: File): Promise<void> => {
    const raw = await file.text();
    setText(raw);
    // A Postman export is recognisable, so the right parser is chosen rather
    // than leaving the user to pick and get an empty result.
    const kind: Source = /"_postman_id"|schema.getpostman.com/.test(raw)
      ? 'postman'
      : 'openapi';
    setSource(kind);
    parse(raw, kind);
  };

  return (
    <AppDialog
      open={open}
      eyebrow="Import"
      title="Import an API description"
      description="An OpenAPI 3 document or a Postman v2.1 collection, as JSON. Everything is parsed here in the browser and previewed before it is saved."
      submitLabel={
        result && result.requests.length > 0
          ? `Import ${result.requests.length} request${result.requests.length === 1 ? '' : 's'}`
          : 'Import'
      }
      size="large"
      busy={busy}
      error={error ?? parseError}
      onClose={onClose}
      onSubmit={() => {
        if (result && result.requests.length > 0) void onImport(result);
      }}
    >
      <div className="dialogField">
        <label htmlFor="import-source">Format</label>
        <select
          id="import-source"
          value={source}
          onChange={(event) => {
            const next = event.target.value as Source;
            setSource(next);
            parse(text, next);
          }}
        >
          <option value="openapi">OpenAPI 3 (JSON)</option>
          <option value="postman">Postman collection v2.1</option>
        </select>
      </div>

      <div className="dialogField">
        <label htmlFor="import-file">File</label>
        <input
          id="import-file"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readFile(file);
          }}
        />
      </div>

      <div className="dialogField">
        <label htmlFor="import-text">Or paste it</label>
        <textarea
          id="import-text"
          className="dialogCodeInput"
          placeholder='{"openapi":"3.0.0","info":{"title":"…"},"paths":{}}'
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            parse(event.target.value, source);
          }}
        />
      </div>

      {result ? (
        <div className="importPreview">
          <p className="settingsStatus">
            <span className={`badge ${result.requests.length > 0 ? 'good' : 'warn'}`}>
              {result.requests.length} request
              {result.requests.length === 1 ? '' : 's'}
            </span>
            into a collection named “{result.name}”
          </p>

          {result.requests.length > 0 ? (
            <ul className="importList">
              {result.requests.slice(0, 12).map((request, index) => (
                <li key={`${request.method}-${request.name}-${index}`}>
                  <span className={`verb verb-${request.method}`}>{request.method}</span>
                  <span className="truncate">{request.name}</span>
                  <span className="truncate importUrl">{request.url}</span>
                </li>
              ))}
              {result.requests.length > 12 ? (
                <li>
                  <span />
                  <span>…and {result.requests.length - 12} more</span>
                </li>
              ) : null}
            </ul>
          ) : null}

          {result.warnings.length > 0 ? (
            <div className="dialogCallout">
              <strong>
                {result.warnings.length} thing
                {result.warnings.length === 1 ? '' : 's'} to know
              </strong>
              <ul className="importWarnings">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </AppDialog>
  );
}
