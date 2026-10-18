'use client';

import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type ReactNode,
} from 'react';

type AppDialogProps = {
  open: boolean;
  eyebrow?: string;
  title: string;
  description?: string;
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  size?: 'small' | 'medium' | 'large';
  /** 'danger' styles the submit as destructive and starts focus on Cancel. */
  tone?: 'default' | 'danger';
  children: ReactNode;
  onClose: () => void;
  onSubmit: () => void | Promise<void>;
};

/**
 * App-owned modal built on the native dialog primitive.
 *
 * Native <dialog> supplies the behaviour that custom div modals routinely get
 * wrong: focus stays inside, the page behind is inert, Escape closes it, and
 * assistive technology receives modal semantics. Styling remains entirely
 * ours, so workflows no longer fall back to window.prompt().
 */
export function AppDialog({
  open,
  eyebrow,
  title,
  description,
  submitLabel,
  busy = false,
  error,
  size = 'small',
  tone = 'default',
  children,
  onClose,
  onSubmit,
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      // A dialog opened after mount does not consistently honour React's
      // autoFocus attribute across browsers. Move focus after showModal so the
      // first field, not the close button, receives the keyboard.
      requestAnimationFrame(() => {
        // A confirmation has no fields, so focus lands on Cancel: Enter should
        // not be able to confirm a destructive action the user never read.
        const target =
          dialog.querySelector<HTMLElement>(
            '[autofocus], textarea, input:not([type="hidden"]), select',
          ) ?? dialog.querySelector<HTMLElement>('.dialogCancel');
        target?.focus();
      });
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit();
  };

  return (
    <dialog
      ref={dialogRef}
      className={`appDialog appDialog--${size}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        // The dialog box itself is the event target only when the user clicked
        // the backdrop; clicks on any descendant stay inside.
        if (event.target === dialogRef.current && !busy) onClose();
      }}
    >
      <form className="dialogForm" onSubmit={submit}>
        <header className="dialogHeader">
          <div>
            {eyebrow ? <p className="dialogEyebrow">{eyebrow}</p> : null}
            <h2 id={titleId} className="dialogTitle">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="dialogDescription">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="dialogClose"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="dialogBody">{children}</div>

        {error ? (
          <p className="notice bad dialogError" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="dialogFooter">
          <span className="dialogEscape">Esc to close</span>
          <div className="row">
            <button
              type="button"
              className="dialogCancel"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={tone === 'danger' ? 'destructive' : 'primary'}
              disabled={busy}
            >
              {busy ? 'Working…' : submitLabel}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
