'use client';

import { CAPTURE_SOURCES, type Capture } from '@/lib/store/types';

type CaptureEditorProps = {
  captures: readonly Capture[];
  onChange: (next: Capture[]) => void;
};

const PLACEHOLDERS: Record<Capture['from'], string> = {
  body: '$.data.token',
  header: 'location',
  status: '',
};

/**
 * Declares what to lift out of this response for later requests.
 *
 * Saved with the request rather than held for the session, because the chain
 * is part of the collection: whoever runs it next needs the same token to flow
 * from the same sign-in.
 */
export function CaptureEditor({ captures, onChange }: CaptureEditorProps) {
  const update = (index: number, patch: Partial<Capture>): void => {
    onChange(
      captures.map((capture, at) => (at === index ? { ...capture, ...patch } : capture)),
    );
  };

  return (
    <div className="captureEditor">
      <p className="hint">
        Each capture binds a value from this response to a{' '}
        <code>{'{{variable}}'}</code> the next requests in a collection run can
        use. A capture that matches nothing fails the step rather than sending
        an empty value onward.
      </p>

      {captures.length === 0 ? (
        <p className="captureEmpty">No captures. This request passes nothing on.</p>
      ) : null}

      {captures.map((capture, index) => (
        <div className="captureRow" key={index}>
          <input
            aria-label={`Capture ${index + 1} variable name`}
            placeholder="token"
            value={capture.name}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <select
            aria-label={`Capture ${index + 1} source`}
            value={capture.from}
            onChange={(event) =>
              update(index, {
                from: event.target.value as Capture['from'],
                path: '',
              })
            }
          >
            {CAPTURE_SOURCES.map((source) => (
              <option key={source} value={source}>
                {source === 'body'
                  ? 'from body'
                  : source === 'header'
                    ? 'from header'
                    : 'from status'}
              </option>
            ))}
          </select>
          <input
            aria-label={`Capture ${index + 1} path`}
            placeholder={PLACEHOLDERS[capture.from]}
            value={capture.path}
            disabled={capture.from === 'status'}
            onChange={(event) => update(index, { path: event.target.value })}
          />
          <button
            type="button"
            className="iconBtn"
            aria-label={`Remove capture ${index + 1}`}
            onClick={() => onChange(captures.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() =>
          onChange([...captures, { name: '', from: 'body', path: '$.' }])
        }
      >
        Add capture
      </button>
    </div>
  );
}
