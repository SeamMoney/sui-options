import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { animationSpecForPattern } from './animation-presets';
import type { CandleInput, CandlePatternEvent, CandlePatternTheme } from './types';

const DEFAULT_THEME: CandlePatternTheme = {
  bullish: '#22c55e',
  bearish: '#ef4444',
  neutral: '#facc15',
  compression: '#38bdf8',
  setup: '#a78bfa',
  ta: '#fb923c',
  text: '#f8fafc',
};

export type CandlePatternOverlayV2Options = {
  theme?: Partial<CandlePatternTheme>;
  showLabels?: boolean;
  showConfidence?: boolean;
  maxLabels?: number;
  maxEvents?: number;
  minDisplayConfidence?: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  scanlineOpacity?: number;
  labelCollisionPadding?: number;
};

type LabelBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export class CandlePatternOverlayV2 {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private candles: CandleInput[];
  private events: CandlePatternEvent[];
  private options: Required<Omit<CandlePatternOverlayV2Options, 'theme'>> & { theme: CandlePatternTheme };
  private firstSeen = new Map<string, number>();

  private readonly paneView = {
    zOrder: () => 'top' as const,
    renderer: () => ({
      draw: (target: any) => {
        target.useMediaCoordinateSpace(
          ({ context, mediaSize }: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => {
            this.draw(context, mediaSize);
          },
        );
      },
    }),
  };

  constructor(candles: CandleInput[], events: CandlePatternEvent[], options: CandlePatternOverlayV2Options = {}) {
    this.candles = candles;
    this.events = events;
    this.options = {
      theme: { ...DEFAULT_THEME, ...options.theme },
      showLabels: options.showLabels ?? true,
      showConfidence: options.showConfidence ?? true,
      maxLabels: options.maxLabels ?? 6,
      maxEvents: options.maxEvents ?? 12,
      minDisplayConfidence: options.minDisplayConfidence ?? 0.78,
      fillOpacity: options.fillOpacity ?? 0.018,
      strokeOpacity: options.strokeOpacity ?? 0.34,
      scanlineOpacity: options.scanlineOpacity ?? 0.5,
      labelCollisionPadding: options.labelCollisionPadding ?? 5,
    };
  }

  setData(candles: CandleInput[], events: CandlePatternEvent[]) {
    this.candles = candles;
    this.events = events;
    const now = performance.now();
    for (const event of events) {
      if (!this.firstSeen.has(event.id)) this.firstSeen.set(event.id, now);
    }
    this.requestUpdate?.();
  }

  attached(param: any) {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return [this.paneView];
  }

  updateAllViews() {
    this.requestUpdate?.();
  }

  private x(index: number) {
    return this.chart?.timeScale().logicalToCoordinate(index as any) ?? null;
  }

  private y(price: number) {
    return this.series?.priceToCoordinate(price) ?? null;
  }

  private eventColor(event: CandlePatternEvent) {
    const theme = this.options.theme;
    if (event.kind === 'vision-compression') return theme.compression;
    if (event.family === 'chart-setup') return theme.setup;
    if (
      event.kind.startsWith('ma-') ||
      event.kind.startsWith('rsi-') ||
      event.kind.startsWith('macd-') ||
      event.kind.startsWith('bollinger-') ||
      event.kind.startsWith('volume-') ||
      event.kind.startsWith('atr-') ||
      event.kind.startsWith('vwap-')
    ) {
      return theme.ta;
    }
    if (event.direction === 'bullish') return theme.bullish;
    if (event.direction === 'bearish') return theme.bearish;
    return theme.neutral;
  }

  private isComputerVisionEvent(event: CandlePatternEvent) {
    return event.family === 'vision-candle' || event.family === 'chart-setup' || event.kind.startsWith('vision-');
  }

  private visibleEvents() {
    return this.events
      .filter((event) => event.confidence >= this.options.minDisplayConfidence)
      .slice(-this.options.maxEvents);
  }

  private introProgress(event: CandlePatternEvent, now: number) {
    const firstSeen = this.firstSeen.get(event.id) ?? now;
    const elapsed = now - firstSeen;
    const spec = animationSpecForPattern(event);
    return Math.max(0, Math.min(1, elapsed / (spec.duration * 1000)));
  }

  private draw(ctx: CanvasRenderingContext2D, mediaSize: { width: number; height: number }) {
    if (!this.chart || !this.series || !this.events.length) return;
    const now = performance.now();
    const visibleEvents = this.visibleEvents();
    const labelBoxes: LabelBox[] = [];

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = '11px Arial, Helvetica, sans-serif';

    for (const event of visibleEvents) {
      const start = this.candles[event.startIndex];
      const end = this.candles[event.endIndex];
      if (!start || !end) continue;

      const xStart = this.x(event.startIndex);
      const xEnd = this.x(event.endIndex);
      const span = this.candles.slice(event.startIndex, event.endIndex + 1);
      const yHigh = this.y(Math.max(...span.map((bar) => bar.high)));
      const yLow = this.y(Math.min(...span.map((bar) => bar.low)));
      if (xStart == null || xEnd == null || yHigh == null || yLow == null) continue;

      const color = this.eventColor(event);
      const progress = easeOutCubic(this.introProgress(event, now));
      const spec = animationSpecForPattern(event);
      const left = Math.min(xStart, xEnd) - 5;
      const right = Math.max(xStart, xEnd) + 5;
      const top = Math.min(yHigh, yLow) - 7;
      const bottom = Math.max(yHigh, yLow) + 7;
      if (right < -30 || left > mediaSize.width + 30 || bottom < -30 || top > mediaSize.height + 30) continue;

      const isVision = this.isComputerVisionEvent(event);
      this.drawDetectionBox(ctx, event, color, progress, spec, left, top, right, bottom, isVision, now);

      if (this.options.showLabels && event.confidence >= Math.max(0.82, this.options.minDisplayConfidence)) {
        this.drawLabel(ctx, mediaSize, event, color, progress, labelBoxes, isVision);
      }
    }

    ctx.restore();
  }

  private drawDetectionBox(
    ctx: CanvasRenderingContext2D,
    event: CandlePatternEvent,
    color: string,
    progress: number,
    spec: ReturnType<typeof animationSpecForPattern>,
    left: number,
    top: number,
    right: number,
    bottom: number,
    isVision: boolean,
    now: number,
  ) {
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    ctx.save();
    ctx.globalAlpha = (isVision ? this.options.fillOpacity * 2.6 : this.options.fillOpacity) * progress;
    ctx.fillStyle = color;
    drawRoundedRect(ctx, left, top, width, height, isVision ? 2 : 4);
    ctx.fill();
    ctx.restore();

    if (isVision) {
      this.drawVisionGrid(ctx, color, progress, left, top, right, bottom, now);
      this.drawCornerBrackets(ctx, color, progress, left, top, right, bottom);
      this.drawConfidenceRail(ctx, event, color, progress, right, top, bottom);
      this.drawAnchorPings(ctx, event, color, progress, now);
    }

    ctx.save();
    ctx.globalAlpha = (isVision ? Math.min(0.96, this.options.strokeOpacity * 1.45) : this.options.strokeOpacity) * progress;
    ctx.strokeStyle = color;
    ctx.lineWidth = isVision ? 1.65 : event.status === 'confirmed' ? 1.15 : 0.95;
    if (event.status === 'forming' || spec.strokeDash || isVision) ctx.setLineDash(isVision ? [7, 5] : spec.strokeDash ?? [5, 6]);
    drawRoundedRect(ctx, left + 0.5, top + 0.5, width, height, isVision ? 2 : 4);
    ctx.stroke();
    ctx.restore();
  }

  private drawVisionGrid(ctx: CanvasRenderingContext2D, color: string, progress: number, left: number, top: number, right: number, bottom: number, now: number) {
    const width = right - left;
    const height = bottom - top;
    const sweep = top + ((now / 9) % Math.max(12, height + 24)) - 12;

    ctx.save();
    ctx.beginPath();
    drawRoundedRect(ctx, left, top, width, height, 2);
    ctx.clip();

    ctx.globalAlpha = 0.18 * progress;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 7]);
    for (let x = left + 8; x < right; x += 12) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    for (let y = top + 8; y < bottom; y += 12) {
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }

    ctx.globalAlpha = this.options.scanlineOpacity * progress;
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(left, sweep);
    ctx.lineTo(right, sweep);
    ctx.stroke();

    const gradient = ctx.createLinearGradient(0, sweep - 10, 0, sweep + 10);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.5, color);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 0.1 * progress;
    ctx.fillStyle = gradient;
    ctx.fillRect(left, sweep - 12, width, 24);
    ctx.restore();
  }

  private drawCornerBrackets(ctx: CanvasRenderingContext2D, color: string, progress: number, left: number, top: number, right: number, bottom: number) {
    const length = Math.min(18, Math.max(8, (right - left) * 0.22));
    ctx.save();
    ctx.globalAlpha = 0.92 * progress;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    drawCorner(ctx, left, top, length, 1, 1);
    drawCorner(ctx, right, top, length, -1, 1);
    drawCorner(ctx, left, bottom, length, 1, -1);
    drawCorner(ctx, right, bottom, length, -1, -1);
    ctx.restore();
  }

  private drawConfidenceRail(ctx: CanvasRenderingContext2D, event: CandlePatternEvent, color: string, progress: number, right: number, top: number, bottom: number) {
    const height = bottom - top;
    const railHeight = Math.max(3, height * event.confidence);
    ctx.save();
    ctx.globalAlpha = 0.82 * progress;
    ctx.fillStyle = 'rgba(15, 23, 42, .78)';
    ctx.fillRect(right + 3, top, 3, height);
    ctx.fillStyle = color;
    ctx.fillRect(right + 3, bottom - railHeight, 3, railHeight);
    ctx.restore();
  }

  private drawAnchorPings(ctx: CanvasRenderingContext2D, event: CandlePatternEvent, color: string, progress: number, now: number) {
    const pulse = 0.5 + Math.sin(now / 170) * 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    for (const anchor of event.anchors.slice(-3)) {
      const x = this.x(anchor.index);
      const y = this.y(anchor.price);
      if (x == null || y == null) continue;
      ctx.globalAlpha = (0.26 + pulse * 0.2) * progress;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 5 + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.86 * progress;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    mediaSize: { width: number; height: number },
    event: CandlePatternEvent,
    color: string,
    progress: number,
    boxes: LabelBox[],
    isVision: boolean,
  ) {
    if (boxes.length >= this.options.maxLabels) return;
    const candle = this.candles[event.endIndex];
    if (!candle) return;

    const x = this.x(event.endIndex);
    const y = this.y(event.direction === 'bearish' ? candle.high : candle.low);
    if (x == null || y == null) return;

    const prefix = isVision ? 'SCAN' : event.family === 'chart-setup' ? 'SETUP' : 'PATTERN';
    const label = this.options.showConfidence ? `${prefix} ${event.label} ${(event.confidence * 100).toFixed(0)}%` : `${prefix} ${event.label}`;
    const width = Math.min(260, Math.max(84, ctx.measureText(label).width + 22));
    const height = isVision ? 24 : 21;
    const labelX = Math.min(mediaSize.width - width - 8, Math.max(8, x - width / 2));
    const preferredY = event.direction === 'bearish' ? y - 25 : y + 25;
    const labelY = findFreeLabelY(preferredY, width, height, labelX, boxes, mediaSize.height, this.options.labelCollisionPadding);

    boxes.push({ x: labelX, y: labelY - height / 2, width, height });
    ctx.save();
    ctx.globalAlpha = progress;
    ctx.translate(0, (1 - progress) * 4);
    ctx.fillStyle = isVision ? 'rgba(4, 13, 26, .94)' : 'rgba(15, 23, 42, .9)';
    ctx.strokeStyle = color;
    ctx.lineWidth = isVision ? 1.35 : 1;
    drawRoundedRect(ctx, labelX, labelY - height / 2, width, height, 5);
    ctx.fill();
    ctx.stroke();
    if (isVision) {
      ctx.globalAlpha = 0.34 * progress;
      ctx.fillStyle = color;
      ctx.fillRect(labelX + 7, labelY - height / 2 + 5, 3, height - 10);
    }
    ctx.fillStyle = this.options.theme.text;
    ctx.globalAlpha = 0.96 * progress;
    ctx.textAlign = 'center';
    ctx.fillText(label, labelX + width / 2, labelY);
    ctx.restore();
  }
}

function findFreeLabelY(
  preferredY: number,
  width: number,
  height: number,
  x: number,
  boxes: LabelBox[],
  mediaHeight: number,
  padding: number,
) {
  const candidates = [preferredY, preferredY - 24, preferredY + 24, preferredY - 48, preferredY + 48];
  for (const y of candidates) {
    const box = { x, y: y - height / 2, width, height };
    if (box.y < 8 || box.y + height > mediaHeight - 8) continue;
    if (!boxes.some((other) => intersects(box, other, padding))) return y;
  }
  return Math.max(18, Math.min(mediaHeight - 18, preferredY));
}

function intersects(a: LabelBox, b: LabelBox, padding: number) {
  return !(
    a.x + a.width + padding < b.x ||
    b.x + b.width + padding < a.x ||
    a.y + a.height + padding < b.y ||
    b.y + b.height + padding < a.y
  );
}

function drawCorner(ctx: CanvasRenderingContext2D, x: number, y: number, length: number, xDirection: 1 | -1, yDirection: 1 | -1) {
  ctx.beginPath();
  ctx.moveTo(x, y + yDirection * length);
  ctx.lineTo(x, y);
  ctx.lineTo(x + xDirection * length, y);
  ctx.stroke();
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
