import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve absolute path to the venv binary (independent of process.cwd()).
// Windows: .venv/Scripts/markitdown.exe, POSIX: .venv/bin/markitdown
const MARKITDOWN_BIN = path.resolve(
    __dirname,
    process.platform === "win32"
        ? "../bin/markitdown/.venv/Scripts/markitdown.exe"
        : "../bin/markitdown/.venv/bin/markitdown"
);

export async function convertToMarkdown(filePath) {

    const { stdout } = await execFileAsync(
        MARKITDOWN_BIN,
        [filePath],
        {
            maxBuffer: 20 * 1024 * 1024
        }
    );

    return stdout;
}