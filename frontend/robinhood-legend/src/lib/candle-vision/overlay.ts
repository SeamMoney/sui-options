import type { IChartApi, ISeriesApi } from 'lightweight-charts';
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

type PrimitiveOptions = {
  theme?: Partial<CandlePatternTheme>;
  showLabels?: boolean;
  showConfidence?: boolean;
  maxLabels?: number;
  maxEvents?: number;
  minDisplayConfidence?: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  anchorOpacity?: number;
  drawAnchors?: boolean;
};

export class CandlePatternHighlightPrimitive {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate: (() => void) | null = null;
  private candles: CandleInput[];
  private events: CandlePatternEvent[];
  private theme: CandlePatternTheme;
  private showLabels: boolean;
  private showConfidence: boolean;
  private maxLabels: number;
  private maxEvents: number;
  private minDisplayConfidence: number;
  private fillOpacity: number;
  private strokeOpacity: number;
  private anchorOpacity: number;
  private drawAnchors: boolean;

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

  constructor(candles: CandleInput[], events: CandlePatternEvent[], options: PrimitiveOptions = {}) {
    this.candles = candles;
    this.events = events;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.showLabels = options.showLabels ?? true;
    this.showConfidence = options.showConfidence ?? true;
    this.maxLabels = options.maxLabels ?? 14;
    this.maxEvents = options.maxEvents ?? 28;
    this.minDisplayConfidence = options.minDisplayConfidence ?? 0;
    this.fillOpacity = options.fillOpacity ?? 0.045;
    this.strokeOpacity = options.strokeOpacity ?? 0.45;
    this.anchorOpacity = options.anchorOpacity ?? 0.32;
    this.drawAnchors = options.drawAnchors ?? true;
  }

  setData(candles: CandleInput[], events: CandlePatternEvent[]) {
    this.candles = candles;
    this.events = events;
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
    if (event.kind === 'vision-compression') return this.theme.compression;
    if (event.family === 'chart-setup') return this.theme.setup;
    if (event.kind.startsWith('ma-') || event.kind.startsWith('rsi-') || event.kind.startsWith('macd-') || event.kind.startsWith('bollinger-') || event.kind.startsWith('volume-') || event.kind.startsWith('atr-') || event.kind.startsWith('vwap-')) return this.theme.ta;
    if (event.direction === 'bullish') return this.theme.bullish;
    if (event.direction === 'bearish') return this.theme.bearish;
    return this.theme.neutral;
  }

  private visibleEvents() {
    return this.events
      .filter((event) => event.confidence >= this.minDisplayConfidence)
      .slice(-this.maxEvents);
  }

  private draw(ctx: CanvasRenderingContext2D, mediaSize: { width: number; height: number }) {
    if (!this.chart || !this.series || !this.events.length) return;
    const now = performance.now();
    const visibleEvents = this.visibleEvents();
    const labelEvents = visibleEvents
      .filter((event) => event.confidence >= Math.max(this.minDisplayConfidence, 0.78))
      .slice(-this.maxLabels);

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = '11px Arial, Helvetica, sans-serif';

    for (const event of visibleEvents) {
      const start = this.candles[event.startIndex];
      const end = this.candles[event.endIndex];
      if (!start || !end) continue;

      const xStart = this.x(event.startIndex);
      const xEnd = this.x(event.endIndex);
      const high = Math.max(...this.candles.slice(event.startIndex, event.endIndex + 1).map((bar) => bar.high));
      const low = Math.min(...this.candles.slice(event.startIndex, event.endIndex + 1).map((bar) => bar.low));
      const yHigh = this.y(high);
      const yLow = this.y(low);
      if (xStart == null || xEnd == null || yHigh == null || yLow == null) continue;

      const color = this.eventColor(event);
      const left = Math.min(xStart, xEnd) - 5;
      const right = Math.max(xStart, xEnd) + 5;
      const top = Math.min(yHigh, yLow) - 7;
      const bottom = Math.max(yHigh, yLow) + 7;
      if (right < -30 || left > mediaSize.width + 30 || bottom < -30 || top > mediaSize.height + 30) continue;

      const pulse = event.status === 'forming' ? 0.55 + Math.sin(now / 180) * 0.22 : 0.72 + Math.sin(now / 260 + event.endIndex) * 0.12;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = event.family === 'vision-candle' ? 1.15 : 0.85;
      ctx.globalAlpha = this.strokeOpacity;
      if (event.status === 'forming') ctx.setLineDash([5, 6]);
      ctx.strokeRect(left + 0.5, top + 0.5, Math.max(1, right - left), Math.max(1, bottom - top));
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = event.family === 'vision-candle' ? this.fillOpacity + pulse * 0.015 : this.fillOpacity;
      ctx.fillStyle = color;
      ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
      ctx.restore();

      if (!this.drawAnchors) continue;
      const anchor = event.anchors.find((item) => item.role === 'confirmation') ?? event.anchors[event.anchors.length - 1];
      const anchorX = this.x(anchor?.index ?? event.endIndex);
      const anchorY = this.y(anchor?.price ?? end.close);
      if (anchorX != null && anchorY != null) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = this.anchorOpacity * pulse;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(anchorX, anchorY, 5 + pulse * 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = Math.min(0.9, this.anchorOpacity + 0.28);
        ctx.beginPath();
        ctx.arc(anchorX, anchorY, 2.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (this.showLabels) {
      for (const event of labelEvents) {
        const candle = this.candles[event.endIndex];
        if (!candle) continue;
        const x = this.x(event.endIndex);
        const y = this.y(event.direction === 'bearish' ? candle.high : candle.low);
        if (x == null || y == null) continue;
        const color = this.eventColor(event);
        const label = this.showConfidence ? `${event.label} ${(event.confidence * 100).toFixed(0)}%` : event.label;
        const width = Math.min(220, Math.max(62, ctx.measureText(label).width + 14));
        const labelX = Math.min(mediaSize.width - width - 8, Math.max(8, x - width / 2));
        const labelY = event.direction === 'bearish' ? Math.max(18, y - 22) : Math.min(mediaSize.height - 18, y + 22);

        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, .86)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        roundRect(ctx, labelX, labelY - 10, width, 20, 5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = this.theme.text;
        ctx.globalAlpha = 0.96;
        ctx.textAlign = 'center';
        ctx.fillText(label, labelX + width / 2, labelY);
        ctx.restore();
      }
    }

    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}
