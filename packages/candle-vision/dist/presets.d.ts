import type { PatternSignalRankingOptions } from './ranking';
import type { PatternOverlayOptions } from './renderers/pattern-overlay';
import type { CandlePatternTheme } from './types';
export type CandleVisionThemeName = 'terminal' | 'tradingview-dark' | 'lux' | 'paper';
export type CandleVisionPreset = {
    theme: CandlePatternTheme;
    overlay: PatternOverlayOptions;
    ranking: PatternSignalRankingOptions;
};
export declare const CANDLE_VISION_THEMES: Record<CandleVisionThemeName, CandlePatternTheme>;
export declare const CANDLE_VISION_OVERLAY_PRESETS: {
    minimal: {
        showLabels: true;
        showConfidence: false;
        maxLabels: number;
        maxEvents: number;
        minDisplayConfidence: number;
        fillOpacity: number;
        strokeOpacity: number;
        scanlineOpacity: number;
    };
    computerVision: {
        showLabels: true;
        showConfidence: true;
        maxLabels: number;
        maxEvents: number;
        minDisplayConfidence: number;
        fillOpacity: number;
        strokeOpacity: number;
        scanlineOpacity: number;
    };
    denseScanner: {
        showLabels: false;
        showConfidence: false;
        maxLabels: number;
        maxEvents: number;
        minDisplayConfidence: number;
        fillOpacity: number;
        strokeOpacity: number;
        scanlineOpacity: number;
    };
};
export declare const CANDLE_VISION_RANKING_PRESETS: {
    default: {
        maxVisible: number;
        minVisibleScore: number;
        recencyWindow: number;
        allowOverlaps: false;
        perKindLimit: number;
        perFamilyLimit: number;
    };
    liveTrading: {
        maxVisible: number;
        minVisibleScore: number;
        recencyWindow: number;
        allowOverlaps: false;
        perKindLimit: number;
        perFamilyLimit: number;
        statusWeights: {
            confirmed: number;
            forming: number;
            invalidated: number;
            expired: number;
        };
    };
    research: {
        maxVisible: number;
        minVisibleScore: number;
        recencyWindow: number;
        allowOverlaps: true;
        perKindLimit: number;
        perFamilyLimit: number;
    };
};
export declare function createCandleVisionPreset({ theme, overlay, ranking, }?: {
    theme?: CandleVisionThemeName;
    overlay?: keyof typeof CANDLE_VISION_OVERLAY_PRESETS;
    ranking?: keyof typeof CANDLE_VISION_RANKING_PRESETS;
}): CandleVisionPreset;
//# sourceMappingURL=presets.d.ts.map