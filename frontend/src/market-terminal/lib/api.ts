import { isTauriRuntime } from "./platform";

interface SimpleResponse {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: () => Promise<any>;
}

// Uses Tauri's native HTTP client in production to bypass CORS restrictions
// (Tauri webview origin is tauri://localhost which is blocked by external servers).
// Falls back to native fetch() in dev/browser.
export async function apiFetch(url: string, options?: RequestInit): Promise<SimpleResponse> {
  if (!isTauriRuntime()) {
    const res = await fetch(url, options);
    return { ok: res.ok, status: res.status, json: () => res.json() };
  }

  const { fetch: tauriFetch, Body, ResponseType } = await import("@tauri-apps/api/http");

  let body = undefined;
  if (options?.body) {
    const raw = typeof options.body === "string" ? options.body : String(options.body);
    body = Body.text(raw);
  }

  const response = await tauriFetch(url, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: (options?.method ?? "GET") as any,
    headers: options?.headers as Record<string, string>,
    body,
    responseType: ResponseType.Text,
  });

  const text = response.data as string;
  return {
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(text ? JSON.parse(text) : null),
  };
}
