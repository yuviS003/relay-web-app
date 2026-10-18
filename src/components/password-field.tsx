'use client';

import { useState, type InputHTMLAttributes } from 'react';

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/** Password input with an accessible show/hide control. */
export function PasswordField(props: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className="passwordField">
      <input {...props} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="passwordToggle"
        aria-label={label}
        title={label}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A11.4 11.4 0 0 1 12 4c5.4 0 9 5 9 5a15.6 15.6 0 0 1-3 3.5M6.5 6.5A15.7 15.7 0 0 0 3 9s3.6 5 9 5c.8 0 1.6-.1 2.3-.3" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12s3.6-5 9-5 9 5 9 5-3.6 5-9 5-9-5-9-5Z" />
            <circle cx="12" cy="12" r="2.5" />
          </svg>
        )}
      </button>
    </div>
  );
}
