import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Ampost, OPERATIONS, VERSION } from "../src/index.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("generated layer", () => {
  it("has a client method for every operation in openapi.json", () => {
    const client = new Ampost({ apiKey: "k" }) as unknown as Record<string, Record<string, unknown>>;
    const inSpec = Object.values(spec.paths).flatMap((item) =>
      Object.values(item as Record<string, { operationId?: string }>).map((op) => op.operationId).filter(Boolean),
    );
    assert.deepEqual(OPERATIONS.map((op) => op.operationId).sort(), inSpec.sort());
    for (const op of OPERATIONS) {
      assert.equal(typeof client[op.resource]?.[op.method], "function", `${op.operationId} -> ${op.resource}.${op.method}`);
    }
  });

  it("marks exactly the operations that take Idempotency-Key", () => {
    for (const op of OPERATIONS) {
      const parameters = spec.paths[op.path][op.httpMethod.toLowerCase()].parameters ?? [];
      const takesKey = parameters.some((p: { name: string }) => p.name === "Idempotency-Key");
      assert.equal(op.idempotent, takesKey, op.operationId);
    }
  });

  it("keeps VERSION equal to package.json", () => {
    assert.equal(VERSION, pkg.version);
  });
});
