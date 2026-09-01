const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const {
  externalHttpUrl,
  loopbackHttpUrl,
  sameOriginUrl,
  trustedRendererUrl,
} = require("../electron/security.cjs");

test("desktop service URLs are confined to credential-free loopback", () => {
  assert.equal(loopbackHttpUrl("http://127.0.0.1:5174").port, "5174");
  assert.equal(loopbackHttpUrl("https://localhost:5174/app").pathname, "/app");
  assert.throws(() => loopbackHttpUrl("https://example.com"));
  assert.throws(() => loopbackHttpUrl("http://user:pass@localhost:5174"));
  assert.throws(() => loopbackHttpUrl("file:///tmp/index.html"));
});

test("external navigation accepts only HTTP(S) without embedded credentials", () => {
  assert.equal(externalHttpUrl("https://blockrun.ai/docs").hostname, "blockrun.ai");
  assert.equal(externalHttpUrl("javascript:alert(1)"), null);
  assert.equal(externalHttpUrl("https://user:pass@example.com"), null);
});

test("renderer trust is exact-origin in development and path-confined when packaged", () => {
  const dev = new URL("http://127.0.0.1:5174");
  assert.equal(trustedRendererUrl("http://127.0.0.1:5174/src/main.tsx", { devUrl: dev, distRoot: "/unused" }), true);
  assert.equal(trustedRendererUrl("http://localhost:5174", { devUrl: dev, distRoot: "/unused" }), false);
  assert.equal(sameOriginUrl("http://127.0.0.1:5174/other", dev), true);

  const distRoot = path.resolve("/tmp/franklin-dist");
  assert.equal(trustedRendererUrl(pathToFileURL(path.join(distRoot, "index.html")).href, { distRoot }), true);
  assert.equal(trustedRendererUrl(pathToFileURL("/tmp/other.html").href, { distRoot }), false);
  assert.equal(trustedRendererUrl("https://evil.example", { distRoot }), false);
});
