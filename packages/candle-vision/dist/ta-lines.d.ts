import type { CandleDirection, CandleInput } from './types';
export type TaLineKind = 'support' | 'resistance' | 'trend' | 'channel-upper' | 'channel-lower' | 'vwap';
export type TaLinePoint = {
    index: number;
    time: number;
    price: number;
};
export type TaLine = {
    id: string;
    kind: TaLineKind;
    label: string;
    direction: CandleDirection;
    confidence: number;
    color: string;
    points: TaLinePoint[];
    style: 'solid' | 'dashed' | 'glow';
};
export type TaLineOptions = {
    lookback?: number;
    swingRadius?: number;
    minSwingDistance?: number;
    channelDeviationMultiplier?: number;
    includeVwap?: boolean;
    maxLines?: number;
};
export declare function deriveTaLines(candles: readonly CandleInput[], options?: TaLineOptions): TaLine[];
//# sourceMappingURL=ta-lines.d.ts.map