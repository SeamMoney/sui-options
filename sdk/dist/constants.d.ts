import type { Side, Direction, Status } from "./types.js";
export declare const SIDE_TOUCH = 0;
export declare const SIDE_NO_TOUCH = 1;
export declare const DIR_ABOVE = 0;
export declare const DIR_BELOW = 1;
export declare const STATUS_ACTIVE = 0;
export declare const STATUS_HIT = 1;
export declare const STATUS_EXPIRED = 2;
export declare const STATUS_NAME: Record<number, Status>;
export declare const DIRECTION_NAME: Record<number, Direction>;
export declare const SIDE_NAME: Record<number, Side>;
export declare const SIDE_CODE: Record<Side, number>;
export declare const DIRECTION_CODE: Record<Direction, number>;
/** Move error codes from move/sources/wick.move (kept in sync by hand). */
export declare const ERROR_CODES: Record<number, string>;
//# sourceMappingURL=constants.d.ts.map