/// Status-aware collateral invariant scaffold for Wick Markets.
///
/// While ACTIVE   → collateral_value == total_touch_supply == total_no_touch_supply
/// After HIT      → collateral_value == total_touch_supply       (NO_TOUCH side is dead weight)
/// After EXPIRED  → collateral_value == total_no_touch_supply    (TOUCH side is dead weight)
///
/// If this assertion fires in CI, the breaking change is a loss-of-funds bug.
#[test_only]
module wick::invariants;

use wick::wick::{Self, Market};

const E_INVARIANT_BROKEN: u64 = 9001;

public fun assert_collateral_invariant<C>(m: &Market<C>) {
    let v = wick::collateral_value(m);
    let t = wick::total_touch_supply(m);
    let n = wick::total_no_touch_supply(m);
    let s = wick::status(m);
    if (s == wick::status_active()) {
        assert!(v == t, E_INVARIANT_BROKEN);
        assert!(t == n, E_INVARIANT_BROKEN);
    } else if (s == wick::status_hit()) {
        assert!(v == t, E_INVARIANT_BROKEN);
    } else {
        // STATUS_EXPIRED
        assert!(v == n, E_INVARIANT_BROKEN);
    };
}
