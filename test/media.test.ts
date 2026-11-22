import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AmpostError, MediaUploadError } from "../src/index.js";
import { guessContentType } from "../src/media.js";
import { json, mockClient } from "./helpers.js";

const UPLOAD_ID = "0f6b9d1e-8f0a-4a52-9c39-3c1f0f3b8a77";
const created = {
  id: UPLOAD_ID,
  status: "pending",
  uploadPageUrl: `https://ampost.io/upload/${UPLOAD_ID}#token=secret`,
  uploadUrl: "https://vercel.com/api/blob/?pathname=media%2Flaunch.mp4",
  method: "PUT",
  headers: { authorization: "Bearer vercel_blob_client_x", "x-api-version": "12" },
  limits: { maxFiles: 35, maxSizeBytes: 209715200, mimeTypes: ["video/mp4"] },
  createdAt: "2026-11-22T12:00:00.000Z",
  expiresAt: "2026-11-22T13:00:00.000Z",
};
const file = {
  url: "https://ampost.io/media/abc/launch.mp4",
  type: "video",
  mimeType: "video/mp4",
  sizeBytes: 4,
  width: 1080,
  height: 1920,
  durationSeconds: 12.5,
};
const status = (state: string, extra: object = {}) => ({
  id: UPLOAD_ID,
  status: state,
  files: state === "completed" ? [file] : [],
  createdAt: created.createdAt,
  expiresAt: created.expiresAt,
  completedAt: null,
  error: null,
  ...extra,
});

describe("media.upload", () => {
  it("creates an upload, PUTs the bytes with the given headers only, and waits for the file", async () => {
    const { client, calls } = mockClient([
      json(201, created),
      json(200, { url: "https://blob.example/launch.mp4" }),
      json(200, status("pending")),
      json(200, status("completed")),
    ]);
    const bytes = new Uint8Array([0, 0, 0, 24]);
    const result = await client.media.upload(bytes, { fileName: "launch.mp4", pollIntervalMs: 1 });
    assert.deepEqual(result, file);

    const [create, put, poll1, poll2] = calls;
    assert.equal(create!.url.pathname, "/api/media/uploads");
    assert.deepEqual(create!.body, { fileName: "launch.mp4" });
    assert.equal(put!.method, "PUT");
    assert.equal(put!.url.toString(), created.uploadUrl);
    // Storage gets its own token, never the Ampost API key.
    assert.equal(put!.headers.get("authorization"), "Bearer vercel_blob_client_x");
    assert.equal(put!.headers.get("x-api-version"), "12");
    assert.equal(put!.headers.get("x-content-type"), "video/mp4");
    assert.deepEqual(put!.body, bytes);
    assert.equal(poll1!.url.pathname, `/api/media/uploads/${UPLOAD_ID}`);
    assert.equal(poll2!.headers.get("authorization"), "Bearer amp_test_key");
  });

  it("reads a file path and takes the name and type from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ampost-sdk-"));
    const path = join(dir, "photo.PNG");
    writeFileSync(path, Buffer.from([137, 80, 78, 71]));
    const { client, calls } = mockClient([json(201, created), json(200, {}), json(200, status("completed"))]);
    await client.media.upload(path);
    assert.deepEqual(calls[0]!.body, { fileName: "photo.PNG" });
    assert.equal(calls[1]!.headers.get("x-content-type"), "image/png");
    const sent = calls[1]!.body as Blob | Uint8Array;
    const bytes = sent instanceof Uint8Array ? sent : new Uint8Array(await sent.arrayBuffer());
    assert.deepEqual([...bytes], [137, 80, 78, 71]);
  });

  it("uses a Blob's type", async () => {
    const { client, calls } = mockClient([json(201, created), json(200, {}), json(200, status("completed"))]);
    await client.media.upload(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    assert.deepEqual(calls[0]!.body, { fileName: "file" });
    assert.equal(calls[1]!.headers.get("x-content-type"), "image/webp");
  });

  it("refuses a file whose type it cannot tell, before calling the API", async () => {
    const { client, calls } = mockClient([]);
    await assert.rejects(client.media.upload(new Uint8Array([1]), { fileName: "notes" }), AmpostError);
    assert.equal(calls.length, 0);
  });

  it("throws MediaUploadError when Ampost refuses the file", async () => {
    const { client } = mockClient([
      json(201, created),
      json(200, {}),
      json(200, status("failed", { error: "The bytes are not a video/mp4 file" })),
    ]);
    await assert.rejects(client.media.upload(new Uint8Array([1]), { fileName: "a.mp4" }), (error: unknown) => {
      assert.ok(error instanceof MediaUploadError);
      assert.equal(error.reason, "failed");
      assert.equal(error.uploadId, UPLOAD_ID);
      assert.match(error.message, /not a video\/mp4/);
      return true;
    });
  });

  it("throws when storage rejects the PUT", async () => {
    const { client, calls } = mockClient([json(201, created), new Response("Forbidden", { status: 403 })]);
    await assert.rejects(client.media.upload(new Uint8Array([1]), { fileName: "a.mp4" }), (error: unknown) => {
      return error instanceof MediaUploadError && error.reason === "upload_rejected" && /403/.test(error.message);
    });
    assert.equal(calls.length, 2);
  });

  it("gives up waiting after waitTimeoutMs", async () => {
    const { client } = mockClient([json(201, created), json(200, {}), json(200, status("pending"))]);
    await assert.rejects(
      client.media.upload(new Uint8Array([1]), { fileName: "a.mp4", pollIntervalMs: 50, waitTimeoutMs: 10 }),
      (error: unknown) => error instanceof MediaUploadError && error.reason === "timeout",
    );
  });

  it("guesses common types", () => {
    assert.equal(guessContentType("a.JPG"), "image/jpeg");
    assert.equal(guessContentType("clip.mov"), "video/quicktime");
    assert.equal(guessContentType("README"), undefined);
  });
});
