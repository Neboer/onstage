import assert from "node:assert/strict";
import { startTestServer } from "./test-server.mjs";

const server = await startTestServer({ writeFrozen: true });
try {
  for (const route of ["/api/session", "/api/rooms", "/api/rooms/test/messages", "/api/operator/rooms/test/end"]) {
    const response = await fetch(server.origin + route, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 503, route);
    assert.equal(response.headers.get("Retry-After"), "60");
  }
  assert.equal((await fetch(server.origin + "/healthz")).status, 200);
  assert.equal((await fetch(server.origin + "/readyz")).status, 200);
  assert.equal((await fetch(server.origin + "/api/operator/export")).status, 401);
  const exported = await fetch(server.origin + "/api/operator/export", { headers: { Authorization: `Bearer ${server.operatorToken}` } });
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).row_counts.sessions, 0);
  assert.equal((await server.db.prepare("SELECT COUNT(*) AS count FROM rooms").first()).count, 0);
  console.log("D1 write-freeze: writes denied; readiness and authenticated private export preserved; no business rows created");
} finally { await server.dispose(); }
