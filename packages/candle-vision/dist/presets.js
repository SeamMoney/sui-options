export const CANDLE_VISION_THEMES = {
    terminal: {
        bullish: '#7CFF9B',
        bearish: '#FF6370',
        neutral: '#FFD166',
        compression: '#67D5FF',
        setup: '#B58CFF',
        ta: '#FFB454',
        text: '#F7FAFC',
    },
    'tradingview-dark': {
        bullish: '#26a69a',
        bearish: '#ef5350',
        neutral: '#f5c542',
        compression: '#4fc3f7',
        setup: '#9575cd',
        ta: '#ffa726',
        text: '#d1d4dc',
    },
    lux: {
        bullish: '#42d267',
        bearish: '#ff473d',
        neutral: '#f4c542',
        compression: '#2da8ff',
        setup: '#b026ff',
        ta: '#ff9800',
        text: '#f8fafc',
    },
    paper: {
        bullish: '#15803d',
        bearish: '#dc2626',
        neutral: '#b45309',
        compression: '#0284c7',
        setup: '#7c3aed',
        ta: '#ea580c',
        text: '#111827',
    },
};
export const CANDLE_VISION_OVERLAY_PRESETS = {
    minimal: {
        showLabels: true,
        showConfidence: false,
        maxLabels: 3,
        maxEvents: 8,
        minDisplayConfidence: 0.82,
        fillOpacity: 0.012,
        strokeOpacity: 0.28,
        scanlineOpacity: 0.24,
    },
    computerVision: {
        showLabels: true,
        showConfidence: true,
        maxLabels: 8,
        maxEvents: 18,
        minDisplayConfidence: 0.68,
        fillOpacity: 0.026,
        strokeOpacity: 0.48,
        scanlineOpacity: 0.72,
    },
    denseScanner: {
        showLabels: false,
        showConfidence: false,
        maxLabels: 0,
        maxEvents: 80,
        minDisplayConfidence: 0.58,
        fillOpacity: 0.008,
        strokeOpacity: 0.22,
        scanlineOpacity: 0.18,
    },
};
export const CANDLE_VISION_RANKING_PRESETS = {
    default: {
        maxVisible: 12,
        minVisibleScore: 0.58,
        recencyWindow: 120,
        allowOverlaps: false,
        perKindLimit: 2,
        perFamilyLimit: 8,
    },
    liveTrading: {
        maxVisible: 6,
        minVisibleScore: 0.68,
        recencyWindow: 48,
        allowOverlaps: false,
        perKindLimit: 1,
        perFamilyLimit: 4,
        statusWeights: {
            confirmed: 1,
            forming: 0.62,
            invalidated: 0,
            expired: 0.08,
        },
    },
    research: {
        maxVisible: 40,
        minVisibleScore: 0.25,
        recencyWindow: 300,
        allowOverlaps: true,
        perKindLimit: 8,
        perFamilyLimit: 40,
    },
};
export function createCandleVisionPreset({ theme = 'terminal', overlay = 'computerVision', ranking = 'default', } = {}) {
    return {
        theme: CANDLE_VISION_THEMES[theme],
        overlay: {
            ...CANDLE_VISION_OVERLAY_PRESETS[overlay],
            theme: CANDLE_VISION_THEMES[theme],
        },
        ranking: CANDLE_VISION_RANKING_PRESETS[ranking],
    };
}
//# sourceMappingURL=presets.js.map