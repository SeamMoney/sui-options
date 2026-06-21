/**
 * Round clock + fairness commitment for Pro Mode.
 *
 * Phases: lobby → live → settle → results. The Desk UI is shown in `lobby`
 * (deliberate option opens); the Live management UI is shown in `live`
 * (Sell-to-close on owned positions). See docs/design/v2/28 §5.
 */
export function roundPhase(cfg, nowMs) {
    const t = nowMs - cfg.startedAtMs;
    if (t < cfg.lobbyMs)
        return "lobby";
    if (t < cfg.lobbyMs + cfg.liveMs)
        return "live";
    if (t < cfg.lobbyMs + cfg.liveMs + cfg.settleMs)
        return "settle";
    return "results";
}
/** Wall-clock ms at which the live reveal starts. */
export function liveStartMs(cfg) {
    return cfg.startedAtMs + cfg.lobbyMs;
}
/** Milliseconds remaining in the current phase (0 once past `results`). */
export function phaseRemainingMs(cfg, nowMs) {
    const t = nowMs - cfg.startedAtMs;
    const lobbyEnd = cfg.lobbyMs;
    const liveEnd = lobbyEnd + cfg.liveMs;
    const settleEnd = liveEnd + cfg.settleMs;
    if (t < lobbyEnd)
        return lobbyEnd - t;
    if (t < liveEnd)
        return liveEnd - t;
    if (t < settleEnd)
        return settleEnd - t;
    return 0;
}
/**
 * Reveal progress during the live phase: how many of `totalSteps` price steps
 * should be visible at `nowMs`. 0 in the lobby, `totalSteps` once live ends.
 */
export function revealedSteps(cfg, nowMs, totalSteps) {
    const intoLive = nowMs - liveStartMs(cfg);
    if (intoLive <= 0)
        return 0;
    if (intoLive >= cfg.liveMs)
        return totalSteps;
    return Math.floor((intoLive / cfg.liveMs) * totalSteps);
}
/**
 * Fairness commitment over the seed + params: the full SHA-256 of
 * `${seed}:${paramsJson}`, as 64 lowercase hex chars. The engine publishes this
 * before the lobby and reveals the seed at settle, so anyone can recompute the
 * digest and confirm the streamed path was fixed in advance — a real
 * commit-reveal, not a toy hash.
 *
 * Implemented as a dependency-free, synchronous SHA-256 so the same code runs
 * in the browser and in Node without Web Crypto's async `subtle.digest`. The
 * digest matches `crypto.createHash("sha256").update(input).digest("hex")`.
 */
export function commit(seed, paramsJson) {
    return sha256Hex(`${seed}:${paramsJson}`);
}
// ── SHA-256 (FIPS 180-4), synchronous and dependency-free ───────────────────
// Operates on the UTF-8 bytes of the input string. Kept self-contained so the
// pro-options package has zero runtime deps and works identically in every
// JS runtime (browser, Node, Bun, Deno).
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function utf8Bytes(str) {
    // Encode without relying on TextEncoder presence (older runtimes/tests).
    if (typeof TextEncoder !== "undefined")
        return new TextEncoder().encode(str);
    const out = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80)
            out.push(c);
        else if (c < 0x800)
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c >= 0xd800 && c <= 0xdbff) {
            const c2 = str.charCodeAt(++i);
            c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
            out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        else
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
}
function sha256Hex(message) {
    const msg = utf8Bytes(message);
    const bitLen = msg.length * 8;
    // Pad: 0x80, then zeros, then 64-bit big-endian length, to a 64-byte multiple.
    const withLen = (((msg.length + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(withLen);
    buf.set(msg);
    buf[msg.length] = 0x80;
    // 64-bit length — high 32 bits are 0 for any practical input.
    const dv = new DataView(buf.buffer);
    dv.setUint32(withLen - 4, bitLen >>> 0, false);
    dv.setUint32(withLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < withLen; off += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0;
        h[1] = (h[1] + b) | 0;
        h[2] = (h[2] + c) | 0;
        h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0;
        h[5] = (h[5] + f) | 0;
        h[6] = (h[6] + g) | 0;
        h[7] = (h[7] + hh) | 0;
    }
    let hex = "";
    for (let i = 0; i < 8; i++)
        hex += (h[i] >>> 0).toString(16).padStart(8, "0");
    return hex;
}
//# sourceMappingURL=round.js.map