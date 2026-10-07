import matter from "gray-matter";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve absolute path to the venv binary (independent of process.cwd()).
// Windows: .venv/Scripts/markitdown.exe, POSIX: .venv/bin/markitdown
const MARKITDOWN_BIN = path.resolve(
  __dirname,
  process.platform === "win32"
    ? "../bin/markitdown/.venv/Scripts/markitdown.exe"
    : "../bin/markitdown/.venv/bin/markitdown",
);

export async function convertWithMarkItDown(filePath) {
  const textmd = await new Promise((resolve, reject) => {
    const process = spawn(MARKITDOWN_BIN, [filePath]);

    let markdown = "";
    let error = "";

    process.stdout.on("data", (data) => {
      markdown += data.toString();
    });

    process.stderr.on("data", (data) => {
      error += data.toString();
    });

    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(error));
        return;
      }

      resolve(markdown);
    });
  });

  return textmd;
}

export async function convertToMarkdownSave(filePath, outputFilePath = null) {
  const text = await convertWithMarkItDown(filePath);

  if (outputFilePath == null)
    outputFilePath = filePath.replace(/\.[^/.]+$/, ".md");

  const finalContent = matter.stringify(text, {
    title: path.basename(filePath, path.extname(filePath)),
    source_file: filePath,
    date_created: new Date().toISOString(),
  });

  fs.writeFileSync(outputFilePath, finalContent, "utf8");

  return outputFilePath;
}

export async function convertToMarkdown(filePath) {
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync(MARKITDOWN_BIN, [filePath], {
    maxBuffer: 20 * 1024 * 1024,
  });

  return stdout;
}
