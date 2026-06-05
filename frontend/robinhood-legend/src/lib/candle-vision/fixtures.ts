import type { CandleInput } from './types';

export type CandleFixtureOptions = {
  seed?: number;
  count?: number;
  startTime?: number;
  startPrice?: number;
};

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalish(rand: () => number) {
  return rand() + rand() + rand() + rand() - 2;
}

function bar(time: number, open: number, close: number, high: number, low: number, volume = 1000): CandleInput {
  return { time, open, high: Math.max(open, close, high), low: Math.min(open, close, low), close, volume };
}

export function createRandomWalkFixture(options: CandleFixtureOptions = {}): CandleInput[] {
  const rand = seeded(options.seed ?? 0xabc123);
  const count = options.count ?? 180;
  const start = options.startTime ?? Math.floor(Date.UTC(2026, 4, 18, 13, 30) / 1000);
  const candles: CandleInput[] = [];
  let close = options.startPrice ?? 104;
  let drift = 0;
  let vol = 0.28;

  for (let i = 0; i < count; i += 1) {
    if (i === 0 || rand() < 0.045) {
      drift = normalish(rand) * 0.025;
      vol = 0.14 + rand() * 0.34;
    }
    const open = close + normalish(rand) * vol * 0.18;
    close = open + drift + normalish(rand) * vol;
    const body = Math.abs(close - open);
    const wick = 0.06 + rand() * (0.12 + vol * 0.6);
    candles.push(bar(start + i * 60, open, close, Math.max(open, close) + wick + body * 0.12, Math.min(open, close) - wick, 900 + rand() * 2600));
  }

  return candles;
}

export function createTrendFixture(options: CandleFixtureOptions & { direction?: 'up' | 'down' } = {}): CandleInput[] {
  const rand = seeded(options.seed ?? 0x7173);
  const count = options.count ?? 120;
  const start = options.startTime ?? Math.floor(Date.UTC(2026, 4, 18, 13, 30) / 1000);
  const sign = options.direction === 'down' ? -1 : 1;
  const candles: CandleInput[] = [];
  let close = options.startPrice ?? 100;

  for (let i = 0; i < count; i += 1) {
    const open = close + normalish(rand) * 0.08;
    close = open + sign * (0.08 + rand() * 0.16) + normalish(rand) * 0.12;
    const wick = 0.08 + rand() * 0.22;
    candles.push(bar(start + i * 60, open, close, Math.max(open, close) + wick, Math.min(open, close) - wick, 1200 + rand() * 1800));
  }

  return candles;
}

export function createChoppyFixture(options: CandleFixtureOptions = {}): CandleInput[] {
  const rand = seeded(options.seed ?? 0x55aa);
  const count = options.count ?? 140;
  const start = options.startTime ?? Math.floor(Date.UTC(2026, 4, 18, 13, 30) / 1000);
  const center = options.startPrice ?? 102;
  const candles: CandleInput[] = [];
  let close = center;

  for (let i = 0; i < count; i += 1) {
    const pull = (center - close) * 0.18;
    const open = close + normalish(rand) * 0.12;
    close = open + pull + normalish(rand) * 0.32;
    const wick = 0.16 + rand() * 0.36;
    candles.push(bar(start + i * 60, open, close, Math.max(open, close) + wick, Math.min(open, close) - wick, 800 + rand() * 1600));
  }

  return candles;
}

export function createBullishEngulfingFixture(options: CandleFixtureOptions = {}): CandleInput[] {
  const candles = createRandomWalkFixture({ ...options, count: Math.max(options.count ?? 80, 24) });
  const i = candles.length - 2;
  const time = candles[i].time;
  candles[i] = bar(time, 101.2, 100.42, 101.36, 100.24, 1400);
  candles[i + 1] = bar(time + 60, 100.2, 101.78, 101.96, 100.02, 4200);
  return candles;
}

export function createMorningStarFixture(options: CandleFixtureOptions = {}): CandleInput[] {
  const candles = createRandomWalkFixture({ ...options, count: Math.max(options.count ?? 80, 24) });
  const i = candles.length - 3;
  const time = candles[i].time;
  candles[i] = bar(time, 103.4, 102.15, 103.55, 102.02, 2200);
  candles[i + 1] = bar(time + 60, 102.04, 102.12, 102.26, 101.9, 900);
  candles[i + 2] = bar(time + 120, 102.18, 103.05, 103.24, 102.08, 3200);
  return candles;
}
