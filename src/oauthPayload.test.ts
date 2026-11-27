import { test } from "node:test";
import assert from "node:assert/strict";
import { signInPayload } from "./oauthPayload.ts";

test("sign-in payload carries PKCE, the request order and the webview epoch", () => {
  assert.deepEqual(signInPayload({ verifier: "v", challenge: "c", state: "s" }, 3, "e"), { verifier: "v", challenge: "c", state: "s", seq: 3, epoch: "e" });
});
