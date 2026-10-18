import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function startTestServer({ port = 0, operatorToken = randomBytes(32).toString("hex"), origin = null, writeFrozen = false } = {}) {
  const bundled = await build({ entryPoints: [path.join(root, "edge/testing-worker.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-05-15", port, host: "127.0.0.1", inspectorPort: 0, d1Databases: { DB: "onstage-isolated-tests" }, bindings: { ONSTAGE_VERSION: "0.7.0", ...(origin ? { ONSTAGE_PUBLIC_ORIGIN: origin } : {}), ONSTAGE_OPERATOR_TOKEN: operatorToken, ONSTAGE_WRITE_FROZEN: writeFrozen ? "1" : "0" }, log: undefined });
  await mf.ready;
  const db = await mf.getD1Database("DB");
  const migrations = (await readdir(path.join(root, "drizzle"))).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    const sql = await readFile(path.join(root, "drizzle", migration), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  return { mf, db, origin: (await mf.ready).origin, operatorToken, dispose: () => mf.dispose() };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ONSTAGE_EDGE_TEST_PORT || 18768);
  const server = await startTestServer({ port, origin: `http://127.0.0.1:${port}` });
  const ready = await fetch(server.origin + "/readyz");
  console.log(JSON.stringify({ status: ready.status, origin: server.origin, readiness: await ready.json(), scope: "isolated-api-only-local-miniflare-d1-no-browser-preview" }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await server.dispose(); process.exit(0); });
  await new Promise(() => {});
}
