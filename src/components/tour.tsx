'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type TourStep = {
  id: string;
  title: string;
  body: string;
  /** Element to point at. A step with no target, or a missing one, is skipped. */
  target?: string;
  /** Limits a step to one kind of visitor. */
  audience?: 'guest' | 'account';
};

type Box = { top: number; left: number; width: number; height: number };

type TourProps = {
  open: boolean;
  steps: readonly TourStep[];
  audience: 'guest' | 'account';
  onFinish: () => void;
  onSkip: () => void;
};

const CARD_WIDTH = 320;
const GAP = 14;
const FALLBACK_HEIGHT = 190;

function measure(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * The guided tour.
 *
 * Points at the real interface rather than showing pictures of it, so the
 * steps cannot drift out of date while the layout changes. A step whose target
 * is not on screen — the environment panel for a guest, say — is dropped
 * before the tour starts instead of highlighting nothing.
 *
 * The page behind is covered and inert for the duration: a tour that lets you
 * click halfway through a step ends up describing a screen you already left.
 */
export function Tour({ open, steps, audience, onFinish, onSkip }: TourProps) {
  const [active, setActive] = useState<TourStep[]>([]);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState({ width: CARD_WIDTH, height: FALLBACK_HEIGHT });
  const cardRef = useRef<HTMLDivElement>(null);

  // Resolve the step list once per run, against the DOM as it actually is.
  useEffect(() => {
    if (!open) {
      setActive([]);
      setIndex(0);
      return;
    }
    setActive(
      steps.filter(
        (step) =>
          (!step.audience || step.audience === audience) &&
          (!step.target || document.querySelector(step.target) !== null),
      ),
    );
    setIndex(0);
  }, [open, steps, audience]);

  const step = active[index];

  const locate = useCallback(() => {
    if (!step?.target) {
      setBox(null);
      return;
    }
    const element = document.querySelector(step.target);
    setBox(element ? measure(element) : null);
  }, [step]);

  // Bring the target into view, then measure once the scroll has settled.
  useEffect(() => {
    if (!open || !step) return;
    const element = step.target ? document.querySelector(step.target) : null;
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const frame = requestAnimationFrame(locate);

    const onChange = () => locate();
    window.addEventListener('resize', onChange);
    // Capture, because the panes scroll independently of the window.
    window.addEventListener('scroll', onChange, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [open, step, locate]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    setCardSize({ width: rect.width, height: rect.height });
  }, [index, active.length, box?.top, box?.left]);

  // Focus moves to the card on every step so a screen reader reads the new
  // copy and the arrow keys reach the right element.
  useEffect(() => {
    if (!open || !step) return;
    cardRef.current?.focus();
  }, [open, step, index]);

  const total = active.length;
  const last = index >= total - 1;

  const next = useCallback(() => {
    if (last) {
      onFinish();
      return;
    }
    setIndex((current) => current + 1);
  }, [last, onFinish]);

  const back = useCallback(() => {
    setIndex((current) => Math.max(0, current - 1));
  }, []);

  useEffect(() => {
    if (!open || !step) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSkip();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        back();
      } else if (event.key === 'Tab') {
        // The rest of the page is covered, so Tab cycles inside the card
        // instead of walking into controls the tour has disabled.
        const focusable = cardRef.current?.querySelectorAll<HTMLElement>('button');
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const final = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          final?.focus();
        } else if (!event.shiftKey && document.activeElement === final) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step, next, back, onSkip]);

  if (!open || !step) return null;

  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;

  let cardTop = Math.max(GAP, viewportHeight / 2 - cardSize.height / 2);
  let cardLeft = Math.max(GAP, viewportWidth / 2 - cardSize.width / 2);

  if (box) {
    const rightRoom = viewportWidth - (box.left + box.width);
    const belowRoom = viewportHeight - (box.top + box.height);

    if (rightRoom >= cardSize.width + GAP * 2) {
      cardLeft = box.left + box.width + GAP;
      cardTop = box.top;
    } else if (box.left >= cardSize.width + GAP * 2) {
      cardLeft = box.left - cardSize.width - GAP;
      cardTop = box.top;
    } else if (belowRoom >= cardSize.height + GAP * 2) {
      cardLeft = box.left;
      cardTop = box.top + box.height + GAP;
    } else {
      cardLeft = box.left;
      cardTop = Math.max(GAP, box.top - cardSize.height - GAP);
    }

    cardLeft = Math.min(Math.max(GAP, cardLeft), viewportWidth - cardSize.width - GAP);
    cardTop = Math.min(Math.max(GAP, cardTop), viewportHeight - cardSize.height - GAP);
  }

  return (
    <div className="tourRoot">
      {/*
       * The blocker is separate from the dimming, and always present. The
       * spotlight dims with a box-shadow it cannot catch clicks through, so
       * without this the app stayed clickable underneath a layer too dark to
       * read — the worst of both behaviours.
       */}
      <div className="tourBlock" />
      {box ? (
        <div
          className="tourSpot"
          style={{
            top: `${box.top - 4}px`,
            left: `${box.left - 4}px`,
            width: `${box.width + 8}px`,
            height: `${box.height + 8}px`,
          }}
        />
      ) : (
        <div className="tourVeil" />
      )}

      <div
        className="tourCard"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`tour-title-${step.id}`}
        aria-describedby={`tour-body-${step.id}`}
        tabIndex={-1}
        style={{ top: `${cardTop}px`, left: `${cardLeft}px`, width: `${CARD_WIDTH}px` }}
      >
        <p className="tourProgress">
          Step {index + 1} of {total}
        </p>
        <h2 id={`tour-title-${step.id}`}>{step.title}</h2>
        <p id={`tour-body-${step.id}`}>{step.body}</p>
        <div className="tourActions">
          <button type="button" className="ghost" onClick={onSkip}>
            {last ? 'Close' : 'Skip tour'}
          </button>
          <span className="row">
            {index > 0 ? (
              <button type="button" onClick={back}>
                Back
              </button>
            ) : null}
            <button type="button" className="primary" onClick={next}>
              {last ? 'Finish' : 'Next'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
