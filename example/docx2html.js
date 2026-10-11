import { execFileSync } from "child_process";
import fs from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { handleFileOpen } from "../helpers/filemanager.js";

function toPowerShellLiteral(value) {
    const encoded = Buffer.from(value, "utf8").toString("base64");
    return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

function exportWithWord(inputPath, outputPath) {
    const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$sourcePath = ${toPowerShellLiteral(inputPath)}
$targetPath = ${toPowerShellLiteral(outputPath)}
$word = $null
$document = $null

try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($sourcePath, $false, $true, $false)
    $document.SaveAs2($targetPath, 17)
    Write-Output "Rendered PDF with Microsoft Word."
}
finally {
    if ($document -ne $null) {
        $document.Close(0)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document)
    }
    if ($word -ne $null) {
        $saveChanges = 0
        $originalFormat = 0
        $routeDocument = $false
        $word.Quit([ref]$saveChanges, [ref]$originalFormat, [ref]$routeDocument)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    }
}
`;
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");

    return execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedScript
    ], {
        encoding: "utf8",
        timeout: 180000
    });
}

(async () => {
    const selectedPath = process.argv[2] || await handleFileOpen();
    if (!selectedPath) {
        throw new Error("No file selected");
    }

    const inputPath = resolve(selectedPath);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`DOCX file not found: ${inputPath}`);
    }

    const outputPath = resolve("output.html");
    const temporaryDirectory = fs.mkdtempSync(join(tmpdir(), "docx2html-"));
    console.log("Path file: ", inputPath);
    console.log("Render dokumen dengan Microsoft Word ...");

    try {
        const pdfPath = join(temporaryDirectory, "document.pdf");
        const message = exportWithWord(inputPath, pdfPath);
        if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
            throw new Error("Microsoft Word did not create the PDF.");
        }

        const pdfBase64 = fs.readFileSync(pdfPath).toString("base64");
        const title = basename(inputPath).replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[character]);
        const html = `<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
        html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
        iframe { display: block; }
    </style>
</head>
<body>
    <iframe title="${title}" src="data:application/pdf;base64,${pdfBase64}#view=FitH"></iframe>
</body>
</html>`;

        fs.writeFileSync(outputPath, html, "utf8");
        console.log(message.trim());
        console.log("HTML tersimpan di: ", outputPath);
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
})().catch(error => {
    const details = error.stderr?.toString().trim() || error.message;
    console.error("Gagal mengonversi dokumen:", details);
    process.exitCode = 1;
});
