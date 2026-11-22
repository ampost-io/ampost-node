import { Ampost, type ClientOptions } from "../src/index.js";

export interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

type Reply = Response | Error | ((call: Call) => Response | Error | Promise<Response | Error>);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function apiError(status: number, code: string, message = "Something", details?: Record<string, unknown>, headers?: Record<string, string>) {
  return json(status, { error: { code, message, ...(details && { details }) } }, headers);
}

/** A client whose fetch answers with `replies` in order and records every call. */
export function mockClient(replies: Reply[], options: ClientOptions = {}) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = init.body;
    const call: Call = {
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof body === "string" ? JSON.parse(body) : body,
    };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request ${call.method} ${call.url}`);
    const reply = typeof next === "function" ? await next(call) : next;
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  const client = new Ampost({ apiKey: "amp_test_key", fetch: fetchImpl, ...options });
  return { client, calls, remaining: () => queue.length };
}

export const page = <T>(data: T[], offset: number, total: number, limit = data.length) => ({
  data,
  pagination: { limit, offset, total, hasMore: offset + data.length < total },
});
