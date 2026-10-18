'use client';

import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

type CodeInputProps = {
  /** Id of the first box, so an outside <label> can point at the field. */
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Fired once the last box is filled, to submit without a click. */
  onComplete?: (value: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Names the group for a screen reader, which reads boxes individually. */
  label: string;
  invalid?: boolean;
};

const DIGITS = /\d/g;

/**
 * A one-time code, one box per digit.
 *
 * Six boxes rather than one wide field, because a code typed from an
 * authenticator is read in groups and a box tells you exactly how many digits
 * are expected and how many you have left. The value is still a plain string
 * to the caller: boxes are a presentation of it, not a different data shape.
 *
 * Everything that makes a segmented input bearable is handled here — paste,
 * backspace across boxes, arrow keys, and the browser's own SMS/TOTP autofill
 * landing in the first box and spreading across the rest.
 */
export function CodeInput({
  id,
  value,
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  autoFocus = false,
  label,
  invalid = false,
}: CodeInputProps) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.slice(0, length).split('');

  useEffect(() => {
    if (autoFocus) boxes.current[0]?.focus();
  }, [autoFocus]);

  const focusBox = (index: number): void => {
    const target = boxes.current[Math.min(Math.max(index, 0), length - 1)];
    target?.focus();
    target?.select();
  };

  /** Writes `next` and moves focus to wherever the caret logically lands. */
  const commit = (next: string, caret: number): void => {
    const cleaned = next.slice(0, length);
    onChange(cleaned);
    focusBox(caret);
    if (cleaned.length === length) onComplete?.(cleaned);
  };

  const handleInput = (index: number, raw: string): void => {
    const typed = (raw.match(DIGITS) ?? []).join('');
    if (typed === '') {
      // Select-all then Delete, which is how a box gets emptied without
      // Backspace — and how a programmatic clear arrives.
      if (raw === '') commit(`${value.slice(0, index)}${value.slice(index + 1)}`, index);
      return;
    }

    /*
     * More than one digit in a single box means autofill or a paste landed
     * there, so it is spread from this position rather than truncated — the
     * behaviour people expect when a password manager fills a code.
     */
    const before = value.slice(0, index);
    const after = value.slice(index + typed.length);
    commit(`${before}${typed}${after}`.slice(0, length), index + typed.length);
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (digits[index]) {
        // Clear this box in place; the code is only complete when every box
        // is filled, so leaving a hole mid-string is fine.
        commit(`${value.slice(0, index)}${value.slice(index + 1)}`, index);
        return;
      }
      commit(`${value.slice(0, Math.max(0, index - 1))}${value.slice(index)}`, index - 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusBox(index - 1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusBox(index + 1);
    }
  };

  const handlePaste = (index: number, event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = (event.clipboardData.getData('text').match(DIGITS) ?? []).join('');
    if (pasted === '') return;
    event.preventDefault();
    commit(`${value.slice(0, index)}${pasted}`.slice(0, length), index + pasted.length);
  };

  return (
    <div
      className={`codeBoxes${invalid ? ' codeBoxes--invalid' : ''}`}
      role="group"
      aria-label={label}
    >
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          // The first box carries the field id and the autofill hint; a
          // browser filling a one-time code targets a single element.
          id={index === 0 ? id : `${id}-${index + 1}`}
          ref={(node) => {
            boxes.current[index] = node;
          }}
          className="codeBox"
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${index + 1} of ${length}`}
          // Not maxLength={1}: a pasted or autofilled code has to be allowed
          // in before it can be spread across the boxes.
          disabled={disabled}
          value={digits[index] ?? ''}
          onChange={(event) => handleInput(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onPaste={(event) => handlePaste(index, event)}
          onFocus={(event) => event.target.select()}
        />
      ))}
    </div>
  );
}
