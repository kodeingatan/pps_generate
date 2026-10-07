/**
 * helpers/embedding.js — embedding chunk teks memakai llama.cpp lokal.
 *
 * Sumber chunk: kelanjutan dari splitTextIntoChunks() di helpers/chungking.js
 *   const chunks = await splitTextIntoChunks(markdown);
 *   const out = await embedChunks(chunks);
 *
 * Backend:  bin/llama/build/llama-server(.exe)  +  bin/llama/embedding/*.gguf
 * Protokol: HTTP  POST /embedding  (llama.cpp server mode --embedding)
 * Model default: nomic-embed-text-v1.5 (dim 768, cosine).
 *   - dokumen diberi prefix "search_document: " dan query "search_query: "
 *     sesuai format pelatihan Nomic.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LLAMA_DIR = path.resolve(__dirname, "../bin/llama");
const BUILD_DIR = path.join(LLAMA_DIR, "build");
const EMBED_DIR = path.join(LLAMA_DIR, "embedding");
const META_PATH = path.join(LLAMA_DIR, "meta.json");

export const EMBEDDING_DIM_NOMIC = 768;

let _serverProc = null;
let _serverPort = null;
let _serverModel = null;

// ---------------------------------------------------------------------------
function findFileRecursive(dir, test) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (test(e.name, p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function resolveLlamaServerBin() {
  const cands = findFileRecursive(BUILD_DIR, (n) => /^llama-server(\.exe)?$/i.test(n));
  if (cands.length) return cands[0];
  // fallback: binary lama bernama llama-embedding-server
  const legacy = findFileRecursive(BUILD_DIR, (n) => /embedding-server(\.exe)?$/i.test(n));
  return legacy[0] || null;
}

export function resolveEmbeddingModel(preferPath = null) {
  if (preferPath && fs.existsSync(preferPath)) return preferPath;
  const ggufs = findFileRecursive(EMBED_DIR, (n) => n.toLowerCase().endsWith(".gguf"));
  if (!ggufs.length) return null;
  // prioritaskan nomic-embed-text, lalu yang terbesar (kualitas tertinggi)
  ggufs.sort((a, b) => {
    const an = /nomic/i.test(a) ? 0 : 1;
    const bn = /nomic/i.test(b) ? 0 : 1;
    if (an !== bn) return an - bn;
    return fs.statSync(b).size - fs.statSync(a).size;
  });
  return ggufs[0];
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Jumlah layer offload GPU: 0 untuk CPU, 99 untuk cuda/vulkan. */
export function defaultGpuLayers() {
  const meta = readMeta();
  const backend = (meta?.llama?.backend || "").toLowerCase();
  if (backend === "cuda12" || backend === "cuda13" || backend === "vulkan") return 99;
  return 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(port, { timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j.status === "ok" || j.status === "loading model" || res.status === 200) {
          // status "ok" berarti siap; "loading model" -> tunggu lagi
          if (j.status === "ok" || !j.status) return true;
        }
      }
    } catch { /* belum siap */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`llama-server tidak siap dalam ${timeoutMs}ms (port ${port})`);
    await sleep(500);
  }
}

/**
 * Menjalankan llama-server mode embedding. Idempoten: bila sudah jalan
 * dengan model+port yang sama, dipakai ulang.
 */
export async function ensureEmbeddingServer({ port = 8081, modelPath = null, gpuLayers = null, threads = null, ctxSize = 4096, batchSize = 2048, ubatch = 2048 } = {}) {
  const serverBin = resolveLlamaServerBin();
  if (!serverBin) {
    throw new Error(
      `llama-server tidak ditemukan di ${BUILD_DIR}. Jalankan dulu: node bin/pullbin.js --only=llama,model`,
    );
  }
  const model = modelPath || resolveEmbeddingModel();
  if (!model) {
    throw new Error(
      `model embedding *.gguf tidak ditemukan di ${EMBED_DIR}. Jalankan dulu: node bin/pullbin.js --only=model`,
    );
  }
  if (_serverProc && _serverPort === port && _serverModel === model) return { port, model, reused: true };

  // Bila port sudah melayani (mis. server yatim dari proses sebelumnya), adopsi ulang.
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/health`);
    if (probe.ok) {
      _serverProc = null; // tidak dimiliki proses ini — jangan dibunuh saat exit
      _serverPort = port;
      _serverModel = model;
      console.log(`♻️  memakai llama-server yang sudah berjalan di port ${port}`);
      return { port, model, reused: true, external: true };
    }
  } catch { /* tidak ada server — lanjut spawn */ }

  // hentikan server lama bila beda model/port
  if (_serverProc) await stopEmbeddingServer();

  const ngl = gpuLayers ?? defaultGpuLayers();
  const th = threads ?? Math.max(2, os.cpus().length - 1);
  const args = [
    "-m", model,
    "--embedding",
    "--pooling", "mean",
    "-c", String(ctxSize),
    "-b", String(batchSize),
    "-ub", String(ubatch),
    "--port", String(port),
    "--host", "127.0.0.1",
    "-ngl", String(ngl),
    "-t", String(th),
    "--log-disable",
  ];
  console.log(`🚀 llama-server embedding: ${path.basename(serverBin)} (ngl=${ngl}, threads=${th}, ctx=${ctxSize}, batch=${batchSize}, ubatch=${ubatch})`);
  console.log(`   model: ${model}`);
  const proc = spawn(serverBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (d) => {
    const s = d.toString();
    if (/error|fail/i.test(s)) process.stdout.write(`[llama-server] ${s}`);
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    // tampilkan hanya baris penting agar tidak berisik
    if (/error|fail|ready|listening|loading/i.test(s)) process.stdout.write(`[llama-server] ${s}`);
  });
  proc.on("exit", (code) => {
    if (_serverProc === proc) {
      _serverProc = null;
      console.log(`🛑 llama-server keluar (code ${code})`);
    }
  });
  _serverProc = proc;
  _serverPort = port;
  _serverModel = model;
  await waitForServer(port);
  console.log(`✅ llama-server siap di http://127.0.0.1:${port}`);
  return { port, model, reused: false };
}

export async function stopEmbeddingServer() {
  if (!_serverProc) return;
  const p = _serverProc;
  _serverProc = null;
  await new Promise((resolve) => {
    p.on("exit", () => resolve());
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"]);
      else p.kill("SIGTERM");
    } catch { /* abaikan */ }
    setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* abaikan */ }
      resolve();
    }, 5000).unref?.();
  });
}

/** POST /embedding untuk satu teks (sudah termasuk prefix Nomic bila diminta). */
export async function embedSingleText(text, { port = 8081, prefix = "search_document: ", _depth = 0 } = {}) {
  const content = `${prefix}${text}`;
  const res = await fetch(`http://127.0.0.1:${port}/embedding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // Chunk tabel padat bisa melebihi ubatch server ("input ... is too large").
    // Fallback: belah dua di batas kalimat/baris lalu rata-ratakan kedua vektor.
    if (res.status === 500 && /too large|batch size/i.test(t) && _depth < 4 && text.length > 200) {
      const mid = findSplitPoint(text);
      console.log(`   ⚠️  chunk ${text.length} char terlalu besar untuk 1 request — belah 2 (depth ${_depth + 1}).`);
      const [a, b] = await Promise.all([
        embedSingleText(text.slice(0, mid), { port, prefix, _depth: _depth + 1 }),
        embedSingleText(text.slice(mid), { port, prefix, _depth: _depth + 1 }),
      ]);
      return meanVector(a, b);
    }
    throw new Error(`POST /embedding gagal ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  // llama.cpp lama: { embedding: [...] }
  // llama.cpp baru (>= b6000): [ { index: 0, embedding: [...] | [[...]] } ]
  let vec = j.embedding;
  if (!Array.isArray(vec) && Array.isArray(j)) {
    const first = j[0] ?? j;
    vec = first?.embedding ?? first;
  }
  // beberapa build membungkus sekali lagi: [[...]]
  if (Array.isArray(vec) && vec.length === 1 && Array.isArray(vec[0]) && typeof vec[0][0] === "number") {
    vec = vec[0];
  }
  if (!Array.isArray(vec)) throw new Error(`Respons /embedding tak terduga: ${JSON.stringify(j).slice(0, 300)}`);
  return vec;
}

// ---------------------------------------------------------------------------
/**
 * Embedding lanjutan dari splitTextIntoChunks().
 *
 * @param {string[]} chunks  hasil splitTextIntoChunks(markdown)
 * @param {object} opts
 *   - port, modelPath, gpuLayers, threads, ctxSize, batchSize, ubatch
 *   - concurrency (default 4) — jumlah request paralel ke llama-server
 *   - keepServer (default true) — biarkan server hidup untuk pemakaian berikut
 *   - normalize (default true) — L2-normalize (bagus untuk cosine di Qdrant)
 *   - onProgress(done, total)
 * @returns {Promise<{ vectors: number[][], dim: number, model: string, port: number }>}
 */
export async function embedChunks(chunks, opts = {}) {
  if (!Array.isArray(chunks)) throw new TypeError("embedChunks(chunks): chunks harus array string.");
  const {
    port = 8081,
    modelPath = null,
    gpuLayers = null,
    threads = null,
    ctxSize = 4096,
    batchSize = 2048,
    ubatch = 2048,
    concurrency = 4,
    keepServer = true,
    normalize = true,
    onProgress = null,
  } = opts;

  const clean = chunks.map((c) => String(c ?? "")).filter((c) => c.trim().length > 0);
  if (!clean.length) return { vectors: [], dim: EMBEDDING_DIM_NOMIC, model: null, port };

  const { model } = await ensureEmbeddingServer({ port, modelPath, gpuLayers, threads, ctxSize, batchSize, ubatch });

  const vectors = new Array(clean.length);
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < clean.length) {
      const i = cursor++;
      const vec = await embedSingleText(clean[i], { port });
      vectors[i] = normalize ? l2normalize(vec) : vec;
      done++;
      onProgress?.(done, clean.length);
    }
  };
  const n = Math.min(Math.max(1, concurrency), clean.length);
  await Promise.all(Array.from({ length: n }, worker));

  const dim = vectors[0].length;
  if (!keepServer) await stopEmbeddingServer();
  return { vectors, dim, model, port, count: clean.length };
}

/** Embedding satu query (memakai prefix search_query agar sesuai Nomic). */
export async function embedQuery(queryText, opts = {}) {
  const { port = 8081, modelPath = null, normalize = true, ctxSize = 4096, batchSize = 2048, ubatch = 2048 } = opts;
  await ensureEmbeddingServer({ port, modelPath, ctxSize, batchSize, ubatch });
  const vec = await embedSingleText(String(queryText), { port, prefix: "search_query: " });
  return normalize ? l2normalize(vec) : vec;
}

export function l2normalize(vec) {
  let s = 0;
  for (const v of vec) s += v * v;
  const n = Math.sqrt(s) || 1;
  return vec.map((v) => v / n);
}

/** Rata-rata element-wise dua vektor berdimensi sama (untuk fallback belah chunk). */
export function meanVector(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    throw new Error(`meanVector: dimensi tidak sama (${a?.length} vs ${b?.length}).`);
  }
  return a.map((v, i) => (v + b[i]) / 2);
}

/** Cari titik belah dekat tengah teks, diutamakan batas paragraf/baris/spasi. */
export function findSplitPoint(text) {
  const mid = Math.floor(text.length / 2);
  const window = Math.floor(text.length * 0.2) || 50;
  const seps = ["\n\n", "\n", ". ", "; ", " ", "|"];
  for (const sep of seps) {
    let best = -1;
    let idx = text.indexOf(sep, mid - window);
    while (idx !== -1 && idx < mid + window) {
      if (best === -1 || Math.abs(idx - mid) < Math.abs(best - mid)) best = idx;
      idx = text.indexOf(sep, idx + 1);
    }
    if (best !== -1) return best + sep.length;
  }
  return mid;
}

export function embeddingStatus() {
  return {
    running: !!_serverProc,
    port: _serverPort,
    model: _serverModel,
    serverBin: resolveLlamaServerBin(),
    defaultModel: resolveEmbeddingModel(),
    buildDir: BUILD_DIR,
    embedDir: EMBED_DIR,
  };
}
