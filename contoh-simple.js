/**
 * contoh-simple.js — versi ramping dari sample.js untuk pemula.
 *
 * Cara pakai:
 *   node contoh-simple.js
 *
 * Alur (sama seperti sample.js, tapi tanpa dialog/argumen CLI):
 *   1. Teks contoh -> 2. chunk -> 3. embedding -> 4. Qdrant -> 5. search
 *
 * Syarat: sudah pernah `node bin/pullbin.js` (biner llama + model + qdrant).
 */

import { splitTextIntoChunks } from "./helpers/chungking.js";
import { embedChunks, embedQuery } from "./helpers/embedding.js";
import { upsertChunks, searchSimilar } from "./helpers/vektordb.js";

// ---------------------------------------------------------------------------
// 1. Pengaturan — dibuat tetap biar mudah dibaca (di sample.js ini dari CLI)
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
// Kalau maunya adaptif, pakai pola ini(tetap dibatasi):
// target misal 100 chunk, tapi dijepit agar tetap muat di model
// let size = Math.floor(text.length / 100);
// size = Math.max(500, Math.min(1200, size));
// let overlap = Math.floor(size * 0.15);
// Jadi file kecil -> 500, file 1MB + -> mentok 1200, tidak pernah jadi 150rb.

const EMBED_PORT = 8081;
const EMBED_CTX = 4096; // memori max (token) per request
const EMBED_BATCH = 2048; // token dihitung sekaligus (kecepatan)
const EMBED_UBATCH = 2048; // potongan fisik agar muat di CPU/GPU
const EMBED_CONCURRENCY = 4; // jumlah request paralel

const COLLECTION = "pps_contoh";
const QUERIES = [
  "bagaimana cara embedding chunk?",
  "di mana vektor disimpan?",
  "apa itu markdown?",
];

// ---------------------------------------------------------------------------
// 2. Contoh teks — sekarang 3 dokumen (pengganti 3 file PDF/docx)
//    Tiap dokumen punya label agar ketahuan asalnya saat search.
// ---------------------------------------------------------------------------
const SAMPLE_TEXTS = [
  {
    label: "dok-markdown",
    text: `
# Dokumen Markdown

Konversi dokumen PDF dan DOCX menjadi markdown memakai markitdown.
Hasil markdown dibersihkan dari header berlebih lalu dipecah menjadi chunk kecil.
Chunk memakai ukuran 500 karakter dengan overlap 50 karakter.
`,
  },
  {
    label: "dok-embedding",
    text: `
# Dokumen Embedding

Embedding memakai model nomic-embed-text-v1.5 yang dijalankan lokal via llama.cpp.
Setiap chunk diubah menjadi vektor 768 dimensi dengan pooling mean.
Dokumen diberi prefix "search_document" dan query diberi prefix "search_query".
`,
  },
  {
    label: "dok-qdrant",
    text: `
# Dokumen Qdrant

Penyimpanan vektor memakai Qdrant lokal dengan jarak Cosine.
Koleksi dibuat sekali, lalu chunk di-upsert dengan id deterministik agar rerun tidak duplikat.
Kueri diubah jadi vektor lalu dicari dengan searchSimilar.
`,
  },
];

async function main() {
  console.log("════ Contoh simple: 3 teks -> chunk -> embed -> qdrant ════");

  // Langkah 1-3: ulang untuk tiap dokumen (chunk -> embed -> simpan)
  let totalChunk = 0;
  for (const doc of SAMPLE_TEXTS) {
    // 1. potong teks jadi chunk kecil
    const chunks = await splitTextIntoChunks(doc.text, CHUNK_SIZE, CHUNK_OVERLAP);
    console.log(`1. [${doc.label}] chunk: ${chunks.length} potong`);

    // 2. ubah tiap chunk jadi vektor (angka) via llama-server lokal
    const { vectors, dim, model } = await embedChunks(chunks, {
      port: EMBED_PORT,
      ctxSize: EMBED_CTX,
      batchSize: EMBED_BATCH,
      ubatch: EMBED_UBATCH,
      concurrency: EMBED_CONCURRENCY,
      keepServer: true,
    });
    console.log(`2. [${doc.label}] embedding: dim=${dim}, model=${model}`);

    // 3. simpan chunk + vektor ke Qdrant (source = label dokumen)
    await upsertChunks(chunks, vectors, {
      collection: COLLECTION,
      size: dim,
      source: doc.label,
    });
    totalChunk += chunks.length;
    console.log(`3. [${doc.label}] tersimpan di '${COLLECTION}'`);
  }
  console.log(`Total: ${totalChunk} chunk dari ${SAMPLE_TEXTS.length} dokumen.`);

  // Langkah 4: coba cari dengan beberapa pertanyaan
  for (const q of QUERIES) {
    console.log(`4. search: "${q}"`);
    const qvec = await embedQuery(q, { port: EMBED_PORT });
    const hits = await searchSimilar(qvec, { collection: COLLECTION, limit: 2 });

    hits.forEach((h, i) => {
      console.log(`   #${i + 1} score=${h.score.toFixed(4)}: ${h.chunk.slice(0, 80)}...`);
    });
  }

  console.log("🎉 SELESAI — pipeline jalan.");
}

main().catch((err) => {
  console.error("❌ GAGAL:", err.message);
  process.exit(1);
});
