#!/usr/bin/env node

import { simpleGit } from "simple-git";
import path from "path";
import { execSync } from "child_process"; // Tambahkan ini untuk menjalankan command terminal
import { fileURLToPath } from "url";

// Mengambil URL repository dari argumen terminal (argumen ketiga)
const repoUrl = "https://github.com/microsoft/markitdown.git";

if (!repoUrl) {
  console.error("❌ Error: Mohon masukkan URL repository GitHub!");
  console.log("Contoh penggunaan: clone-bot https://github.com");
  process.exit(1);
}

// Mengambil nama repo untuk dijadikan nama folder tujuan
const repoName = repoUrl.split("/").pop().replace(".git", "");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetPath = path.join(__dirname, repoName);

const git = simpleGit();

console.log(`🚀 Memulai clone dari: ${repoUrl}`);
console.log(`📁 Target folder: ${targetPath}\n...`);

git
  .clone(repoUrl, targetPath)
  .then(() => {
    console.log("✅ Selesai! Repository berhasil di-clone.");

    // Pindah ke direktori folder yang baru di-clone (Menjawab poin 1: cd markitdown/nama-repo)
    console.log("📂 Berpindah direktori ke folder repository...");

    try {
      // Menjawab poin 2: Membuat Python Virtual Environment (.venv)
      console.log("🐍 Membuat Python virtual environment (.venv)...");
      execSync("python -m venv .venv", { cwd: targetPath, stdio: "inherit" });

      // Menjawab poin 3: Menginstal markitdown[all] menggunakan pip di dalam .venv (Windows syntax)
      console.log("📦 Menginstal markitdown[all] ke dalam .venv...");
      const pipPath = path.join(".venv", "Scripts", "python");
      execSync(`"${pipPath}" -m pip install "markitdown[all]"`, {
        cwd: targetPath,
        stdio: "inherit",
      });

      console.log("🎉 Semua proses berhasil diselesaikan dengan sukses!");
    } catch (error) {
      console.error(
        "❌ Terjadi kesalahan saat menjalankan perintah Python:",
        error.message,
      );
    }
  })
  .catch((err) => {
    console.error("❌ Gagal melakukan clone:", err.message);
  });
