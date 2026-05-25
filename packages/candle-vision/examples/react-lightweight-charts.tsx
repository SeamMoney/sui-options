import { useEffect, useMemo, useRef } from 'react';
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import {
  detectUnifiedCandlePatterns,
  rankVisiblePatternSignals,
  type CandleInput,
} from '@sui-options/candle-vision';
import {
  createLightweightChartsPatternOverlay,
  type LightweightChartsPatternOverlayHandle,
} from '@sui-options/candle-vision/overlay-lightweight-charts';

type CandleVisionChartProps = {
  candles: CandleInput[];
};

function toChartCandle(candle: CandleInput) {
  return {
    time: candle.time as Time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

export function CandleVisionChart({ candles }: CandleVisionChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const overlayRef = useRef<LightweightChartsPatternOverlayHandle | null>(null);

  const visibleEvents = useMemo(() => {
    const events = detectUnifiedCandlePatterns(candles, {
      lookback: 240,
      minConfidence: 0.6,
    });

    return rankVisiblePatternSignals(events, {
      latestIndex: candles.length - 1,
      maxVisible: 10,
      allowOverlaps: false,
    })
      .map((signal) => signal.event);
  }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#e2e8f0',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      rightPriceScale: {
        borderColor: '#334155',
      },
      timeScale: {
        borderColor: '#334155',
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    chartRef.current = chart;
    seriesRef.current = series;
    overlayRef.current = createLightweightChartsPatternOverlay(series, chart, {
      candles,
      events: visibleEvents,
      maxLabels: 8,
    });

    const resize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };

    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      overlayRef.current?.detach();
      chart.remove();
      overlayRef.current = null;
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(candles.map(toChartCandle));
    overlayRef.current?.setData(candles, visibleEvents);
    chartRef.current?.timeScale().fitContent();
  }, [candles, visibleEvents]);

  return <div ref={containerRef} style={{ width: '100%', height: 420 }} />;
}
