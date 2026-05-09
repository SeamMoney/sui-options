/** Quick CLI smoke that hits every endpoint of a running server. */
export {};
const BASE = process.env.WICK_API_BASE ?? "http://127.0.0.1:8787";

async function hit(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json();
  console.log(`GET ${path}  →  ${res.status}`);
  console.log(JSON.stringify(body, null, 2).split("\n").slice(0, 12).join("\n"));
  console.log("---");
}

await hit("/health");
await hit("/deployment");
await hit("/markets");
await hit("/oracles");
await hit("/positions/0xfad710377f820b10097f7ac445bc56e738db2bce712f898072061e0591049455");
