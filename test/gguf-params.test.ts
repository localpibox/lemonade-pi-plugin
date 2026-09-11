import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkpointToHfUrl,
  parseGgufHeader,
} from "../lib/gguf-params.js";

let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
  if (!cond) fail++;
}

// ── checkpointToHfUrl ───────────────────────────────────────────────────────
check(
  "checkpoint pointer → HF resolve URL",
  checkpointToHfUrl("unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-UD-Q4_K_XL.gguf") ===
    "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_XL.gguf",
  checkpointToHfUrl("unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-UD-Q4_K_XL.gguf"),
);
check("file name with spaces is encoded",
  checkpointToHfUrl("org/repo:model v2 gguf.gguf") ===
    "https://huggingface.co/org/repo/resolve/main/model%20v2%20gguf.gguf");
check("bare local path → undefined", checkpointToHfUrl("/models/qwen.gguf") === undefined);
check("no colon → undefined", checkpointToHfUrl("unsloth/Qwen3.8-27B-GGUF") === undefined);
check("empty repo → undefined", checkpointToHfUrl(":file.gguf") === undefined);
check("undefined → undefined", checkpointToHfUrl(undefined) === undefined);

// ── parseGgufHeader on the real fixture ─────────────────────────────────────
// First 200KB of unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-UD-Q4_K_XL.gguf
// (KV table fits well inside; verified values 2026-09-07).
const fixturePath = path.join(__dirname, "fixtures", "qwen38-q4kxl-header.gguf");
const fixture = new Uint8Array(fs.readFileSync(fixturePath));

const info = parseGgufHeader(fixture);
check("fixture parses", info !== undefined);
check("architecture = qwen35", info?.architecture === "qwen35", info?.architecture);
check("sampling.temp = 1.0", info?.sampling?.temp === 1.0, info?.sampling);
check("sampling.top_p = 0.95", info?.sampling?.top_p === 0.95, info?.sampling);
check("sampling.top_k = 20", info?.sampling?.top_k === 20, info?.sampling);
check(
  "base_model repo_url (official repo pointer)",
  info?.baseModelRepo === "https://huggingface.co/Qwen/Qwen3.8-27B",
  info?.baseModelRepo,
);

// ── error paths ──────────────────────────────────────────────────────────────
check("bad magic → undefined", parseGgufHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === undefined);

// Truncated mid-table: cut the fixture after the first two kvs (~107 bytes).
const truncated = fixture.subarray(0, 107);
const tinfo = parseGgufHeader(truncated);
check("truncated header: keeps parsed kvs (architecture)", tinfo?.architecture === "qwen35", tinfo);
check("truncated header: flags truncated", tinfo?.truncated === true);

// Header only (magic+counts, no kvs) with kvCount=0 → empty info, not an error.
const headerOnly = new Uint8Array(24);
headerOnly.set([0x47, 0x47, 0x55, 0x46, 0x03, 0x00, 0x00, 0x00], 0); // magic + version 3
// tensor_count=0, kv_count=0 already zero
check("empty kv table → info without sampling", parseGgufHeader(headerOnly)?.sampling === undefined);

// Corrupt key length (u64 max) with kvCount>0 → RangeError thrown at i=0.
let threw = false;
try {
  const corrupt = new Uint8Array(24 + 8 + 4);
  corrupt.set([0x47, 0x47, 0x55, 0x46, 0x03, 0x00, 0x00, 0x00], 0);
  // kv_count = 1
  new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]).forEach((b, i) => (corrupt[16 + i] = b));
  // key_len = 0xFFFFFFFFFFFFFFFF
  corrupt.fill(0xff, 24, 32);
  parseGgufHeader(corrupt);
} catch (e) {
  threw = e instanceof RangeError;
}
check("corrupt first key → RangeError", threw);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
