import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(desktop, "release");
const expected = process.argv[3] || JSON.parse(await fs.readFile(path.join(desktop, "package.json"), "utf8")).version;
const manifests = (await fs.readdir(directory)).filter((name) => /^latest(?:-mac)?\.yml$/.test(name));
assert.ok(manifests.length, "No Desktop update metadata was generated");
for (const name of manifests) {
  const document = parseDocument(await fs.readFile(path.join(directory, name), "utf8"), { uniqueKeys: true });
  assert.equal(document.errors.length, 0, "Invalid update metadata");
  const info = document.toJS({ maxAliasCount: 0 });
  assert.equal(info.version, expected);
  assert.ok(info.files.length);
  assert.ok(info.files.some((file) => file.url.endsWith(name.includes("mac") ? ".zip" : ".exe")), "Native update payload is missing");
  for (const file of info.files) {
    assert.match(file.url, /^[\w.-]+$/);
    const target = path.join(directory, file.url);
    assert.equal((await fs.stat(target)).size, file.size);
    const hash = crypto.createHash("sha512");
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    assert.equal(hash.digest("base64"), file.sha512, `${file.url}: checksum mismatch`);
  }
  console.log(`PASS ${name}: correct version, native payload, file sizes and SHA-512`);
}
