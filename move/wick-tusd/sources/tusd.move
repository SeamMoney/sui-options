/// Wick Test USD — testnet-only stablecoin used by Wick's segment arcade
/// for stake/collateral so users don't need to spend their testnet SUI on
/// every ride. SUI is then only used for gas.
///
/// Decimals: 6 (matches USDC standard).
/// Mint authority: held by whoever publishes the module (the TreasuryCap
/// is transferred to ctx.sender at init time).
///
/// This is testnet-only "test money" — not pegged to anything, not redeemable
/// for anything, not real value. The frontend should label it clearly.
module wick_tusd::tusd {
    use sui::coin::{Self, TreasuryCap};
    use sui::url;
    use std::option;

    /// One-time witness — required by sui::coin::create_currency.
    /// Drops at end of init(), can never be reconstructed.
    public struct TUSD has drop {}

    /// Init runs once at package publish. Creates the currency, shares the
    /// metadata object (so wallets can render it), and hands the TreasuryCap
    /// to the publisher. Any holder of the TreasuryCap can call `mint`.
    fun init(witness: TUSD, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            witness,
            6, // decimals — matches USDC
            b"TUSD",
            b"Wick Test USD",
            b"Testnet-only stablecoin for the Wick segment arcade. Not real money.",
            option::some(url::new_unsafe_from_bytes(
                b"https://wick-markets.vercel.app/favicon.svg",
            )),
            ctx,
        );
        transfer::public_share_object(metadata);
        transfer::public_transfer(treasury, ctx.sender());
    }

    /// Mint TUSD to a recipient. Requires the TreasuryCap (held by the
    /// publisher / operator). On testnet we mint freely; the frontend
    /// FaucetButton can call this via /api/faucet-tusd to drip TUSD to
    /// session wallets on demand.
    public fun mint(
        treasury: &mut TreasuryCap<TUSD>,
        amount: u64,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        let coin = coin::mint(treasury, amount, ctx);
        transfer::public_transfer(coin, recipient);
    }

    /// Burn TUSD held in a coin object. Lets the operator clean up dust
    /// during testing without needing a wallet to receive a transfer.
    public fun burn(
        treasury: &mut TreasuryCap<TUSD>,
        coin: sui::coin::Coin<TUSD>,
    ) {
        coin::burn(treasury, coin);
    }
}
