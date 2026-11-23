// Usage: node tools/encrypt.mjs <password> <input.html> <output.json>
// Encrypts the page content with AES-GCM; key derived via PBKDF2-SHA256.
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const [password, input, output] = process.argv.slice(2);
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
  keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
);
const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(readFileSync(input, "utf8")));
const b64 = (buf) => Buffer.from(buf).toString("base64");
writeFileSync(output, JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(data) }, null, 2));
console.log("written", output);
