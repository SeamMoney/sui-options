'use client';

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import gsap from 'gsap';
import {
  PATTERN_ANIMATION_PRESETS,
  animationSpecForPattern,
  prefersReducedPatternMotion,
  type PatternAnimationPreset,
} from '@/lib/candle-vision/animation-presets';
import type { CandlePatternEvent } from '@/lib/candle-vision';

export type MotionVariant = {
  initial: Record<string, number | string>;
  animate: Record<string, number | string>;
  exit?: Record<string, number | string>;
  transition: { duration: number; ease?: string };
};

export function motionVariantForPreset(preset: PatternAnimationPreset): MotionVariant {
  const spec = PATTERN_ANIMATION_PRESETS[preset];
  return {
    initial: { opacity: 0, y: spec.labelOffsetY ?? -4, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -4, scale: 0.98 },
    transition: { duration: Math.min(0.2, spec.duration), ease: 'easeOut' },
  };
}

export function usePatternPanelAnimation(rootRef: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || prefersReducedPatternMotion()) return undefined;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        '[data-pattern-motion]',
        { autoAlpha: 0, y: -6 },
        { autoAlpha: 1, y: 0, duration: 0.18, stagger: 0.025, ease: 'power2.out' },
      );
    }, root);

    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function usePatternEventPulse(events: CandlePatternEvent[]) {
  const seenRef = useRef(new Set<string>());

  return useMemo(() => {
    const newEvents = events.filter((event) => !seenRef.current.has(event.id));
    for (const event of events) seenRef.current.add(event.id);
    return newEvents.map((event) => ({
      event,
      spec: animationSpecForPattern(event),
      motion: motionVariantForPreset(animationSpecForPattern(event).preset),
    }));
  }, [events]);
}
