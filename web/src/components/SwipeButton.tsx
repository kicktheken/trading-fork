import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  busy: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  // 0..1 — how far the thumb must travel (relative to track width) to fire.
  threshold?: number;
}

export function SwipeButton({ label, busy, disabled, onConfirm, threshold = 0.85 }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0); // px the thumb has moved from left edge
  const [maxOffset, setMaxOffset] = useState(0);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startOffset = useRef(0);
  const firedRef = useRef(false);

  useEffect(() => {
    const measure = () => {
      const track = trackRef.current;
      if (!track) return;
      // Thumb is square; max travel = track width minus thumb size (we use the
      // track height as the thumb size).
      const trackW = track.clientWidth;
      const thumbSize = track.clientHeight;
      setMaxOffset(Math.max(0, trackW - thumbSize));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, []);

  // Reset thumb position whenever busy clears (after submit completes).
  useEffect(() => {
    if (!busy) {
      firedRef.current = false;
      setOffset(0);
    }
  }, [busy]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (busy || disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    startX.current = e.clientX;
    startOffset.current = offset;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || busy || disabled) return;
    const dx = e.clientX - startX.current;
    const next = Math.min(maxOffset, Math.max(0, startOffset.current + dx));
    setOffset(next);
    if (!firedRef.current && maxOffset > 0 && next >= maxOffset * threshold) {
      firedRef.current = true;
      dragging.current = false;
      setOffset(maxOffset);
      onConfirm();
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!dragging.current) return;
    dragging.current = false;
    if (!firedRef.current) {
      // Snap back if not far enough.
      setOffset(0);
    }
  };

  const pct = maxOffset > 0 ? offset / maxOffset : 0;

  return (
    <div className={`swipe-track${disabled || busy ? ' is-disabled' : ''}`} ref={trackRef}>
      <div className="swipe-fill" style={{ width: `${pct * 100}%` }} />
      <div className="swipe-label">
        {busy ? 'Submitting…' : firedRef.current ? 'Submitted' : label}
      </div>
      <div
        className="swipe-thumb"
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="button"
        aria-label={label}
      >
        →
      </div>
    </div>
  );
}
