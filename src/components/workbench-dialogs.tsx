'use client';

import { useEffect, useState } from 'react';

import { PasswordField } from '@/components/password-field';

import { AppDialog } from './app-dialog';

export type WorkbenchDialog =
  | 'import-curl'
  | 'new-collection'
  | 'new-environment'
  | 'new-request'
  | 'new-secret'
  | 'rename-request'
  | 'delete-request'
  | null;

export type NewRequestInput = {
  name: string;
  method: string;
  url: string;
};

export type NewSecretInput = {
  name: string;
  value: string;
  passphrase: string;
};

type WorkbenchDialogsProps = {
  active: WorkbenchDialog;
  environmentName: string | null;
  initialPassphrase: string;
  busy: boolean;
  error: string | null;
  /** The request a rename or delete applies to. */
  requestTarget: { id: string; name: string } | null;
  onClose: () => void;
  onImportCurl: (command: string) => void | Promise<void>;
  onCreateCollection: (name: string) => void | Promise<void>;
  onCreateEnvironment: (name: string) => void | Promise<void>;
  onCreateRequest: (input: NewRequestInput) => void | Promise<void>;
  onCreateSecret: (input: NewSecretInput) => void | Promise<void>;
  onRenameRequest: (name: string) => void | Promise<void>;
  onDeleteRequest: () => void | Promise<void>;
  canPersist?: boolean;
};

/**
 * Every flow that needs to ask the user something lives here, so the workbench
 * never calls window.prompt, alert or confirm: a native dialog ignores the
 * app's styling, cannot show the request it is about, and on some platforms
 * appears outside the window entirely.
 *
 * Field state resets every time a dialog changes, preventing values from one
 * operation leaking into the next one the user opens.
 */
export function WorkbenchDialogs({
  active,
  environmentName,
  initialPassphrase,
  busy,
  error,
  requestTarget,
  onClose,
  onImportCurl,
  onCreateCollection,
  onCreateEnvironment,
  onCreateRequest,
  onCreateSecret,
  onRenameRequest,
  onDeleteRequest,
  canPersist = true,
}: WorkbenchDialogsProps) {
  const [curl, setCurl] = useState('');
  const [collection, setCollection] = useState('');
  const [environment, setEnvironment] = useState('');
  const [requestName, setRequestName] = useState('');
  const [requestMethod, setRequestMethod] = useState('GET');
  const [requestUrl, setRequestUrl] = useState('https://');
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secretPassphrase, setSecretPassphrase] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [renameSeed, setRenameSeed] = useState('');

  useEffect(() => {
    setCurl('');
    setCollection('');
    setEnvironment('');
    setRequestName('');
    setRequestMethod('GET');
    setRequestUrl('https://');
    setSecretName('');
    setSecretValue('');
    setSecretPassphrase(initialPassphrase);
  }, [active, initialPassphrase]);

  /*
   * Renaming starts from the current name, so a small correction does not mean
   * retyping it. Seeded during render rather than in an effect: an effect runs
   * after the dialog is already on screen, so the field would appear empty for
   * a frame and then fill itself. The key covers the dialog closing too, so
   * reopening the same request starts from the saved name again.
   */
  const renameKey = `${active ?? ''}:${requestTarget?.id ?? ''}`;
  if (renameSeed !== renameKey) {
    setRenameSeed(renameKey);
    setRenameValue(requestTarget?.name ?? '');
  }

  return (
    <>
      <AppDialog
        open={active === 'import-curl'}
        eyebrow="Import"
        title="Paste a cURL command"
        description="Quotes, line continuations, headers, body and method are parsed locally. Unsupported flags are reported instead of silently ignored."
        submitLabel="Import request"
        size="large"
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={() => onImportCurl(curl)}
      >
        <div className="dialogField">
          <label htmlFor="curl-command">cURL command</label>
          <textarea
            id="curl-command"
            className="dialogCodeInput"
            autoFocus
            required
            value={curl}
            placeholder={`curl 'https://api.example.com/v1/items' \\\n  -H 'accept: application/json' \\\n  -H 'authorization: Bearer {{token}}'`}
            onChange={(event) => setCurl(event.target.value)}
          />
        </div>
        <div className="dialogCallout">
          <strong>Safe by default</strong>
          Imported values are still checked by the proxy before any connection
          is made. A pasted command cannot bypass private-network protection.
        </div>
      </AppDialog>

      <AppDialog
        open={active === 'new-environment'}
        eyebrow="Workspace"
        title="Create an environment"
        description="Group variables for local, staging or production. Secret values can be encrypted after the environment is created."
        submitLabel="Create environment"
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={() => onCreateEnvironment(environment)}
      >
        <div className="dialogField">
          <label htmlFor="environment-name">Environment name</label>
          <input
            id="environment-name"
            autoFocus
            required
            maxLength={120}
            value={environment}
            placeholder="Local development"
            onChange={(event) => setEnvironment(event.target.value)}
          />
        </div>
        <div className="environmentExamples" aria-label="Examples">
          {['Local', 'Staging', 'Production'].map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              onClick={() => setEnvironment(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </AppDialog>

      <AppDialog
        open={active === 'new-request'}
        eyebrow="Collection"
        title="Create a request"
        description={
          canPersist
            ? 'It will be saved to your first collection and selected immediately.'
            : 'You can prepare the request as a guest; sign in when you want to save it.'
        }
        submitLabel="Create request"
        size="medium"
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={() =>
          onCreateRequest({
            name: requestName,
            method: requestMethod,
            url: requestUrl,
          })
        }
      >
        <div className="dialogField">
          <label htmlFor="request-name">Name</label>
          <input
            id="request-name"
            autoFocus
            required
            maxLength={120}
            value={requestName}
            placeholder="List users"
            onChange={(event) => setRequestName(event.target.value)}
          />
        </div>
        <div className="dialogGrid dialogGrid--request">
          <div className="dialogField">
            <label htmlFor="request-method">Method</label>
            <select
              id="request-method"
              value={requestMethod}
              onChange={(event) => setRequestMethod(event.target.value)}
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(
                (method) => (
                  <option key={method}>{method}</option>
                ),
              )}
            </select>
          </div>
          <div className="dialogField">
            <label htmlFor="request-url">URL</label>
            <input
              id="request-url"
              required
              value={requestUrl}
              onChange={(event) => setRequestUrl(event.target.value)}
            />
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={active === 'new-secret'}
        eyebrow="Encrypted variable"
        title={`Add a secret${environmentName ? ` to ${environmentName}` : ''}`}
        description="The value is encrypted in this browser before storage. The passphrase and derived key are never sent to the server."
        submitLabel="Encrypt and save"
        size="medium"
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={() =>
          onCreateSecret({
            name: secretName,
            value: secretValue,
            passphrase: secretPassphrase,
          })
        }
      >
        <div className="dialogGrid">
          <div className="dialogField">
            <label htmlFor="secret-name">Variable name</label>
            <input
              id="secret-name"
              autoFocus
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              value={secretName}
              placeholder="API_TOKEN"
              onChange={(event) => setSecretName(event.target.value)}
            />
          </div>
          <div className="dialogField">
            <label htmlFor="secret-passphrase">Passphrase</label>
            <PasswordField
              id="secret-passphrase"
              required
              minLength={8}
              autoComplete="off"
              value={secretPassphrase}
              placeholder="Not stored"
              onChange={(event) => setSecretPassphrase(event.target.value)}
            />
          </div>
        </div>
        <div className="dialogField">
          <label htmlFor="secret-value">Secret value</label>
          <textarea
            id="secret-value"
            className="secretInput"
            required
            value={secretValue}
            placeholder="Paste the token or credential here"
            onChange={(event) => setSecretValue(event.target.value)}
          />
        </div>
        <div className="dialogCallout">
          <strong>Storage boundary</strong>
          The stored copy is encrypted. The relay will still see the plaintext
          while forwarding a request, because it must send that value upstream.
        </div>
      </AppDialog>

      <AppDialog
        open={active === 'new-collection'}
        eyebrow="Workspace"
        title="Create a collection"
        description="A folder for related requests. Drag requests between collections in the sidebar, or use the Move to menu on a request."
        submitLabel="Create collection"
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={() => onCreateCollection(collection)}
      >
        <div className="dialogField">
          <label htmlFor="collection-name">Collection name</label>
          <input
            id="collection-name"
            autoFocus
            required
            maxLength={120}
            value={collection}
            placeholder="Billing API"
            onChange={(event) => setCollection(event.target.value)}
          />
        </div>
      </AppDialog>

      <AppDialog
        open={active === 'rename-request'}
        eyebrow="Request"
        title="Rename request"
        description="Only the label in the sidebar changes. The method, URL and saved body stay as they are."
        submitLabel="Save name"
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={() => onRenameRequest(renameValue)}
      >
        <div className="dialogField">
          <label htmlFor="rename-request-name">Name</label>
          <input
            id="rename-request-name"
            autoFocus
            required
            maxLength={120}
            value={renameValue}
            placeholder="List users"
            onChange={(event) => setRenameValue(event.target.value)}
          />
        </div>
      </AppDialog>

      <AppDialog
        open={active === 'delete-request'}
        eyebrow="Request"
        title="Delete this request?"
        submitLabel="Delete request"
        tone="danger"
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={() => onDeleteRequest()}
      >
        <p className="dialogPrompt">
          <strong>{requestTarget?.name ?? 'This request'}</strong> will be
          removed from its collection. Saved headers, body and tests go with it,
          and this cannot be undone.
        </p>
      </AppDialog>
    </>
  );
}
