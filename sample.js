/**
 * index.js — uji end-to-end: file -> markdown -> chunk -> embedding -> Qdrant.
 *
 * Cara pakai:
 *   node index.js [path-ke-file] [--no-dialog] [--collection=nama] [--recreate]
 *   node index.js --selftest        # tanpa file/dialog: memakai teks contoh (untuk CI)
 *
 * Opsi lengkap (semua dibaca sekali sebagai const di awal program):
 *   --chunk-size=1200 --chunk-overlap=200
 *   --embed-port=8081 --embed-ctx=4096 --embed-batch=2048 --embed-ubatch=2048
 *   --embed-concurrency=4 --qdrant-port=6333 --collection=pps_docs
 *   --query="..." --search-limit=3 --recreate --no-dialog --selftest
 *
 * Alur:
 *  1. Ambil file (argumen CLI > dialog Windows) lalu convert ke markdown
 *     (atau langsung baca bila file sudah .md/.txt).
 *  2. splitTextIntoChunks() dari helpers/chungking.js
 *  3. embedChunks() dari helpers/embedding.js (llama.cpp lokal)
 *  4. upsertChunks() + searchSimilar() dari helpers/vektordb.js (Qdrant lokal)
 */

import fs from "node:fs";
import path from "node:path";
import { handleFileOpen } from "./helpers/filemanager.js";
import { convertToMarkdownSave, convertToMarkdown } from "./helpers/obsidian.js";
import { splitTextIntoChunks } from "./helpers/chungking.js";
import { embedChunks, embedQuery, embeddingStatus } from "./helpers/embedding.js";
import { upsertChunks, searchSimilar, getCollectionInfo } from "./helpers/vektordb.js";

const argv = process.argv.slice(2);
const getArg = (name, def = null) => {
  const p = argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// Konfigurasi CLI (semua opsi dibaca sekali di awal program)
// ---------------------------------------------------------------------------
// Mode input
const FILE_ARG = argv.find((a) => !a.startsWith("--")) || null;
const FLAG_SELFTEST = hasFlag("selftest");
const FLAG_NO_DIALOG = hasFlag("no-dialog");
// Chunking (helpers/chungking.js)
const CHUNK_SIZE = Number(getArg("chunk-size", 1200));
const CHUNK_OVERLAP = Number(getArg("chunk-overlap", 200));
// Embedding lokal via llama.cpp (helpers/embedding.js)
const EMBED_PORT = Number(getArg("embed-port", 8081));
const EMBED_CTX = Number(getArg("embed-ctx", 4096));
const EMBED_BATCH = Number(getArg("embed-batch", 2048));
const EMBED_UBATCH = Number(getArg("embed-ubatch", 2048));
const EMBED_CONCURRENCY = Number(getArg("embed-concurrency", 4));
// Vector DB Qdrant lokal (helpers/vektordb.js)
const QDRANT_PORT = Number(getArg("qdrant-port", 6333));
const COLLECTION = getArg("collection", "pps_docs");
const FLAG_RECREATE = hasFlag("recreate");
// Uji retrieval
const QUERY = getArg("query", "tentukan berapa realisasi : .., rencana : .., dan deviasi : ..");
const SEARCH_LIMIT = Number(getArg("search-limit", 3));

const SAMPLE_TEXT = `---
title: selftest
---

# Dokumen Uji PPS

Paragraf satu membahas konversi dokumen menjadi markdown memakai markitdown.
Hasil markdown kemudian dipecah menjadi chunk kecil agar bisa di-embedding.

Paragraf dua membahas embedding memakai model nomic-embed-text-v1.5 yang
dijalankan lokal via llama.cpp (llama-server mode --embedding).
Setiap chunk diubah menjadi vektor 768 dimensi.

Paragraf tiga membahas penyimpanan vektor ke Qdrant yang juga berjalan lokal
dari biner di bin/llama/qdrant. Koleksi memakai jarak Cosine.
Kueri "bagaimana cara embedding chunk?" seharusnya paling mirip dengan paragraf dua.
`;

async function resolveInputText() {
  if (FLAG_SELFTEST) {
    console.log("🧪 mode --selftest: memakai teks contoh (tanpa file/dialog).");
    return { text: SAMPLE_TEXT, label: "selftest-inline" };
  }
  const fileArg = FILE_ARG;
  let filePath = fileArg && fs.existsSync(fileArg) ? fileArg : null;

  if (!filePath && !FLAG_NO_DIALOG) {
    console.log("📂 Membuka dialog pilih file...");
    try {
      filePath = await handleFileOpen();
    } catch (e) {
      console.warn(`⚠️  dialog gagal (${e.message}), lanjut ke selftest.`);
    }
  }
  if (!filePath) {
    if (fileArg) console.warn(`⚠️  file '${fileArg}' tidak ditemukan, memakai teks contoh.`);
    else console.log("ℹ️  tidak ada file dipilih, memakai teks contoh. (pakai: node index.js <file> atau --selftest)");
    return { text: SAMPLE_TEXT, label: "fallback-inline" };
  }

  console.log(`📄 file: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".txt" || ext === ".markdown") {
    return { text: fs.readFileSync(filePath, "utf8"), label: filePath };
  }
  // Dokumen lain (pdf/docx/dll) -> markitdown -> markdown (disimpan .md di samping file)
  console.log("🔄 convert ke markdown via markitdown...");
  const outMd = await convertToMarkdownSave(filePath);
  console.log(`✅ markdown tersimpan: ${outMd}`);
  // baca kembali hasil convert untuk pipeline (lebih akurat daripada stdout mentah)
  return { text: fs.readFileSync(outMd, "utf8"), label: outMd };
}

(async () => {
  const t0 = Date.now();
  console.log("════════ PPS end-to-end test ════════");
  console.log("status embedding:", embeddingStatus());

  // 1) input -> markdown text
  const { text: markdown, label } = await resolveInputText();
  console.log(`📝 input [${label}]: ${markdown.length} karakter`);

  // 2) chunking
  const chunkSize = CHUNK_SIZE;
  const chunkOverlap = CHUNK_OVERLAP;
  const tChunk = Date.now();
  const chunks = await splitTextIntoChunks(markdown, chunkSize, chunkOverlap);
  console.log(`✂️  chunking: ${chunks.length} chunk (size=${chunkSize}, overlap=${chunkOverlap}, ${(Date.now() - tChunk)}ms)`);
  chunks.slice(0, 3).forEach((c, i) => console.log(`   [${i}] ${c.slice(0, 120).replace(/\s+/g, " ")}...`));
  if (!chunks.length) throw new Error("chunk kosong — teks input kosong?");

  // 3) embedding via llama.cpp lokal
  const port = EMBED_PORT;
  console.log(`\n🧠 embedding ${chunks.length} chunk via llama-server (port ${port})...`);
  const tEmb = Date.now();
  const { vectors, dim, model } = await embedChunks(chunks, {
    port,
    ctxSize: EMBED_CTX,
    batchSize: EMBED_BATCH,
    ubatch: EMBED_UBATCH,
    concurrency: EMBED_CONCURRENCY,
    keepServer: true,
    onProgress: (d, t) => process.stdout.write(`\r   ${d}/${t}`),
  });
  process.stdout.write("\n");
  console.log(`✅ embedding selesai: dim=${dim}, model=${model} (${Date.now() - tEmb}ms)`);
  console.log(`   contoh vektor[0][:5] = [${vectors[0].slice(0, 5).map((v) => v.toFixed(4)).join(", ")}]`);

  // 4) Qdrant: upsert + verifikasi search
  const collection = COLLECTION;
  const qdrantPort = QDRANT_PORT;
  console.log(`\n🗄️  Qdrant upsert -> collection '${collection}' (size=${dim})...`);
  const tQ = Date.now();
  const up = await upsertChunks(chunks, vectors, {
    collection,
    size: dim, // <-- 'size' dari hasil chunking/embedding
    port: qdrantPort,
    source: label,
    recreate: FLAG_RECREATE,
  });
  console.log(`✅ upsert: ${JSON.stringify(up)} (${Date.now() - tQ}ms)`);

  const info = await getCollectionInfo(collection, { port: qdrantPort }).catch(() => null);
  console.log(`   points_count: ${info?.result?.points_count ?? "?"}`);

  // 5) uji retrieval: query mirip paragraf embedding
  const query = QUERY;
  console.log(`\n🔎 search: "${query}"`);
  const qvec = await embedQuery(query, { port });
  const hits = await searchSimilar(qvec, { collection, limit: SEARCH_LIMIT, port: qdrantPort });

  console.log(hits)

  hits.forEach((h, i) => {
    console.log(`   #${i + 1} score=${h.score.toFixed(4)} chunk_index=${h.chunk_index}`);
    console.log(`      ${(h.chunk || "").slice(0, 160).replace(/\s+/g, " ")}...`);
  });

  console.log(`\n🎉 SELESAI dalam ${((Date.now() - t0) / 1000).toFixed(1)}s — pipeline file->chunk->embed->qdrant OK.`);
  console.log("   (llama-server & qdrant dibiarkan hidup; Ctrl+C untuk keluar bila tidak dipakai.)");
  process.exit(0);
})().catch((err) => {
  console.error("\n❌ GAGAL:", err.message);
  if (/tidak ditemukan/i.test(err.message)) {
    console.error("\n💡 Kemungkinan biner belum diunduh. Jalankan:\n   node bin/pullbin.js\n   node bin/pullbin.js --only=llama,model,qdrant");
  }
  process.exit(1);
});
