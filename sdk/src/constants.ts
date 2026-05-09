import type { Side, Direction, Status } from "./types.js";

export const SIDE_TOUCH = 0;
export const SIDE_NO_TOUCH = 1;

export const DIR_ABOVE = 0;
export const DIR_BELOW = 1;

export const STATUS_ACTIVE = 0;
export const STATUS_HIT = 1;
export const STATUS_EXPIRED = 2;

export const STATUS_NAME: Record<number, Status> = {
  0: "ACTIVE",
  1: "HIT",
  2: "EXPIRED",
};

export const DIRECTION_NAME: Record<number, Direction> = {
  0: "ABOVE",
  1: "BELOW",
};

export const SIDE_NAME: Record<number, Side> = {
  0: "TOUCH",
  1: "NO_TOUCH",
};

export const SIDE_CODE: Record<Side, number> = { TOUCH: 0, NO_TOUCH: 1 };
export const DIRECTION_CODE: Record<Direction, number> = { ABOVE: 0, BELOW: 1 };

/** Move error codes from move/sources/wick.move (kept in sync by hand). */
export const ERROR_CODES: Record<number, string> = {
  1: "barrier price must be > 0",
  2: "expiry must be strictly in the future",
  3: "collateral payment must be > 0",
  4: "direction must be DIR_ABOVE or DIR_BELOW",
  5: "fee_bps must be <= 10_000",
  6: "market is not active",
  7: "market expiry has passed",
  8: "position belongs to a different market",
  9: "position is on the wrong side",
  10: "complete-set redeem requires equal TOUCH and NO_TOUCH amounts",
  11: "oracle has not crossed the barrier",
  12: "market has not yet reached expiry",
  13: "position is on the losing side",
  14: "swap output amount is zero",
  15: "market is still active; settlement required before redeem_winner",
  16: "market is still active; settlement required before redeem_lp",
  17: "lp position has zero shares",
};
