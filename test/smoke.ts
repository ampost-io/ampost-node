// Smoke test against the real API. Runs only with AMPOST_API_KEY set (a Read only key is enough);
// it reads and validates, and never creates, publishes or deletes anything.
//   AMPOST_API_KEY=amp_... npm run test:smoke
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Ampost, AuthenticationError } from "../src/index.js";

const apiKey = process.env.AMPOST_API_KEY;

describe("smoke: real API", { skip: apiKey ? false : "AMPOST_API_KEY is not set" }, () => {
  const client = () => new Ampost({ apiKey });

  it("lists platforms with their rules", async () => {
    const platforms = await client().platforms.list().toArray();
    assert.ok(platforms.length > 0);
    assert.ok(platforms.some((p) => p.platform === "bluesky"));
  });

  it("reads one page of posts and of accounts", async () => {
    const posts = await client().posts.list({ limit: 1 });
    assert.ok(Array.isArray(posts.data));
    assert.equal(typeof posts.pagination.total, "number");
    const accounts = await client().accounts.list({ limit: 5 });
    assert.ok(Array.isArray(accounts.data));
  });

  it("validates a post without creating it", async () => {
    const accounts = await client().accounts.list({ limit: 2 });
    const platforms = accounts.data.length ? [...new Set(accounts.data.map((a) => a.platform))] : ["bluesky" as const];
    const result = await client().posts.validate({ text: "Smoke test from ampost-node", targets: [{ platforms }] });
    assert.equal(typeof result.valid, "boolean");
  });

  it("answers a wrong key with AuthenticationError", async () => {
    const wrong = new Ampost({ apiKey: "amp_not_a_real_key", maxRetries: 0 });
    await assert.rejects(wrong.posts.list({ limit: 1 }), AuthenticationError);
  });
});
