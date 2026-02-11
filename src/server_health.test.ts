import test from "node:test";
import assert from "node:assert/strict";

import { classifyClobHealthFailure } from "./server.js";

test("classifyClobHealthFailure handles rate limit", () => {
  const result = classifyClobHealthFailure({ status: 429 });
  assert.equal(result.status, "rate_limited");
  assert.match(result.reason, /Rate limited/i);
});

test("classifyClobHealthFailure handles timeout", () => {
  const err = new Error("The operation was aborted");
  (err as Error & { name: string }).name = "AbortError";
  const result = classifyClobHealthFailure({ error: err });
  assert.equal(result.status, "offline");
  assert.match(result.reason, /timed out/i);
});

test("classifyClobHealthFailure handles http status", () => {
  const result = classifyClobHealthFailure({ status: 503 });
  assert.equal(result.status, "offline");
  assert.match(result.reason, /503/);
});
