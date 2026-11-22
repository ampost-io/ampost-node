import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { json, mockClient, page } from "./helpers.js";

const posts = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `p${from + i}` }));

describe("pagination", () => {
  it("awaits to the first page", async () => {
    const { client, calls } = mockClient([json(200, page(posts(0, 2), 0, 5))]);
    const first = await client.posts.list({ limit: 2 });
    assert.deepEqual(first.data.map((p) => p.id), ["p0", "p1"]);
    assert.equal(first.pagination.hasMore, true);
    assert.equal(calls.length, 1);
  });

  it("iterates every item across pages, moving the offset by the page size", async () => {
    const { client, calls } = mockClient([
      json(200, page(posts(0, 2), 0, 5)),
      json(200, page(posts(2, 2), 2, 5)),
      json(200, page(posts(4, 1), 4, 5)),
    ]);
    const ids: string[] = [];
    for await (const post of client.posts.list({ limit: 2, status: "published" })) ids.push(post.id);
    assert.deepEqual(ids, ["p0", "p1", "p2", "p3", "p4"]);
    assert.deepEqual(
      calls.map((c) => c.url.search),
      ["?limit=2&status=published", "?limit=2&status=published&offset=2", "?limit=2&status=published&offset=4"],
    );
  });

  it("starts from the caller's offset and keeps path parameters", async () => {
    const { client, calls } = mockClient([json(200, page([{ id: "d1" }], 10, 12)), json(200, page([{ id: "d2" }], 11, 12))]);
    const all = await client.webhooks.listDeliveries("w1", { offset: 10, limit: 1 }).toArray();
    assert.deepEqual(all.map((d) => d.id), ["d1", "d2"]);
    assert.equal(calls[1]!.url.pathname, "/api/webhooks/endpoints/w1/deliveries");
    assert.equal(calls[1]!.url.searchParams.get("offset"), "11");
  });

  it("requests the first page once when awaited and then iterated", async () => {
    const { client, calls } = mockClient([json(200, page(posts(0, 1), 0, 1))]);
    const list = client.accounts.list();
    await list;
    const pages = [];
    for await (const p of list.pages()) pages.push(p);
    assert.equal(pages.length, 1);
    assert.equal(calls.length, 1);
  });

  it("stops on an empty page even if hasMore is set", async () => {
    const { client } = mockClient([json(200, { data: [], pagination: { limit: 20, offset: 0, total: 3, hasMore: true } })]);
    assert.deepEqual(await client.platformSets.list().toArray(), []);
  });

  it("is lazy: nothing is sent until it is awaited or iterated", async () => {
    const { client, calls } = mockClient([]);
    client.posts.list();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, 0);
  });
});
