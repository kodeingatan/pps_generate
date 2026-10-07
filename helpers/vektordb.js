/**
 * helpers/vektordb.js — vector DB lokal memakai Qdrant di bin/llama/qdrant.
 *
 * Alur yang diharapkan (lihat index.js):
 *   const chunks = await splitTextIntoChunks(markdown);   // string[]
 *   const { vectors, dim } = await embedChunks(chunks);    // number[][]
 *   await upsertChunks(chunks, vectors, { collection, size: dim });
 *
 * Qdrant dijalankan sebagai proses lokal (biner hasil pullbin.js) lalu
 * diakses via REST http://127.0.0.1:6333.
 */

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QDRANT_DIR = path.resolve(__dirname, "../bin/llama/qdrant");
const QDRANT_STORAGE = path.join(QDRANT_DIR, "storage");

let _qdrantProc = null;
let _qdrantPort = null;

// ---------------------------------------------------------------------------
export function resolveQdrantBin() {
  const exe = process.platform === "win32" ? "qdrant.exe" : "qdrant";
  const direct = path.join(QDRANT_DIR, exe);
  if (fs.existsSync(direct)) return direct;
  // cari rekursif (jaga-jaga hasil ekstrak bersarang)
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const f = walk(p);
        if (f) return f;
      } else if (e.name.toLowerCase() === exe.toLowerCase()) return p;
    }
    return null;
  };
  return walk(QDRANT_DIR);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForQdrant(port, { timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (res.ok) return true;
    } catch { /* belum siap */ }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`qdrant tidak siap dalam ${timeoutMs}ms (port ${port}).`);
    }
    await sleep(500);
  }
}

/**
 * Pastikan proses Qdrant lokal berjalan. Idempoten.
 * @returns {{ port: number, reused: boolean, bin: string }}
 */
export async function ensureQdrantRunning({ port = 6333, storagePath = QDRANT_STORAGE } = {}) {
  // kalau port sudah merespons (mis. dijalankan manual), pakai ulang
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    if (res.ok) {
      _qdrantPort = port;
      return { port, reused: true, external: true };
    }
  } catch { /* lanjut: spawn sendiri */ }

  if (_qdrantProc && _qdrantPort === port) return { port, reused: true, external: false };

  const bin = resolveQdrantBin();
  if (!bin) {
    throw new Error(
      `biner qdrant tidak ditemukan di ${QDRANT_DIR}. Jalankan dulu: node bin/pullbin.js --only=qdrant`,
    );
  }
  fs.mkdirSync(storagePath, { recursive: true });

  // Qdrant dikonfigurasi via env QDRANT__* (lebih stabil lintas versi dibanding flag CLI)
  const env = {
    ...process.env,
    QDRANT__SERVICE__HTTP_PORT: String(port),
    QDRANT__STORAGE__STORAGE_PATH: storagePath,
    QDRANT__LOG_LEVEL: process.env.QDRANT__LOG_LEVEL || "INFO",
  };
  console.log(`🚀 qdrant: ${bin}`);
  console.log(`   storage: ${storagePath} | http://127.0.0.1:${port}`);
  const proc = spawn(bin, [], { env, stdio: ["ignore", "pipe", "pipe"], cwd: QDRANT_DIR });
  proc.stdout.on("data", (d) => {
    const s = d.toString();
    if (/error|warn|ready|listening|actix|started/i.test(s)) process.stdout.write(`[qdrant] ${s}`);
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (s.trim()) process.stdout.write(`[qdrant] ${s}`);
  });
  proc.on("exit", (code) => {
    if (_qdrantProc === proc) {
      _qdrantProc = null;
      console.log(`🛑 qdrant keluar (code ${code})`);
    }
  });
  _qdrantProc = proc;
  _qdrantPort = port;
  await waitForQdrant(port);
  console.log(`✅ qdrant siap di http://127.0.0.1:${port}`);
  return { port, reused: false, bin, external: false };
}

export async function stopQdrant() {
  if (!_qdrantProc) return;
  const p = _qdrantProc;
  _qdrantProc = null;
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

// ---------------------------------------------------------------------------
async function qdrantFetch(port, p, init) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Qdrant ${p} gagal ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

/** Buat collection bila belum ada. size = dimensi vektor (dari hasil chunking+embedding). */
export async function ensureCollection(collection, { size, distance = "Cosine", port = 6333, recreate = false } = {}) {
  if (!collection) throw new TypeError("ensureCollection: nama collection wajib diisi.");
  if (!Number.isInteger(size) || size <= 0) {
    throw new TypeError(`ensureCollection: 'size' (dimensi vektor) harus integer > 0, dapat: ${size}`);
  }
  await ensureQdrantRunning({ port });
  if (recreate) {
    await qdrantFetch(port, `/collections/${encodeURIComponent(collection)}`, { method: "DELETE" }).catch(() => {});
  } else {
    const exists = await qdrantFetch(port, `/collections/${encodeURIComponent(collection)}`, { method: "GET" }).catch(() => null);
    if (exists?.result) return { collection, existed: true, size };
  }
  await qdrantFetch(port, `/collections/${encodeURIComponent(collection)}`, {
    method: "PUT",
    body: JSON.stringify({ vectors: { size, distance } }),
  });
  return { collection, existed: false, size };
}

export async function getCollectionInfo(collection, { port = 6333 } = {}) {
  await ensureQdrantRunning({ port });
  return qdrantFetch(port, `/collections/${encodeURIComponent(collection)}`, { method: "GET" });
}

/** ID deterministik per chunk agar upsert idempoten (rerun tidak duplikat). */
export function chunkId(chunk, index, namespace = "") {
  const h = crypto.createHash("sha1").update(`${namespace}::${index}::${chunk}`).digest("hex");
  // Qdrant menerima unsigned int atau UUID; pakai 32-bit int dari hash agar sederhana
  return parseInt(h.slice(0, 8), 16);
}

// ---------------------------------------------------------------------------
/**
 * Simpan chunk + vektor embedding ke Qdrant.
 *
 * @param {string[]} chunks   teks chunk dari splitTextIntoChunks() (atau {chunk,size} bila dipanggil gaya lama)
 * @param {number[][]} vectors  vektor hasil embedChunks (sejajar dengan chunks)
 * @param {object} opts
 *   - collection (default "pps_docs")
 *   - size : dimensi vektor — WAJIB bila collection baru dibuat (diambil dari hasil chungking/embedding, cth. 768)
 *   - port, distance ("Cosine"), batchSize, source (label payload), recreate
 * @returns {Promise<{ collection: string, size: number, upserted: number }>}
 */
export async function upsertChunks(chunks, vectors, opts = {}) {
  const {
    collection = "pps_docs",
    size = null,
    port = 6333,
    distance = "Cosine",
    batchSize = 64,
    source = null,
    recreate = false,
  } = opts;

  if (!Array.isArray(chunks) || !Array.isArray(vectors)) {
    throw new TypeError("upsertChunks(chunks, vectors): keduanya harus array.");
  }
  if (chunks.length !== vectors.length) {
    throw new Error(`upsertChunks: jumlah chunks (${chunks.length}) != vectors (${vectors.length}).`);
  }
  if (!chunks.length) return { collection, size: size || 0, upserted: 0 };

  const dim = size || vectors[0]?.length;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new TypeError("upsertChunks: 'size'/dimensi vektor tidak valid. Teruskan size dari hasil embedding (mis. 768).");
  }
  for (let i = 0; i < vectors.length; i++) {
    if (!Array.isArray(vectors[i]) || vectors[i].length !== dim) {
      throw new Error(`upsertChunks: vectors[${i}] berdimensi ${vectors[i]?.length}, harus ${dim}.`);
    }
  }

  await ensureCollection(collection, { size: dim, distance, port, recreate });

  let upserted = 0;
  for (let s = 0; s < chunks.length; s += batchSize) {
    const batch = chunks.slice(s, s + batchSize).map((chunk, k) => {
      const i = s + k;
      return {
        id: chunkId(String(chunk), i, collection),
        vector: vectors[i],
        payload: { chunk: String(chunk), chunk_index: i, ...(source ? { source } : {}) },
      };
    });
    await qdrantFetch(port, `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ points: batch }),
    });
    upserted += batch.length;
    console.log(`   ⬆️  upsert ${upserted}/${chunks.length} -> '${collection}'`);
  }
  return { collection, size: dim, upserted };
}

/**
 * Cari chunk paling mirip terhadap query vector.
 * @returns array [{ id, score, chunk, chunk_index }]
 */
export async function searchSimilar(queryVector, { collection = "pps_docs", limit = 5, port = 6333, withPayload = true } = {}) {
  if (!Array.isArray(queryVector)) throw new TypeError("searchSimilar: queryVector harus array.");
  await ensureQdrantRunning({ port });
  const body = await qdrantFetch(port, `/collections/${encodeURIComponent(collection)}/points/search`, {
    method: "POST",
    body: JSON.stringify({ vector: queryVector, limit, with_payload: withPayload }),
  });
  return (body.result || []).map((r) => ({
    id: r.id,
    score: r.score,
    chunk: r.payload?.chunk ?? null,
    chunk_index: r.payload?.chunk_index ?? null,
  }));
}

export function qdrantStatus() {
  return {
    running: !!_qdrantProc,
    port: _qdrantPort,
    bin: resolveQdrantBin(),
    dir: QDRANT_DIR,
    storage: QDRANT_STORAGE,
  };
}
