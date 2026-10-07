#!/usr/bin/env node

/**
 * pullbin.js — provisioning biner lokal untuk PPS.
 *
 * Melakukan:
 *  1. (existing) clone microsoft/markitdown + venv + pip install markitdown[all]
 *  2. download llama.cpp ke bin/llama/build  (otomatis pilih CPU / CUDA / Vulkan
 *     berdasarkan OS + hardware lokal tempat project dijalankan)
 *  3. download model embedding GGUF ke bin/llama/embedding/
 *     (default: nomic-embed-text-v1.5, kuant auto by RAM)
 *  4. download qdrant ke bin/llama/qdrant/ (otomatis pilih OS/arch)
 *
 * Layout hasil:
 *   bin/llama/build/            <- hasil ekstrak llama.cpp (llama-server(.exe), ...)
 *   bin/llama/embedding/*.gguf
 *   bin/llama/qdrant/qdrant(.exe)
 *   bin/llama/meta.json         <- ringkasan deteksi + URL yang dipakai
 *
 * Contoh:
 *   node bin/pullbin.js                              # semua (auto backend)
 *   node bin/pullbin.js --only=llama,model,qdrant
 *   node bin/pullbin.js --backend=cpu                # paksa CPU
 *   node bin/pullbin.js --backend=vulkan              # paksa Vulkan (Win x64)
 *   node bin/pullbin.js --backend=cuda12              # paksa CUDA 12.4 (Win x64)
 *   node bin/pullbin.js --quant=Q4_0 --force
 */

import { simpleGit } from "simple-git";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const LLAMA_DIR = path.join(__dirname, "llama");
const LLAMA_BUILD_DIR = path.join(LLAMA_DIR, "build");
const LLAMA_EMBED_DIR = path.join(LLAMA_DIR, "embedding");
const LLAMA_QDRANT_DIR = path.join(LLAMA_DIR, "qdrant");
const META_PATH = path.join(LLAMA_DIR, "meta.json");

const DEFAULT_LLAMA_TAG = "b11429"; // nightly milik llama.cpp v0.6.0 (punya semua asset win/linux/macos)
const DEFAULT_QDRANT_VERSION = "v1.19.2";
const EMBED_REPO = "nomic-ai/nomic-embed-text-v1.5-GGUF";
const EMBED_DIM = 768;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    only: null, // e.g. "llama,model,qdrant,markitdown"
    backend: "auto", // auto|cpu|cuda12|cuda|cuda13|vulkan
    quant: "auto", // auto|Q8_0|Q4_0|Q4_K_M|...
    llamaTag: DEFAULT_LLAMA_TAG,
    qdrantVersion: DEFAULT_QDRANT_VERSION,
    force: false,
    skipMarkitdown: false,
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--only=")) args.only = a.slice(7).split(",").map((s) => s.trim().toLowerCase());
    else if (a.startsWith("--backend=")) args.backend = a.slice(10).toLowerCase();
    else if (a.startsWith("--quant=")) args.quant = a.slice(8).toUpperCase();
    else if (a.startsWith("--llama-tag=")) args.llamaTag = a.slice(12);
    else if (a.startsWith("--qdrant-version=")) args.qdrantVersion = a.slice(18);
    else if (a === "--force") args.force = true;
    else if (a === "--skip-markitdown") args.skipMarkitdown = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node bin/pullbin.js [options]
  --only=llama,model,qdrant,markitdown
  --backend=auto|cpu|cuda12|cuda13|vulkan   (cuda == cuda12)
  --quant=auto|Q8_0|Q4_0|Q4_K_M|Q5_K_M|...  (default auto by RAM)
  --llama-tag=<tag>                        (default ${DEFAULT_LLAMA_TAG})
  --qdrant-version=<tag>                   (default ${DEFAULT_QDRANT_VERSION})
  --force                                  (download ulang walau sudah ada)
  --skip-markitdown                        (lewati langkah markitdown)`);
      process.exit(0);
    }
  }
  if (args.backend === "cuda") args.backend = "cuda12";
  return args;
}

// ---------------------------------------------------------------------------
// Deteksi platform & hardware
// ---------------------------------------------------------------------------
function detectPlatform() {
  const platform = process.platform; // win32 | linux | darwin
  const arch = process.arch; // x64 | arm64
  let llamaOS = null;
  if (platform === "win32") llamaOS = "win";
  else if (platform === "linux") llamaOS = "ubuntu";
  else if (platform === "darwin") llamaOS = "macos";
  const llamaArch = arch === "arm64" ? "arm64" : "x64";
  return { platform, arch, llamaOS, llamaArch };
}

function runQuiet(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", ...opts }).trim();
  } catch {
    return "";
  }
}

/** Deteksi GPU NVIDIA via nvidia-smi + kapabilitas Vulkan via vulkaninfo. */
function detectAccelerator() {
  const info = {
    hasNvidia: false,
    gpuName: null,
    vramMB: 0,
    cudaVersion: null,
    computeCap: null,
    hasVulkan: false,
    vulkanGPUs: [],
    recommendation: "cpu",
    reason: "",
  };

  // --- NVIDIA ---
  const smi = runQuiet("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader");
  if (smi) {
    // contoh: "NVIDIA GeForce 920MX, 2048 MiB"
    const first = smi.split("\n")[0].trim();
    const m = first.match(/^(.*),\s*([\d.]+)\s*MiB/i);
    if (m) {
      info.hasNvidia = true;
      info.gpuName = m[1].trim();
      info.vramMB = Math.round(parseFloat(m[2]));
    } else {
      info.hasNvidia = true;
      info.gpuName = first;
    }
    const full = runQuiet("nvidia-smi");
    const cm = full.match(/CUDA Version:\s*([\d.]+)/i);
    if (cm) info.cudaVersion = cm[1];
  }

  // Estimasi compute capability dari nama (cukup untuk heuristik Maxwell vs Pascal+)
  if (info.gpuName) {
    const n = info.gpuName.toUpperCase();
    // Maxwell: 920MX/940MX, GTX 9xx, GT 9xx
    if (/920MX|940MX|GTX 9\d0|GT 9\d0|GM108|GM107/.test(n.replace(/\s/g, ""))) info.computeCap = "5.0";
    else if (/GTX 10\d0|GTX 1[0-9]{3}|TITAN X/.test(n.replace(/\s/g, ""))) info.computeCap = "6.1";
    else if (/RTX 20\d0|GTX 16\d0/.test(n.replace(/\s/g, ""))) info.computeCap = "7.5";
    else if (/RTX 30\d0/.test(n.replace(/\s/g, ""))) info.computeCap = "8.6";
    else if (/RTX 40\d0/.test(n.replace(/\s/g, ""))) info.computeCap = "8.9";
  }

  // --- Vulkan ---
  const vulkanSummary = runQuiet("vulkaninfo --summary", { timeout: 15000 });
  if (vulkanSummary && /deviceName|GPU\d?:/i.test(vulkanSummary)) {
    info.hasVulkan = true;
    const names = [...vulkanSummary.matchAll(/deviceName\s*=\s*(.+)/gi)].map((m) => m[1].trim());
    if (names.length) info.vulkanGPUs = names;
    else info.vulkanGPUs = ["(vulkan device terdeteksi)"];
  } else {
    // fallback: di Windows, keberadaan 2 adapter display (Intel+NVIDIA) hampir pasti Vulkan-capable
    if (process.platform === "win32" && (info.hasNvidia || runQuiet("wmic path win32_VideoController get Name /format:list"))) {
      // tandai vulkan tersedia bila driver modern; vulkaninfo mungkin tidak terinstal
      info.hasVulkan = info.hasVulkan || false;
    }
  }

  // --- Rekomendasi ---
  const cc = parseFloat(info.computeCap || "0");
  if (info.hasNvidia && info.vramMB >= 4096 && cc >= 6.0) {
    info.recommendation = "cuda12";
    info.reason =
      `${info.gpuName} (${info.vramMB} MiB, CC ${info.computeCap}, CUDA ${info.cudaVersion || "?"}) ` +
      `layak untuk build CUDA.`;
  } else if (info.hasNvidia && info.vramMB > 0 && (info.vramMB < 4096 || cc < 6.0)) {
    info.recommendation = "cpu";
    info.reason =
      `${info.gpuName || "GPU NVIDIA"} hanya ${info.vramMB || "?"} MiB VRAM` +
      `${info.computeCap ? ` (CC ${info.computeCap}, arsitektur lawas)` : ""} — ` +
      `build CUDA tidak disarankan (rentan OOM / toolkit tidak lagi mendukung Maxwell di CUDA 13). ` +
      `Dipilih build CPU-AVX2 yang paling stabil; Vulkan tetap tersedia sebagai opsi manual (--backend=vulkan).`;
  } else if (!info.hasNvidia && info.hasVulkan) {
    info.recommendation = "cpu";
    info.reason = "Tidak ada GPU NVIDIA; Vulkan tersedia tapi CPU dipilih sebagai default stabil untuk embedding.";
  } else if (!info.hasNvidia) {
    info.recommendation = "cpu";
    info.reason = "Tidak ada GPU NVIDIA yang terdeteksi — build CPU.";
  }
  return info;
}

// ---------------------------------------------------------------------------
// Pemilihan asset
// ---------------------------------------------------------------------------
function selectLlamaAsset(backend, { llamaOS, llamaArch }, tag) {
  const dl = (name) => `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${name}`;
  const b = backend.toLowerCase();

  if (llamaOS === "win" && llamaArch === "x64") {
    if (b === "cuda12") {
      return {
        backend: "cuda12",
        files: [
          `llama-${tag}-bin-win-cuda-12.4-x64.zip`,
          `cudart-llama-bin-win-cuda-12.4-x64.zip`, // runtime DLL CUDA (wajib untuk build cuda)
        ].map((n) => ({ name: n, url: dl(n) })),
        gpuLayersNote: "gunakan -ngl 99 (full offload bila VRAM cukup)",
      };
    }
    if (b === "cuda13") {
      return {
        backend: "cuda13",
        files: [
          `llama-${tag}-bin-win-cuda-13.4-x64.zip`,
          `cudart-llama-bin-win-cuda-13.4-x64.zip`,
        ].map((n) => ({ name: n, url: dl(n) })),
        gpuLayersNote: "CUDA 13 tidak mendukung Maxwell/Pascal lama — hanya untuk RTX modern",
      };
    }
    if (b === "vulkan") {
      return {
        backend: "vulkan",
        files: [{ name: `llama-${tag}-bin-win-vulkan-x64.zip`, url: dl(`llama-${tag}-bin-win-vulkan-x64.zip`) }],
        gpuLayersNote: "gunakan -ngl 99; berjalan di NVIDIA/Intel/AMD via Vulkan",
      };
    }
    return {
      backend: "cpu",
      files: [{ name: `llama-${tag}-bin-win-cpu-x64.zip`, url: dl(`llama-${tag}-bin-win-cpu-x64.zip`) }],
      gpuLayersNote: "gunakan -ngl 0 (murni CPU-AVX2)",
    };
  }
  if (llamaOS === "ubuntu" && llamaArch === "x64") {
    if (b === "cuda12") {
      return {
        backend: "cuda12",
        files: [
          `llama-${tag}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
          `cudart-llama-${tag}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
        ].map((n) => ({ name: n, url: dl(n) })),
      };
    }
    if (b === "vulkan") {
      return {
        backend: "vulkan",
        files: [{ name: `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`, url: dl(`llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`) }],
      };
    }
    return {
      backend: "cpu",
      files: [{ name: `llama-${tag}-bin-ubuntu-x64.tar.gz`, url: dl(`llama-${tag}-bin-ubuntu-x64.tar.gz`) }],
    };
  }
  if (llamaOS === "ubuntu" && llamaArch === "arm64") {
    if (b === "vulkan") {
      return {
        backend: "vulkan",
        files: [{ name: `llama-${tag}-bin-ubuntu-vulkan-arm64.tar.gz`, url: dl(`llama-${tag}-bin-ubuntu-vulkan-arm64.tar.gz`) }],
      };
    }
    return {
      backend: "cpu",
      files: [{ name: `llama-${tag}-bin-ubuntu-arm64.tar.gz`, url: dl(`llama-${tag}-bin-ubuntu-arm64.tar.gz`) }],
    };
  }
  if (llamaOS === "macos") {
    return {
      backend: "cpu", // Metal sudah termasuk di build macos
      files: [
        {
          name: `llama-${tag}-bin-macos-${llamaArch}.tar.gz`,
          url: dl(`llama-${tag}-bin-macos-${llamaArch}.tar.gz`),
        },
      ],
    };
  }
  throw new Error(`Kombinasi OS/arch tidak didukung: ${llamaOS}-${llamaArch}`);
}

function selectEmbeddingQuant(quantArg) {
  const q = String(quantArg || "auto").toUpperCase();
  if (q && q !== "AUTO") return q;
  const totalGB = os.totalmem() / 1024 ** 3;
  // nomic-embed-text-v1.5: Q8_0 ~270MB (paling akurat), Q4_0 ~130MB (hemat).
  if (totalGB >= 8) return "Q8_0";
  if (totalGB >= 4) return "Q4_K_M";
  return "Q4_0";
}

function embeddingFileFor(quant) {
  return {
    name: `nomic-embed-text-v1.5.${quant}.gguf`,
    url: `https://huggingface.co/${EMBED_REPO}/resolve/main/nomic-embed-text-v1.5.${quant}.gguf?download=true`,
    dim: EMBED_DIM,
  };
}

function selectQdrantAsset(version, { platform, arch }) {
  const dl = (name) => `https://github.com/qdrant/qdrant/releases/download/${version}/${name}`;
  if (platform === "win32" && arch === "x64") {
    return { name: "qdrant-x86_64-pc-windows-msvc.zip", url: dl("qdrant-x86_64-pc-windows-msvc.zip"), bin: "qdrant.exe" };
  }
  if (platform === "linux" && arch === "x64") {
    return { name: "qdrant-x86_64-unknown-linux-gnu.tar.gz", url: dl("qdrant-x86_64-unknown-linux-gnu.tar.gz"), bin: "qdrant" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { name: "qdrant-aarch64-unknown-linux-musl.tar.gz", url: dl("qdrant-aarch64-unknown-linux-musl.tar.gz"), bin: "qdrant" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { name: "qdrant-aarch64-apple-darwin.tar.gz", url: dl("qdrant-aarch64-apple-darwin.tar.gz"), bin: "qdrant" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { name: "qdrant-x86_64-apple-darwin.tar.gz", url: dl("qdrant-x86_64-apple-darwin.tar.gz"), bin: "qdrant" };
  }
  throw new Error(`Qdrant tidak punya build untuk ${platform}-${arch}`);
}

// ---------------------------------------------------------------------------
// Download & ekstrak
// ---------------------------------------------------------------------------
async function downloadFile(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  console.log(`⬇️  ${url}\n   -> ${destPath}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download gagal ${res.status} ${res.statusText}: ${url}`);
  const total = Number(res.headers.get("content-length") || 0);
  let done = 0;
  const lastLog = { t: 0 };
  // Bungkus agar ada progress ringan tanpa dependency tambahan
  const progressStream = new ReadableStream({
    async start(controller) {
      const reader = res.body.getReader();
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        done += value.length;
        controller.enqueue(value);
        const now = Date.now();
        if (total && now - lastLog.t > 1000) {
          lastLog.t = now;
          const pct = ((done / total) * 100).toFixed(1);
          process.stdout.write(`\r   ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB (${pct}%)`);
        }
      }
      if (total) process.stdout.write("\n");
      controller.close();
    },
  });
  const nodeStream = Readable.fromWeb(progressStream);
  const out = fs.createWriteStream(destPath);
  await finished(nodeStream.pipe(out));
  const st = fs.statSync(destPath);
  console.log(`   ✅ tersimpan (${(st.size / 1048576).toFixed(1)} MiB)`);
  return destPath;
}

function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  console.log(`📦 Ekstrak ${path.basename(archivePath)} -> ${destDir}`);
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force"`,
        { stdio: "inherit" },
      );
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: "inherit" });
    }
  } else if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: "inherit" });
  } else {
    throw new Error(`Format arsip tidak dikenal: ${archivePath}`);
  }
  console.log("   ✅ ekstrak selesai");
}

function findLlamaServer(buildDir) {
  const candidates = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^llama-server(\.exe)?$/i.test(e.name)) candidates.push(p);
    }
  };
  if (fs.existsSync(buildDir)) walk(buildDir);
  return candidates[0] || null;
}

// ---------------------------------------------------------------------------
// Langkah 1: markitdown (existing, dibuat idempoten)
// ---------------------------------------------------------------------------
async function pullMarkitdownRepository(force = false) {
  const repoUrl = "https://github.com/microsoft/markitdown.git";
  const repoName = repoUrl.split("/").pop().replace(".git", "");
  const targetPath = path.join(__dirname, repoName);

  if (fs.existsSync(path.join(targetPath, ".venv")) && !force) {
    console.log("⏭️  markitdown sudah ada (.venv ditemukan) — lewati. Gunakan --force untuk install ulang.");
    return targetPath;
  }

  const git = simpleGit();
  console.log(`🚀 Memulai clone dari: ${repoUrl}`);
  console.log(`📁 Target folder: ${targetPath}\n...`);

  if (!fs.existsSync(targetPath)) {
    await git.clone(repoUrl, targetPath);
    console.log("✅ Selesai! Repository berhasil di-clone.");
  } else {
    console.log("📁 Folder sudah ada, lanjut ke setup venv...");
  }

  console.log("📂 Berpindah direktori ke folder repository...");
  try {
    console.log("🐍 Membuat Python virtual environment (.venv)...");
    execSync("python -m venv .venv", { cwd: targetPath, stdio: "inherit" });

    console.log("📦 Menginstal markitdown[all] ke dalam .venv...");
    const pipPath =
      process.platform === "win32"
        ? path.join(".venv", "Scripts", "python")
        : path.join(".venv", "bin", "python");
    execSync(`"${pipPath}" -m pip install "markitdown[all]"`, {
      cwd: targetPath,
      stdio: "inherit",
    });

    console.log("🎉 markitdown berhasil disiapkan!");
  } catch (error) {
    console.error("❌ Terjadi kesalahan saat menjalankan perintah Python:", error.message);
    throw error;
  }
  return targetPath;
}

// ---------------------------------------------------------------------------
// Langkah 2: llama.cpp
// ---------------------------------------------------------------------------
async function pullLlamaCpp({ backend, llamaTag, force }) {
  const plat = detectPlatform();
  const accel = detectAccelerator();
  let chosen = backend;
  if (!chosen || chosen === "auto") chosen = accel.recommendation;

  console.log("\n🖥️  Deteksi hardware lokal:");
  console.log(`   OS/arch   : ${plat.platform}-${plat.arch} (llama: ${plat.llamaOS}-${plat.llamaArch})`);
  console.log(`   CPU       : ${os.cpus()[0]?.model || "?"} x${os.cpus().length} | RAM ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`);
  console.log(
    `   GPU       : ${accel.gpuName || "-"}${accel.vramMB ? ` (${accel.vramMB} MiB)` : ""}` +
      `${accel.cudaVersion ? ` | CUDA ${accel.cudaVersion}` : ""}${accel.computeCap ? ` | CC ${accel.computeCap}` : ""}`,
  );
  console.log(`   Vulkan    : ${accel.hasVulkan ? `ya (${accel.vulkanGPUs.join(", ")})` : "tidak terdeteksi"}`);
  console.log(`   Rekomendasi: ${accel.recommendation} — ${accel.reason}`);
  console.log(`   Pilihan    : ${chosen}${backend === "auto" ? " (auto)" : " (manual via --backend)"}`);

  const sel = selectLlamaAsset(chosen, plat, llamaTag);
  console.log(`\n🦙 llama.cpp backend='${sel.backend}' tag='${llamaTag}':`);
  for (const f of sel.files) console.log(`   - ${f.name}`);

  fs.mkdirSync(LLAMA_BUILD_DIR, { recursive: true });
  const tmpDir = path.join(LLAMA_DIR, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const existingServer = findLlamaServer(LLAMA_BUILD_DIR);
  if (existingServer && !force) {
    console.log(`⏭️  llama.cpp sudah ada (${existingServer}) — lewati. Gunakan --force untuk download ulang.`);
    return { ...sel, buildDir: LLAMA_BUILD_DIR, serverBin: existingServer, accel, skipped: true };
  }

  for (const f of sel.files) {
    const dest = path.join(tmpDir, f.name);
    if (!fs.existsSync(dest) || force) await downloadFile(f.url, dest);
    else console.log(`⏭️  arsip sudah ada: ${dest}`);
    extractArchive(dest, LLAMA_BUILD_DIR);
  }

  // cudart zip berisi subfolder; binary tetap ditemukan via walk. Pastikan executable di linux.
  if (process.platform !== "win32") {
    try {
      execSync(`chmod -R +x "${LLAMA_BUILD_DIR}"`, { stdio: "ignore" });
    } catch { /* abaikan */ }
  }

  const serverBin = findLlamaServer(LLAMA_BUILD_DIR);
  if (!serverBin) {
    console.warn("⚠️  llama-server tidak ditemukan setelah ekstrak. Isi build:");
    try {
      console.warn(execSync(`ls -R "${LLAMA_BUILD_DIR}"`, { encoding: "utf8", shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh" }));
    } catch { /* abaikan */ }
    throw new Error("llama-server tidak ditemukan di hasil ekstrak.");
  }
  console.log(`✅ llama.cpp siap: ${serverBin}`);
  return { ...sel, buildDir: LLAMA_BUILD_DIR, serverBin, accel, skipped: false };
}

// ---------------------------------------------------------------------------
// Langkah 3: model embedding
// ---------------------------------------------------------------------------
async function pullEmbeddingModel({ quant, force }) {
  const q = selectEmbeddingQuant(quant);
  const file = embeddingFileFor(q);
  const dest = path.join(LLAMA_EMBED_DIR, file.name);
  console.log(`\n🧠 Model embedding: nomic-embed-text-v1.5 [${q}] (dim ${file.dim})`);
  console.log(`   RAM lokal: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB -> kuant ${q}${String(quant).toUpperCase() === "AUTO" ? " (auto)" : ""}`);
  fs.mkdirSync(LLAMA_EMBED_DIR, { recursive: true });
  if (fs.existsSync(dest) && !force) {
    const st = fs.statSync(dest);
    if (st.size > 10 * 1024 * 1024) {
      console.log(`⏭️  model sudah ada: ${dest} (${(st.size / 1048576).toFixed(1)} MiB) — lewati.`);
      return { ...file, path: dest, skipped: true };
    }
    console.log("⚠️  file model tampak rusak (terlalu kecil), download ulang...");
  }
  await downloadFile(file.url, dest);
  return { ...file, path: dest, skipped: false };
}

// ---------------------------------------------------------------------------
// Langkah 4: qdrant
// ---------------------------------------------------------------------------
async function pullQdrant({ version, force }) {
  const plat = detectPlatform();
  const sel = selectQdrantAsset(version, plat);
  console.log(`\n🗄️  Qdrant ${version} untuk ${plat.platform}-${plat.arch}: ${sel.name}`);
  fs.mkdirSync(LLAMA_QDRANT_DIR, { recursive: true });
  const binPath = path.join(LLAMA_QDRANT_DIR, sel.bin);
  if (fs.existsSync(binPath) && !force) {
    console.log(`⏭️  qdrant sudah ada: ${binPath} — lewati.`);
    return { ...sel, path: binPath, dir: LLAMA_QDRANT_DIR, skipped: true };
  }
  const tmpDir = path.join(LLAMA_DIR, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const archive = path.join(tmpDir, sel.name);
  if (!fs.existsSync(archive) || force) await downloadFile(sel.url, archive);
  // Ekstrak ke folder temp lalu pindahkan binernya (zip qdrant berisi qdrant.exe di root)
  const extractTmp = path.join(tmpDir, "qdrant-extract");
  fs.rmSync(extractTmp, { recursive: true, force: true });
  extractArchive(archive, extractTmp);
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase() === sel.bin.toLowerCase()) found.push(p);
    }
  };
  walk(extractTmp);
  if (!found.length) throw new Error(`biner ${sel.bin} tidak ditemukan di arsip qdrant.`);
  fs.copyFileSync(found[0], binPath);
  if (process.platform !== "win32") execFileSync("chmod", ["+x", binPath]);
  fs.rmSync(extractTmp, { recursive: true, force: true });
  console.log(`✅ qdrant siap: ${binPath}`);
  try {
    const ver = execSync(`"${binPath}" --version`, { encoding: "utf8", timeout: 15000 }).trim();
    console.log(`   ${ver}`);
  } catch { /* abaikan */ }
  return { ...sel, path: binPath, dir: LLAMA_QDRANT_DIR, skipped: false };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv);
  console.log("════════ pullbin ════════");
  console.log(`root: ${PROJECT_ROOT}`);

  const only = args.only; // null = semua
  const want = (name) => !only || only.includes(name) || (name === "model" && only.includes("embedding"));

  const summary = { at: new Date().toISOString(), platform: detectPlatform(), args };

  try {
    if (want("markitdown") && !args.skipMarkitdown) {
      await pullMarkitdownRepository(args.force);
      summary.markitdown = "ok";
    } else {
      console.log("⏭️  lewati markitdown");
    }

    if (want("llama")) {
      const r = await pullLlamaCpp({ backend: args.backend, llamaTag: args.llamaTag, force: args.force });
      summary.llama = { backend: r.backend, tag: args.llamaTag, files: r.files.map((f) => f.name), serverBin: r.serverBin };
      summary.accelerator = r.accel;
    }

    if (want("model")) {
      const r = await pullEmbeddingModel({ quant: args.quant, force: args.force });
      summary.embedding = { file: r.name, dim: r.dim, path: r.path };
    }

    if (want("qdrant")) {
      const r = await pullQdrant({ version: args.qdrantVersion, force: args.force });
      summary.qdrant = { version: args.qdrantVersion, asset: r.name, path: r.path };
    }

    fs.mkdirSync(LLAMA_DIR, { recursive: true });
    let prev = {};
    try {
      prev = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    } catch { /* belum ada */ }
    fs.writeFileSync(META_PATH, JSON.stringify({ ...prev, ...summary }, null, 2));
    console.log(`\n📝 meta ditulis: ${META_PATH}`);
    console.log("\n🎉 Semua proses pullbin selesai!");
  } catch (err) {
    console.error("\n❌ pullbin gagal:", err.message);
    process.exit(1);
  }
})();
