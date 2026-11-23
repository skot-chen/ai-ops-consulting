// 构建加密站点内容：内容 + 报告工具 → 用密码加密 → content.enc.json
// 用法: node tools/build-site.mjs <password>
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [password] = process.argv.slice(2);
if (!password) throw new Error("用法: node tools/build-site.mjs <password>");

const read = (p) => readFileSync(join(root, p), "utf8");
const payload = {
  html: [
    "private/content.html",
    "tools/report/tool-section.html",
    "tools/site/diag-section.html",
    "tools/site/balance-section.html",
  ].map(read).join("\n"),
  js: [
    "tools/report/report-core.js",
    "tools/report/ui.js",
    "tools/site/diag-core.js",
    "tools/site/balance-core.js",
    "tools/site/diag.js",
    "tools/site/balance.js",
  ].map(read).join("\n"),
};

const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
const b64 = (buf) => Buffer.from(buf).toString("base64");
writeFileSync(join(root, "content.enc.json"), JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(data) }, null, 2));
console.log("written content.enc.json");
