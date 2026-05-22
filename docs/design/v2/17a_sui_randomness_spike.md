# 17a — Sui on-chain randomness spike (A0)

**Status:** A0 research spike — the gating spike for the provably-fair arcade (`17_provably_fair_arcade.md` §6.1, Phase A). DEFINITIVE: this decides whether `record_segment` can use raw `sui::random` or needs a keeper commit-reveal fallback.
**Date:** 2026-05-22
**Owner:** source of truth for the arcade's randomness layer. If `segment_market.move` / `record_segment` / the cranker drift from this, they are wrong.
**Verdict (one line):** **The raw `sui::random` mechanism is SAFE as designed — Sui structurally blocks the test-and-abort PTB — provided `record_segment` obeys three concrete rules (below). The keeper commit-reveal fallback is NOT required.**

---

## 0. The question

`17_provably_fair_arcade.md` §6.1 defines the arcade's per-segment randomness:

> `record_segment(market, k, &Random, &Clock)` is an `entry` function that draws `sui::random`, runs a deterministic walk, and STORES the segment key + price extremes into a shared `SegmentMarket` object — with no value-dependent branch in `record_segment` itself.

The named threat (the "test-and-abort" / "grinding" attack):

> A Programmable Transaction Block (PTB) with TWO commands — (1) `record_segment(k)`, then (2) a second MoveCall that reads the just-stored extremes from the shared `SegmentMarket` and ABORTS if the outcome is unfavorable to the attacker's open ride. A PTB abort rolls back all commands, so an unfavorable segment is never recorded; the attacker retries until a favorable segment sticks.

If that attack works, "commit-before-roll" is not provably fair. This spike answers it definitively against current (2025–2026) Sui.

**Bottom line up front:** the attack is real *as a threat class* — Sui's own docs describe exactly it — and Sui ships a *structural* defense for exactly it: a transaction-validity rule that **rejects any PTB which places a non-`TransferObjects`/non-`MergeCoins` command after a MoveCall that consumes `&Random`**. The malicious "read-and-abort" second command is precisely such a forbidden command, so the attacker's PTB is rejected at validity-check time and never executes. That defense, plus the constant-gas discipline already mandated by §6.1, closes the attack.

---

## 1. The `sui::random` API (current, 2025–2026)

Source: `crates/sui-framework/packages/sui-framework/sources/random.move` (MystenLabs/sui, `main`) and the framework reference docs.

### 1.1 The objects

```move
/// Singleton shared object which stores the global randomness state.
public struct Random has key {
    id: UID,
    inner: Versioned,
}

/// Unique randomness generator, derived from the global randomness.
public struct RandomGenerator has drop {
    seed: vector<u8>,
    counter: u16,
    buffer: vector<u8>,
}
```

- `Random` lives at the **reserved address `0x8`**. It is a shared object, but **immutable to user transactions** — "Although `Random` is a shared object, it is inaccessible for mutable operations. Any transaction attempting to modify it fails." Its `random_bytes` are written only by the validator-run `RandomnessStateUpdate` system transaction (caller must be a system address).
- `RandomGenerator` has **`drop` only** — no `store`, no `copy`, no `key`. It therefore **cannot be put in a struct field, cannot be returned as a stored object, and cannot persist past the transaction**. It is a transaction-local value.

### 1.2 Obtaining a generator

```move
/// Create a generator. Can be used to derive up to MAX_U16 * 32 random bytes.
public fun new_generator(r: &Random, ctx: &mut TxContext): RandomGenerator
```

`new_generator` derives the generator's seed via:

```
seed = hmac_sha3_256( inner.random_bytes , ctx.fresh_object_address().to_bytes() )
```

i.e. the per-transaction global randomness HMAC'd with a **fresh object address** unique to this call. Result: every `new_generator` invocation in every transaction yields an independent, unpredictable, unbiasable PRG seed. The generator then produces up to `MAX_U16 * 32` bytes (`counter` + `buffer`).

### 1.3 Generation functions (full surface)

```move
public fun generate_bytes(g: &mut RandomGenerator, num_of_bytes: u16): vector<u8>

public fun generate_u256(g: &mut RandomGenerator): u256
public fun generate_u128(g: &mut RandomGenerator): u128
public fun generate_u64 (g: &mut RandomGenerator): u64
public fun generate_u32 (g: &mut RandomGenerator): u32
public fun generate_u16 (g: &mut RandomGenerator): u16
public fun generate_u8  (g: &mut RandomGenerator): u8
public fun generate_bool(g: &mut RandomGenerator): bool

// Uniform in [min, max]; bias bounded by 2^-64.
public fun generate_u128_in_range(g: &mut RandomGenerator, min: u128, max: u128): u128
public fun generate_u64_in_range (g: &mut RandomGenerator, min: u64,  max: u64 ): u64
public fun generate_u32_in_range (g: &mut RandomGenerator, min: u32,  max: u32 ): u32
public fun generate_u16_in_range (g: &mut RandomGenerator, min: u16,  max: u16 ): u16
public fun generate_u8_in_range  (g: &mut RandomGenerator, min: u8,   max: u8  ): u8

public fun shuffle<T>(g: &mut RandomGenerator, v: &mut vector<T>)   // Fisher–Yates
```

**For the arcade:** `record_segment` should call `new_generator` once and draw a single wide value — `generate_u256` (or `generate_bytes(32)`) — as the raw `segment_key[k]`. That `u256` is then expanded by the entropy layer (`keystream(key, n) = blake2b256(key ‖ le(n))`, doc 17 §7) into the deterministic stream the walk consumes. **Do not** call `generate_*_in_range` or `generate_bool` inside `record_segment` for any branch the walk takes — see §1.4 and §4.

### 1.4 Move verifier rules for `&Random` / `RandomGenerator`

The Sui Move bytecode verifier enforces (confirmed by the framework docs and the on-chain-randomness guide):

1. **A function that takes `&Random` as a parameter MUST be `entry` and MUST NOT be `public`.** "The Move compiler enforces this behavior by rejecting public functions with `Random` as an argument." `private entry` or (at most) `public(package) entry` is permitted; `public entry` is **not**.

2. **The same rule applies to `RandomGenerator`** — "rejecting public functions with `RandomGenerator` as an argument." A `RandomGenerator` cannot be threaded through a public boundary.

3. **Consequence — composition is structurally blocked.** Because a `&Random`-consuming function cannot be `public`, **no other module can call it**, and because `RandomGenerator` has no `store`/`copy` and cannot cross a public boundary, **the generator cannot be passed out** to attacker code. A different package literally cannot wrap `record_segment` in its own function. The only remaining composition surface is the PTB — addressed in §2–§3.

4. **Can a `Random`-consuming function return its result?** Yes — a `private entry` function may return values (`entry` functions can return values with `drop`). The freshly-drawn `segment_key` *can* be returned as a command result. **This is exactly the surface §2/§3 examine**, and it is exactly what the PTB-command restriction shuts down.

> **For `record_segment`:** it MUST be `entry` and MUST NOT be `public`. The keeper (and the permissionless backup cranker) call it directly as the sole/first MoveCall of a PTB. It can be `public(package) entry` if `wick.move` needs to route to it from within the package, or plain `entry` — either satisfies the verifier. It must **not** be `public entry` and must **not** hand a `RandomGenerator` to any other function.

---

## 2. Does Sui structurally prevent the two-command test-and-abort PTB? — the crux

**Yes.** This is the load-bearing finding. It rests on two facts about PTB execution and one transaction-validity rule.

### 2.1 Intra-PTB mutation IS visible to later commands (the bad news, in isolation)

Sui PTB semantics, from the official PTB concept docs:

> "The individual transaction commands within a PTB execute in order. You can use the results from one transaction command in any subsequent transaction command within the PTB."

> "The effects of each transaction command in the block, such as object modifications or transfers, are applied atomically at the end of the transaction. If one transaction command fails, the entire block fails and no effects from the commands are applied."

Concretely:

- **Commands execute sequentially against an evolving execution context.** Command 2 does **not** see a pre-PTB snapshot — it sees the state as mutated by command 1. So if command 1 (`record_segment`) mutates the shared `SegmentMarket`, a hypothetical command 2 *would* observe the just-written `segment_key` / extremes.
- **An abort in any command rolls back the entire PTB atomically.** No effects persist. The attacker pays gas for the failed tx (important — see §4) but the shared object is untouched, so the unfavorable segment is **not** recorded and the attacker can retry segment `k` with fresh randomness.

So, *purely on PTB execution semantics*, the test-and-abort attack would work. **Sui knew this** — and added a dedicated transaction-validity rule for it.

### 2.2 The structural defense — the PTB-command restriction for `Random` consumers

Sui's on-chain randomness documentation states, verbatim in substance:

> **"Sui rejects PTBs that have commands that are not `TransferObjects` or `MergeCoins` following a `MoveCall` command that uses `Random` as an input."**

This is a **transaction-validity rule** — checked when the PTB is validated, *before* execution and *before* it consumes the randomness round. It means:

- A PTB may contain a MoveCall that consumes `&Random` (e.g. `record_segment`).
- **After** that MoveCall, the *only* commands the PTB is allowed to contain are `TransferObjects` and `MergeCoins`. Both are inert plumbing — they move/merge objects; **neither can read a shared object's fields, run arbitrary Move logic, evaluate a predicate, or abort conditionally on a value.**
- Any **other** command after the randomness MoveCall — crucially **another `MoveCall`** — makes the **entire PTB invalid**. It is **rejected**, not merely reverted.

### 2.3 Mapping the rule onto our exact threat

The threat (doc 17 §6.1) is a PTB of the form:

```
Command 0:  MoveCall  record_segment(market, k, &Random, &Clock)   // consumes &Random
Command 1:  MoveCall  attacker::read_extremes_and_abort(market)    // reads SegmentMarket, asserts favorable
```

Command 1 is a `MoveCall`. It follows a `MoveCall` that uses `Random` as an input. It is **not** `TransferObjects` and **not** `MergeCoins`. Therefore **this PTB is structurally invalid and is rejected by Sui.** It never executes; it never touches the randomness beacon; there is nothing to retry-with-fresh-randomness because the malicious shape cannot be submitted at all.

The attacker's "read the stored extremes and `assert!` favorability" step **is, by definition, a `MoveCall` that does conditional logic** — exactly the command class the rule forbids after a `Random` MoveCall. There is no way to express "abort if unfavorable" using only `TransferObjects` / `MergeCoins`:

- `TransferObjects` takes objects + a recipient; it cannot read `SegmentMarket.extremes`, cannot compare, cannot abort on a value. (It can fail only on ownership/type errors, which are value-independent.)
- `MergeCoins` takes coins of one type; likewise no field read of an arbitrary shared object, no predicate, no value-dependent abort.

The same rule also kills every variant of the attack:

- **Variant: read the *returned* `segment_key` instead of the shared object.** §1.4 notes a `private entry` function *can* return its draw, and a Result can flow to a later command. But the later command that would consume `Result(0)` and abort on it is, again, a `MoveCall` — forbidden after the `Random` MoveCall. (Worse for the attacker: `record_segment` should return *nothing* sensitive anyway — see §4.3.)
- **Variant: put the predicate inside a `public` wrapper and call the wrapper.** Blocked one layer earlier by the verifier (§1.4) — a `&Random`-consuming function cannot be `public`, so `record_segment` is uncallable from attacker code; the attacker can only place `record_segment` *itself* as the MoveCall, which then makes any following predicate-MoveCall illegal.
- **Variant: a non-`MoveCall` "abort" command.** There is no PTB command type that performs a value-dependent abort other than a `MoveCall`. `TransferObjects`/`MergeCoins` aborts are value-independent. `SplitCoins`/`Publish`/`Upgrade`/`MakeMoveVec` are all disallowed after the `Random` MoveCall regardless.

**Conclusion of §2: Sui structurally prevents the exact two-command test-and-abort PTB in doc 17 §6.1.** The malicious PTB cannot be formed; it is rejected at validity-check time. The grinding loop has no on-chain foothold.

### 2.4 Why Sui's design makes this airtight

The rule is deliberately conservative: it does not try to *analyze* whether the following commands are "safe" — it whitelists two provably-inert command types and rejects everything else. `TransferObjects` and `MergeCoins` are on the whitelist precisely because their success/failure is **value-independent** (they fail only on structural/ownership errors, never on "the random number was unfavorable"). Therefore no post-randomness command in a *valid* PTB can ever abort *as a function of the drawn value*. The grinding attack fundamentally requires a value-dependent abort after the draw; the rule makes that unrepresentable.

This is *stronger* than the keeper commit-reveal fallback in one respect: it removes the attack at the transaction-format layer, with zero trust in any off-chain party.

---

## 3. Sui's official guidance on the test-and-abort ("grinding") attack

Sui's on-chain randomness documentation (`docs.sui.io/guides/developer/advanced/randomness-onchain`, mirrored at `docs.sui.io/sui-stack/on-chain-primitives/randomness-onchain`) explicitly treats this attack class. Summary of what it says and recommends:

### 3.1 The attack as Sui describes it

Sui's docs give a dice-game example. An attacker writes a wrapper:

```move
public fun attack(guess: u8, r: &Random, ctx: &mut TxContext): Ticket {
  let t = dice::play_dice(guess, r, ctx);
  assert!(!dice::is_winner(&t), 0);   // abort unless the outcome is what the attacker wants
  t
}
```

> The attack takes advantage of the atomic nature of PTBs and always reverts the entire transaction if the guess was incorrect **without paying the fee**. Sending multiple transactions can repeat the attack, each one executed with different randomness and reverted if the guess is incorrect.

That is *our* threat, verbatim in shape.

### 3.2 Sui's three layered mitigations

**(a) Verifier rule — `&Random` functions must be non-`public` `entry`.** Kills the `public fun attack(... &Random ...)` wrapper above: a `&Random`-consuming function cannot be `public`, so other modules cannot compose it. (Our §1.4.)

**(b) PTB-command restriction — only `TransferObjects`/`MergeCoins` may follow a `Random` MoveCall.** Kills the PTB-level version where the attacker chains `play_dice(...)` then a predicate MoveCall. (Our §2.2 — the load-bearing defense for the arcade.)

**(c) Constant-gas / "limited resources" discipline — the developer's own responsibility.** Sui is explicit that the API does **not** automatically defend against gas-budget manipulation:

> "Be aware that some resources that are available to transactions are limited. If you are not careful, an attacker can break or exploit your application by deliberately controlling the point where your function runs out of resources. Concretely, gas is such a resource. **The Random API does not automatically prevent this kind of attack.**"

And the `random.move` source itself, above `new_generator`:

> "Using randomness can be error-prone if you don't observe the subtleties in its correct use, for example, randomness dependent code might be exploitable to attacks that **carefully set the gas budget in a way that breaks security.**"

The undergasing attack: if a function's gas consumption *depends on the drawn value* (e.g. an unfavorable value takes a longer/more-expensive code path), an attacker can set a gas budget that **succeeds on a favorable draw but runs Out-Of-Gas (and thus aborts) on an unfavorable draw** — recreating test-and-abort *inside a single allowed command*, without needing a forbidden second command. Sui's prescribed fix: **make the randomness-consuming code path take the same amount of gas regardless of the drawn value.**

### 3.3 Sui's official safe-coding patterns

From the docs and the official example `examples/move/random/random_nft/sources/example.move`:

- **Use constant-gas arithmetic, not value-dependent branches.** The official "safe" NFT `reveal()` uses an `arithmetic_is_less_than` helper "to determine the metal of the NFT in a way that consumes the same amount of gas regardless of the value of the random number." The doc explicitly flags the *unsafe* `reveal_alternative1()` — which branches with different gas cost per outcome — as vulnerable.
- **Two-transaction split (commit → reveal), when a value-dependent flow is unavoidable.** Tx1 draws randomness and stores it in an object whose result is not yet actionable; Tx2 reads and processes it. "It is important that the inputs to the second function are fixed and cannot be modified after tx1, otherwise an attacker can modify them after seeing the randomness committed by tx1."
- **Charge a non-refundable fee in the commit step.** "Gracefully handle the case in which the second step is never completed. For example, you could accomplish this by charging a fee in the first step." This makes grinding *costly even if* some abort surface remains.
- **Heavy work on the main path, fast early-exits.** "Write the function such that the main processing path does the heavy work, while early-exit paths return quickly" — so an attacker cannot use a cheap early-exit to selectively OOG.

### 3.4 How the arcade satisfies Sui's guidance

| Sui mitigation | Arcade compliance |
|---|---|
| `&Random` fn is non-`public` `entry` | `record_segment` is `entry`, never `public` (§1.4). |
| Only `TransferObjects`/`MergeCoins` after a `Random` MoveCall | Inherited from the protocol — no opt-in needed. Defeats the §6.1 two-command PTB (§2.3). |
| Constant-gas, no value-dependent branch | **This is the one real obligation.** `record_segment` must run `expand_segment` (6 candles, fixed-point) with control flow and gas cost **independent of `segment_key`** — see §4. Doc 17 §6.1 already mandates "no value-dependent branch"; this spike confirms it is load-bearing, not stylistic. |
| Two-tx split / non-refundable fee | **Not required** for the arcade — see §6. The commit-before-roll *is already* "decision, then roll"; `record_segment` is itself the atomic roll. The fee mitigation is a fallback for designs that can't get constant-gas; the arcade can. |

Sources: `https://docs.sui.io/guides/developer/advanced/randomness-onchain` · `https://docs.sui.io/sui-stack/on-chain-primitives/randomness-onchain` · `https://docs.sui.io/references/framework/sui_sui/random` · `https://github.com/MystenLabs/sui/blob/main/crates/sui-framework/packages/sui-framework/sources/random.move` · `https://github.com/MystenLabs/sui/blob/main/examples/move/random/random_nft/sources/example.move` · `https://blog.sui.io/secure-native-randomness-testnet/`

---

## 4. The one real obligation — `record_segment` must be constant-gas

The PTB-command rule (§2) kills the *two-command* attack. The *remaining* attack surface Sui warns about (§3.2) is the **undergasing / single-command** variant: even a lone, allowed `record_segment` MoveCall becomes grindable if its **gas cost depends on the drawn `segment_key`**, because the attacker can pick a gas budget that lets a favorable draw finish and forces an unfavorable draw to abort with Out-Of-Gas. A PTB abort is a PTB abort whether it comes from `assert!` or from OOG.

So `record_segment` must be written so an observer cannot tell the drawn value from the gas consumed. Concretely:

### 4.1 No value-dependent control flow in the recording path

- `expand_segment` (the 6-candle walk + the pattern FSM + shapers, doc 17 §15) must execute with **branch structure and loop counts independent of `segment_key`**. A `FORMING` pattern branch, a fat-tail branch, a volatility-regime switch — each must be implemented as **constant-gas arithmetic selection** (compute both, select with arithmetic), the way the official `reveal()` uses `arithmetic_is_less_than`, **not** as an `if` whose taken side costs materially different gas.
- It is fine for the *output* (candle values, extremes) to depend on the key — that is the whole point. What must not depend on the key is **how much gas the function burns** and **whether it reaches the store.**
- The store of `segment_key[k]` / `walk_state` / `(min,max)` into the `Table` happens **unconditionally at the end**, after a fixed amount of work, on every input.

### 4.2 No early-exit that leaks the value

The only asserts in `record_segment` must be **value-independent**: `k == next_unrecorded_segment` (monotonic sequencing) and shape checks. There must be **no** `assert!` or `abort` whose condition reads `segment_key` or any walk output. (Doc 17 §6.1's "no value-dependent branch" — confirmed mandatory.)

### 4.3 `record_segment` returns nothing actionable

`record_segment` should return `()`. It must not return the `segment_key`, the extremes, or any object carrying them as a command Result. Rationale: defense-in-depth. Even though the PTB rule forbids a *predicate MoveCall* after it, returning the value (a) serves no purpose — the keeper reads it back from the shared object on the next pipeline poll anyway — and (b) removes any Result-flow surface entirely. Keep the draw write-only into the shared `SegmentMarket`.

### 4.4 Bound and fix the walk's work

`expand_segment` is "6 candles of integer fixed-point math — cheap" (doc 17 §6.2). Ensure it is also **fixed**: fixed candle count per segment, fixed keystream-draw count, no key-dependent loop bound, no key-dependent vector growth. A `shuffle` or a `generate_*_in_range` rejection-sampling loop would introduce key-dependent gas — so, per §1.3, **do not** use those inside `record_segment`; draw one `generate_u256` and expand deterministically with `blake2b256`. `blake2b256` over fixed-length input is constant-gas.

If §4.1–§4.4 hold, an attacker setting any gas budget gets the *same* success/abort outcome for *every* possible draw — there is no budget that selectively aborts unfavorable segments. The single-command undergasing variant is closed, and §2 already closed the two-command variant. **Together these fully close the test-and-abort attack for the arcade.**

> Note: this constant-gas property is also directly testable. The adversarial suite (doc 17 §8, E3 "the test-and-abort grinder") should include a test that measures `record_segment` gas across many `segment_key` values and asserts the spread is within noise. That test *is* the proof obligation for this spike's conclusion.

---

## 5. The five questions — definitive answers

### Q1 — The `sui::random` API and the verifier rules

See §1. Summary:
- A module gets randomness by taking `r: &Random` and calling `new_generator(r, ctx): RandomGenerator` (seed = `hmac_sha3_256(global_random_bytes, fresh_object_address)`).
- Draw with `generate_u256 / u128 / u64 / u32 / u16 / u8`, `generate_bool`, `generate_bytes(n)`, the `generate_*_in_range` family (≤ 2⁻⁶⁴ bias), or `shuffle<T>`.
- **`RandomGenerator` has `drop` only** — no `store`/`copy`/`key`; it is transaction-local and cannot be persisted or returned as an object.
- **Verifier rule:** a function taking `&Random` (or `RandomGenerator`) as a parameter **must be `entry` and must NOT be `public`.** `public entry` is rejected. `public(package) entry` and plain `private entry` are allowed. So **a `Random`-consuming function cannot be `public`.** It **can** return values (it is still an `entry` fn) — but other modules cannot call it, so it cannot be composed by attacker Move code.

### Q2 — Does Sui structurally prevent the two-command test-and-abort PTB?

**Yes — definitively.** Within one PTB, commands execute sequentially and a later command *would* see an earlier command's shared-object mutation, and any abort rolls back the whole PTB — so on raw execution semantics the attack would work. **But** Sui enforces a transaction-validity rule: **a PTB is rejected if any command other than `TransferObjects` or `MergeCoins` follows a `MoveCall` that consumes `&Random`.** The attacker's "read the stored extremes / read the returned key and `assert!` favorability" step is necessarily a `MoveCall` doing conditional logic — a forbidden command. The malicious PTB is therefore **rejected at validity-check time and never executes.** `TransferObjects`/`MergeCoins` are whitelisted precisely because their outcome is value-independent — no allowed post-randomness command can abort as a function of the drawn value. The two-command grinding attack cannot be expressed. (§2.)

### Q3 — Sui's official stance on the grinding / test-and-abort attack

Sui's on-chain randomness docs explicitly describe this attack class (a `public fun attack(...)` wrapper / a chained PTB that "always reverts the entire transaction if the guess was incorrect without paying the fee... repeat the attack"). Sui's mitigations, layered: **(a)** the verifier forces `&Random` functions to be non-`public` `entry`; **(b)** the PTB-command restriction (only `TransferObjects`/`MergeCoins` after a `Random` MoveCall); **(c)** the developer must make randomness-consuming code **constant-gas** — Sui states plainly "the Random API does not automatically prevent" gas-budget (undergasing) attacks, and `random.move`'s own doc-comment warns code "might be exploitable to attacks that carefully set the gas budget in a way that breaks security." Recommended patterns: constant-gas arithmetic selection (the official `reveal()` / `arithmetic_is_less_than` example), a commit→reveal two-transaction split with **fixed** tx2 inputs when value-dependent flow is unavoidable, a **non-refundable fee in the commit step**, and heavy-work-on-main-path / fast-early-exit structuring. (§3.)

### Q4 — Do `dryRunTransactionBlock` / `devInspectTransactionBlock` produce real randomness?

**No usable fresh randomness — dry-run is not a free grinding oracle.** Reasoning:

- The `Random` object at `0x8` only ever has its `random_bytes` populated by the validator-run `RandomnessStateUpdate` **system transaction**, which is generated per consensus round by the threshold-BLS beacon and is **not part of, and not predictable before, the user transaction.** Randomness is produced "quickly after a transaction has been ordered but before execution" — it is bound to the transaction's *consensus round*, which does not exist for an un-submitted dry-run.
- `dryRun` / `devInspect` execute against a node's *current* view of state. A dry-run of a `record_segment` PTB therefore runs `new_generator` against whatever `random_bytes` is *currently stored at `0x8`* — i.e. an **already-revealed, public, past** randomness value, the same for every dry-run until the next round-update lands. It is **not** a private fresh draw of the value the real transaction will later receive.
- Therefore a dry-run cannot tell the attacker the *future* `segment_key` their real `record_segment` will draw. Dry-running the malicious two-command PTB is moot anyway — it is **structurally invalid (§2)** and a dry-run of it surfaces the validity rejection, not a result.
- Even granting the worst case (some node returns a "live-looking" value in simulation): it would be the *current public* beacon value, identical across all callers, conferring no grinding advantage over simply reading `0x8` on-chain. The real transaction gets a *different*, round-bound value.

So dry-run/devInspect give the attacker **no ability to preview the actual segment_key** and **no free grinding loop.** (Caveat: the precise node-level behavior of `new_generator` under `devInspect` is not crisply documented; the spike does not *depend* on it, because §2's structural rejection of the malicious PTB and §4's constant-gas property hold regardless of what a simulator returns. Recommended: a Phase-A empirical check — dry-run a benign `record_segment` twice and confirm the stored key is not a fresh per-call draw — but it is non-blocking.)

### Q5 — Does an aborted/failed transaction leak the drawn randomness?

**No meaningful leak that enables grinding.**

- A PTB abort rolls back **all effects atomically** — "no effects from the commands are applied." The shared `SegmentMarket` is **not** mutated, so a failed `record_segment` writes no `segment_key`, no extremes: nothing persists to read.
- **Events** in Sui are an *effect*; they are committed only for a **successful** transaction. An aborted transaction emits **no events.** So an attacker cannot exfiltrate the draw via an event from a failed tx.
- A failed transaction's effects record carries an **abort code / error status and gas used** — not Move local values. The drawn `segment_key` is a transaction-local value inside `record_segment`; it is never serialized into the failed-transaction record. (`record_segment` returning `()` per §4.3 means there is not even a command Result to inspect.)
- The one channel that *does* survive an abort is **gas consumed** — which is exactly why §4's constant-gas requirement exists. If `record_segment` is constant-gas, the gas figure of a failed tx reveals nothing about the draw. If it is not, gas *is* the leak. **Constant-gas (§4) is therefore both the anti-undergasing defense and the anti-leak defense — the same single property.**

Net: an aborted `record_segment` leaks no `segment_key` via state, events, or Results; the only residual side-channel is gas, neutralized by the §4 constant-gas discipline.

---

## 6. Conclusion & recommended mechanism

### 6.1 Verdict

**The "commit-before-roll with raw `sui::random`" mechanism is SAFE as designed. The keeper commit-reveal fallback (`segment_key = H(nonce ‖ sui_random)`) is NOT required and should NOT be built.**

Why the raw mechanism holds:

1. **The two-command test-and-abort PTB of doc 17 §6.1 cannot be formed.** Sui's transaction-validity rule rejects any PTB with a non-`TransferObjects`/non-`MergeCoins` command after a `Random` MoveCall. The attacker's read-and-abort `MoveCall` is exactly such a forbidden command. The malicious PTB is rejected before execution and never consumes a randomness round. (§2)
2. **The Move verifier already blocks Move-level composition** — `record_segment` is non-`public` `entry`, so no attacker module can wrap it. (§1.4)
3. **Dry-run/devInspect give no free grinding oracle and no preview of the future draw.** (§5 Q4)
4. **An aborted `record_segment` leaks the `segment_key` through no state, event, or Result channel.** (§5 Q5)
5. **The single residual surface — undergasing (gas-cost-dependent-on-value, recreating abort inside one allowed command) — is closed by making `record_segment` constant-gas**, which doc 17 §6.1 already requires ("no value-dependent branch") and which §4 here specifies precisely.

The fallback was a contingency for "A0 fails." A0 does not fail. Building keeper commit-reveal would *add* a trusted-ish off-chain party (the keeper's `nonce` commitment, liveness, and a reveal step) to a mechanism that is *already* trustless via Sui's structural rule — a strict regression in the threat model for zero security gain. Drop it.

### 6.2 Required implementation rules for `record_segment` (binding — Phase B2)

The raw mechanism is safe **iff** `record_segment` obeys all of:

- **R1 — `entry`, never `public`.** Declare `record_segment` as `entry` (or `public(package) entry` if `wick.move` must route to it). Never `public entry`. Never pass a `RandomGenerator` to another function. (§1.4)
- **R2 — constant-gas, no value-dependent control flow.** `expand_segment` and the whole recording path must have branch structure, loop counts, and gas cost **independent of `segment_key`**. Implement pattern-FSM / fat-tail / vol-regime selection as constant-gas arithmetic selection (compute-both-then-arithmetic-select), per Sui's official `arithmetic_is_less_than` pattern — never as an `if` with materially different per-branch gas. The store into the shared `SegmentMarket` happens unconditionally at the end. (§4.1, §4.4)
- **R3 — no value-dependent abort / early-exit.** The only asserts may be value-independent (`k` is the next unrecorded segment; shape checks). No `assert!`/`abort` may read `segment_key` or any walk output. (§4.2)
- **R4 — return nothing actionable.** `record_segment` returns `()`. It must not return the key or extremes as a command Result; the keeper reads them back from the shared object on its next poll. (§4.3)
- **R5 — single wide draw, deterministic expansion.** Inside `record_segment`, call `new_generator` once and draw one `generate_u256` (or `generate_bytes(32)`) as the raw `segment_key`. Do **not** use `generate_*_in_range` or `shuffle` inside `record_segment` (their rejection-sampling/permutation loops are key-dependent gas). Expand the key with `keystream(key,n) = blake2b256(key ‖ le(n))` — constant-gas over fixed-length input. (§1.3, §4.4)

No extra non-refundable fee, no gas-cost barrier, and no single-command-PTB restriction needs to be *added*: the single-command-after-`Random` constraint is **already enforced by the protocol** for every `Random`-consuming MoveCall, and R2 closes the only thing that constraint does not (undergasing). The keeper still submits `record_segment` as the sole/first MoveCall of its pipelined PTB (doc 17 §6.3); the permissionless backup cranker does the same. Both are fine — a lone `record_segment` MoveCall, optionally followed only by `TransferObjects`/`MergeCoins`, is a valid PTB.

### 6.3 Test obligation (the proof of this spike — doc 17 §8, Phase E3)

The adversarial suite must include, as the concrete discharge of this spike:

1. **Constant-gas test:** measure `record_segment` gas across a large sample of `segment_key` values (and across `walk_state` checkpoints, incl. ones that trigger `FORMING` patterns / fat-tail candles). Assert the gas spread is within VM noise — i.e. an attacker cannot pick a gas budget that selectively aborts unfavorable segments. **This test failing = R2 violated = the spike's safety conclusion void.**
2. **PTB-rejection test:** attempt to submit (or build) a PTB of the form `[record_segment, attacker_predicate_movecall]` and assert it is **rejected** (validity error), not merely reverted — confirming the §2 structural defense on the live network.
3. **Abort-leak test:** force a `record_segment` PTB to abort and assert no `SegmentMarket` mutation, no events, and no exposed key in the transaction effects.

### 6.4 Net effect on doc 17

`17_provably_fair_arcade.md` §6.1 can be updated: A0 is **resolved — raw `sui::random` is safe**; the "fallback if A0 fails: keeper commit-reveal" line can be struck. The §4 threat-model row "Grinding the per-segment draw (test-and-abort) — resolved, but gated by a Sui-randomness spike (A0)" becomes simply **resolved**, with this document (`17a`) as the citation. The single carried-forward requirement into Phase B2 is R1–R5 above — chiefly **R2, constant-gas `record_segment`** — and into Phase E3 the three tests in §6.3.

---

## 7. Sources

- Sui — On-Chain Randomness (developer guide): https://docs.sui.io/guides/developer/advanced/randomness-onchain
- Sui — Onchain Randomness (sui-stack primitives mirror): https://docs.sui.io/sui-stack/on-chain-primitives/randomness-onchain
- Sui framework reference — `sui::random`: https://docs.sui.io/references/framework/sui_sui/random
- Sui framework source — `random.move`: https://github.com/MystenLabs/sui/blob/main/crates/sui-framework/packages/sui-framework/sources/random.move
- Sui official example — safe randomness NFT (`reveal` / two-step / unsafe alt): https://github.com/MystenLabs/sui/blob/main/examples/move/random/random_nft/sources/example.move
- Sui — Programmable Transaction Blocks (execution model, sequential commands, atomic rollback): https://docs.sui.io/concepts/transactions/prog-txn-blocks
- Sui blog — "Unlocking the Power of Native Randomness on Sui" (DKG / threshold beacon, ordered-before-executed): https://blog.sui.io/secure-native-randomness-testnet/
- MystenLabs/sui-native-randomness — reference examples (dice, raffle): https://github.com/MystenLabs/sui-native-randomness

*Spike A0 complete. 2026-05-22.*
