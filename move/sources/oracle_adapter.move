/// Mock oracle adapter — boundary for the production DeepBook Predict adapter.
///
/// MVP: `MockOracle` is shared, mutable in tests via `set_price`. The production
/// adapter will replace this with a Predict-backed reader and keep the
/// `barrier_crossed` shape so call sites do not change.
module wick::oracle_adapter;

#[error(code = 100)]
const E_BAD_DIRECTION: vector<u8> = b"direction must be DIR_ABOVE or DIR_BELOW";

/// Direction codes — duplicated here so this module is independent of `wick::wick`.
const DIR_ABOVE: u8 = 0;
const DIR_BELOW: u8 = 1;

/// Test/demo oracle. Shared so anyone can read.
public struct MockOracle has key {
    id: UID,
    asset_id: vector<u8>,
    price: u64,
}

/// Create and share a new MockOracle with `initial_price`.
public fun create_and_share(
    asset_id: vector<u8>,
    initial_price: u64,
    ctx: &mut TxContext,
) {
    let oracle = MockOracle {
        id: object::new(ctx),
        asset_id,
        price: initial_price,
    };
    transfer::share_object(oracle);
}

/// Demo setter. `MockOracle` is itself the demo oracle — the production
/// adapter is a separate module that wraps a feed and does not expose mutation.
/// Permissionless on purpose so the keeper or any demo runner can move the price.
public fun set_price(o: &mut MockOracle, p: u64) {
    o.price = p;
}

/// Read the current oracle price.
public fun get_price(o: &MockOracle): u64 { o.price }

/// Read the asset id this oracle tracks.
public fun asset_id(o: &MockOracle): &vector<u8> { &o.asset_id }

/// Returns true if the current oracle price has crossed `barrier` in `direction`.
///
/// Semantics:
///   - DIR_ABOVE: price >= barrier
///   - DIR_BELOW: price <= barrier
///
/// Aborts with `E_BAD_DIRECTION` for any other value.
public fun barrier_crossed(o: &MockOracle, direction: u8, barrier: u64): bool {
    if (direction == DIR_ABOVE) {
        o.price >= barrier
    } else if (direction == DIR_BELOW) {
        o.price <= barrier
    } else {
        abort E_BAD_DIRECTION
    }
}
