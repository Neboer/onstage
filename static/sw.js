/* Only immutable public artwork is cached. HTML, scripts and APIs always use the network. */
"use strict";
const ART_CACHE = "onstage-artwork-v1";
const MAX_FILES = 256;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const downloads = new Set();
let cacheEpoch = 0;
let mutation = Promise.resolve();
const serialize = (fn) => { const result = mutation.then(fn); mutation = result.catch(() => {}); return result; };

function artworkURL(value) {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && !url.search && !url.hash &&
      /^\/static\/assets\/optimized\/[a-f0-9]{64}\.webp$/.test(url.pathname) ? url : null;
  } catch { return null; }
}
function cacheRequest(url) { return new Request(url.href, { credentials: "omit" }); }
async function putArtwork(url, response, epoch) {
  if (!response.ok || response.redirected || !["basic", "default"].includes(response.type) ||
      response.headers.get("Content-Type")?.split(";")[0].trim() !== "image/webp") throw new Error("invalid_artwork_response");
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > MAX_FILE_BYTES) throw new Error("artwork_too_large");
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error("artwork_too_large");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
  if (!url.pathname.endsWith(`/${hash}.webp`)) throw new Error("artwork_hash_mismatch");
  return serialize(async () => {
    if (epoch !== cacheEpoch) return;
    const cache = await caches.open(ART_CACHE);
    const request = cacheRequest(url);
    if (await cache.match(request)) return;
    const keys = await cache.keys();
    let total = 0;
    const sizes = [];
    for (const key of keys) {
      const old = await cache.match(key);
      const size = Number(old?.headers.get("X-Onstage-Bytes")) || MAX_FILE_BYTES;
      total += size; sizes.push(size);
    }
    while (keys.length && (keys.length >= MAX_FILES || total + bytes.byteLength > MAX_BYTES)) {
      await cache.delete(keys.shift()); total -= sizes.shift();
    }
    const headers = new Headers(response.headers);
    // Fetch decoded the body; do not retain transport encoding/length for the synthetic response.
    headers.delete("Content-Encoding"); headers.delete("Content-Length");
    headers.set("X-Onstage-Bytes", String(bytes.byteLength));
    await cache.put(request, new Response(bytes, { status: 200, headers }));
  });
}
async function fetchArtwork(url, signal, explicit = false) {
  const epoch = cacheEpoch;
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(cacheRequest(url));
  if (hit) return hit;
  if (explicit && downloads.size >= 3) throw new Error("artwork_download_busy");
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) abort.abort();
  if (explicit) downloads.add(abort);
  const timer = setTimeout(cancel, 15000);
  try {
    const response = await fetch(url.href, { credentials: "omit", signal: abort.signal, redirect: "error" });
    // A cache/quota failure must not prevent normal artwork from displaying.
    const copy = response.clone();
    try { await putArtwork(url, copy, epoch); } catch (error) { if (explicit) throw error; }
    return response;
  } finally {
    clearTimeout(timer); downloads.delete(abort); signal?.removeEventListener("abort", cancel);
  }
}
async function status() {
  const cache = await caches.open(ART_CACHE);
  const keys = await cache.keys();
  let cachedBytes = 0;
  for (const key of keys) cachedBytes += Number((await cache.match(key))?.headers.get("X-Onstage-Bytes")) || 0;
  return { cached: keys.length, cachedBytes, maxBytes: MAX_BYTES, maxFiles: MAX_FILES };
}
self.addEventListener("install", () => { /* No precache, skipWaiting or forced reload: preserve open drafts. */ });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode === "navigate" || request.headers.has("Authorization")) return;
  const url = artworkURL(request.url);
  if (url) event.respondWith(fetchArtwork(url, request.signal));
});
self.addEventListener("message", (event) => {
  const port = event.ports?.[0];
  if (!port || !event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  const run = async () => {
    switch (event.data?.type) {
      case "ARTWORK_STATUS": return status();
      case "ARTWORK_CACHE": {
        const url = artworkURL(event.data.url);
        if (!url) throw new Error("invalid_artwork_url");
        const response = await fetchArtwork(url, undefined, true);
        if (!response.ok) throw new Error("artwork_download_failed");
        return { cached: true };
      }
      case "ARTWORK_CANCEL": for (const abort of downloads) abort.abort(); return { cancelled: true };
      case "ARTWORK_CLEAR":
        cacheEpoch += 1;
        for (const abort of downloads) abort.abort();
        await serialize(() => caches.delete(ART_CACHE));
        return { cleared: true };
      default: throw new Error("unknown_artwork_command");
    }
  };
  event.waitUntil(run().then((result) => port.postMessage({ ok: true, result }), (error) => port.postMessage({ ok: false, error: String(error.message || "artwork_error") })));
});
