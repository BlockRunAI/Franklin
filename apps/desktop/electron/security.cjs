const path = require("node:path");
const { fileURLToPath } = require("node:url");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function parsedUrl(value) {
  try { return new URL(String(value)); }
  catch { return null; }
}

function loopbackHttpUrl(value, label = "URL") {
  const url = parsedUrl(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`${label} must be an HTTP(S) URL`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error(`${label} must target loopback without credentials`);
  }
  return url;
}

function externalHttpUrl(value) {
  const url = parsedUrl(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  if (url.username || url.password) return null;
  return url;
}

function sameOriginUrl(value, allowed) {
  const url = parsedUrl(value);
  return Boolean(url && allowed && url.origin === allowed.origin);
}

function pathInside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function trustedRendererUrl(value, { devUrl, distRoot }) {
  const url = parsedUrl(value);
  if (!url) return false;
  if (devUrl) return sameOriginUrl(url.href, devUrl);
  if (url.protocol !== "file:" || url.username || url.password) return false;
  try { return pathInside(distRoot, fileURLToPath(url)); }
  catch { return false; }
}

module.exports = {
  externalHttpUrl,
  loopbackHttpUrl,
  sameOriginUrl,
  trustedRendererUrl,
};
