// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// Pins the exact DeepBook Predict package address + Predict object ID that
/// Wick's BTC route trusts. Fail-closed if Predict upgrades while Wick has
/// open positions on the previous version.
///
/// Per docs/design/v2/06_predict_btc_route_v2.md §6 + reconciliation §11.
///
/// Without this lock, a malicious or careless Predict upgrade could:
///   - Change settlement semantics under Wick's open positions
///   - Change the return type of `predict::redeem_permissionless`
///   - Brick our reconciliation logic
///
/// Migration path: admin calls `migrate(...)` after manually verifying the
/// new Predict version is compatible. There is no "auto-upgrade" path.
module wick::oracle_version_lock;

const ENotMigrating: u64 = 0;
const EVersionMismatch: u64 = 1;
const EAlreadyInitialized: u64 = 2;

/// Singleton shared object. One per Wick deployment.
public struct OracleVersionLock has key {
    id: UID,
    /// Pinned Predict package address (immutable per upgrade).
    predict_pkg: address,
    /// Pinned Predict<DUSDC> shared object id.
    predict_object_id: ID,
    /// Manual escape hatch — set true by admin only when migrating.
    migrating: bool,
    migrate_to_pkg: Option<address>,
    migrate_to_object_id: Option<ID>,
}

/// Capability — only the holder can call migrate().
public struct LockAdminCap has key, store {
    id: UID,
}

public struct LockInitialized has copy, drop {
    lock_id: ID,
    predict_pkg: address,
    predict_object_id: ID,
}

public struct MigrationStarted has copy, drop {
    lock_id: ID,
    from_pkg: address,
    to_pkg: address,
}

public struct MigrationCompleted has copy, drop {
    lock_id: ID,
    new_pkg: address,
    new_object_id: ID,
}

/// Create + share the singleton. Called once at protocol deploy.
public fun init_lock(
    predict_pkg: address,
    predict_object_id: ID,
    ctx: &mut TxContext,
): LockAdminCap {
    let lock = OracleVersionLock {
        id: object::new(ctx),
        predict_pkg,
        predict_object_id,
        migrating: false,
        migrate_to_pkg: option::none(),
        migrate_to_object_id: option::none(),
    };
    sui::event::emit(LockInitialized {
        lock_id: object::id(&lock),
        predict_pkg,
        predict_object_id,
    });
    transfer::share_object(lock);
    LockAdminCap { id: object::new(ctx) }
}

/// Assert: the caller's expected Predict identity matches the pinned values.
/// Used by every wick::predict_route entrypoint as the FIRST line.
public fun assert_pinned(
    lock: &OracleVersionLock,
    expected_pkg: address,
    expected_object_id: ID,
) {
    assert!(lock.predict_pkg == expected_pkg, EVersionMismatch);
    assert!(lock.predict_object_id == expected_object_id, EVersionMismatch);
}

public fun predict_pkg(lock: &OracleVersionLock): address { lock.predict_pkg }
public fun predict_object_id(lock: &OracleVersionLock): ID { lock.predict_object_id }
public fun is_migrating(lock: &OracleVersionLock): bool { lock.migrating }

/// Admin enters migration mode. Existing positions on the OLD predict
/// version remain settle-able via the assert (they pass the pinned check).
/// New positions opened during migration revert.
public fun start_migration(
    _cap: &LockAdminCap,
    lock: &mut OracleVersionLock,
    new_pkg: address,
    new_object_id: ID,
) {
    lock.migrating = true;
    lock.migrate_to_pkg = option::some(new_pkg);
    lock.migrate_to_object_id = option::some(new_object_id);
    sui::event::emit(MigrationStarted {
        lock_id: object::id(lock),
        from_pkg: lock.predict_pkg,
        to_pkg: new_pkg,
    });
}

/// Admin completes migration AFTER all open positions on the old version
/// have settled. Consumes the migration-target fields; pinned values flip.
public fun complete_migration(
    _cap: &LockAdminCap,
    lock: &mut OracleVersionLock,
) {
    assert!(lock.migrating, ENotMigrating);
    let new_pkg = option::extract(&mut lock.migrate_to_pkg);
    let new_object_id = option::extract(&mut lock.migrate_to_object_id);
    lock.predict_pkg = new_pkg;
    lock.predict_object_id = new_object_id;
    lock.migrating = false;
    sui::event::emit(MigrationCompleted {
        lock_id: object::id(lock),
        new_pkg,
        new_object_id,
    });
}

#[test_only]
public fun init_for_testing(
    predict_pkg: address,
    predict_object_id: ID,
    ctx: &mut TxContext,
): (OracleVersionLock, LockAdminCap) {
    let lock = OracleVersionLock {
        id: object::new(ctx),
        predict_pkg,
        predict_object_id,
        migrating: false,
        migrate_to_pkg: option::none(),
        migrate_to_object_id: option::none(),
    };
    let cap = LockAdminCap { id: object::new(ctx) };
    (lock, cap)
}
