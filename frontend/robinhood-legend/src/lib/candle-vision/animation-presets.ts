import type { CandlePatternEvent } from './types';

export type PatternAnimationPreset =
  | 'reversal-pop'
  | 'compression-scan'
  | 'breakout-sweep'
  | 'ta-cross-flash'
  | 'structure-draw'
  | 'forming-breathe'
  | 'confirmed-lock';

export type PatternAnimationSpec = {
  preset: PatternAnimationPreset;
  duration: number;
  delay?: number;
  ease: string;
  strokeDash?: number[];
  pulseScale?: number;
  sweepOpacity?: number;
  labelOffsetY?: number;
};

export const PATTERN_ANIMATION_PRESETS: Record<PatternAnimationPreset, PatternAnimationSpec> = {
  'reversal-pop': {
    preset: 'reversal-pop',
    duration: 0.32,
    ease: 'power2.out',
    pulseScale: 1.08,
    sweepOpacity: 0.18,
    labelOffsetY: -6,
  },
  'compression-scan': {
    preset: 'compression-scan',
    duration: 0.42,
    ease: 'power1.out',
    strokeDash: [5, 6],
    pulseScale: 1.02,
    sweepOpacity: 0.12,
  },
  'breakout-sweep': {
    preset: 'breakout-sweep',
    duration: 0.36,
    ease: 'power3.out',
    pulseScale: 1.12,
    sweepOpacity: 0.22,
    labelOffsetY: -8,
  },
  'ta-cross-flash': {
    preset: 'ta-cross-flash',
    duration: 0.22,
    ease: 'power2.out',
    pulseScale: 1.04,
    sweepOpacity: 0.16,
  },
  'structure-draw': {
    preset: 'structure-draw',
    duration: 0.5,
    ease: 'power2.out',
    strokeDash: [8, 5],
    pulseScale: 1,
    sweepOpacity: 0.1,
  },
  'forming-breathe': {
    preset: 'forming-breathe',
    duration: 0.9,
    ease: 'sine.inOut',
    strokeDash: [4, 7],
    pulseScale: 1.015,
    sweepOpacity: 0.08,
  },
  'confirmed-lock': {
    preset: 'confirmed-lock',
    duration: 0.18,
    ease: 'power1.out',
    pulseScale: 1,
    sweepOpacity: 0.06,
  },
};

export function presetForPattern(event: CandlePatternEvent): PatternAnimationPreset {
  if (event.status === 'forming') return 'forming-breathe';
  if (event.kind === 'vision-compression' || event.kind.includes('squeeze')) return 'compression-scan';
  if (event.kind.includes('breakout') || event.kind.includes('breakdown') || event.kind.includes('reclaim')) return 'breakout-sweep';
  if (
    event.kind.startsWith('ma-') ||
    event.kind.startsWith('rsi-') ||
    event.kind.startsWith('macd-') ||
    event.kind.startsWith('bollinger-') ||
    event.kind.startsWith('atr-') ||
    event.kind.startsWith('vwap-') ||
    event.kind.startsWith('volume-')
  ) {
    return 'ta-cross-flash';
  }
  if (event.family === 'chart-setup') return 'structure-draw';
  if (event.status === 'confirmed') return 'reversal-pop';
  return 'confirmed-lock';
}

export function animationSpecForPattern(event: CandlePatternEvent) {
  return PATTERN_ANIMATION_PRESETS[presetForPattern(event)];
}

export function prefersReducedPatternMotion() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
