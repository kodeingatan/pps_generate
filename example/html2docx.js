import fs from "fs";
import { basename, extname, join, resolve } from "path";
import { createCanvas } from "@napi-rs/canvas";
import { AlignmentType, Document, ImageRun, Packer, Paragraph } from "docx";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { handleFileOpen } from "../helpers/filemanager.js";

const RENDER_SCALE = 2;
const TWIPS_PER_POINT = 20;
const PIXELS_PER_POINT = 4 / 3;

function extractEmbeddedPdf(html) {
    const match = html.match(/data:application\/pdf;base64,([A-Za-z0-9+/=\r\n]+)/i);
    if (!match) {
        throw new Error("This HTML does not contain the embedded PDF produced by docx2html.js.");
    }

    const pdf = Buffer.from(match[1].replace(/\s/g, ""), "base64");
    if (pdf.length < 5 || pdf.toString("ascii", 0, 5) !== "%PDF-") {
        throw new Error("The embedded data is not a valid PDF.");
    }
    return pdf;
}

async function createImageOnlyDocx(pdfData, outputPath) {
    const loadingTask = getDocument({
        data: new Uint8Array(pdfData),
        isEvalSupported: false,
        useWorkerFetch: false
    });
    const pdf = await loadingTask.promise;
    const sections = [];

    try {
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: RENDER_SCALE });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const context = canvas.getContext("2d");

            await page.render({
                canvas,
                canvasContext: context,
                viewport
            }).promise;

            const image = canvas.toBuffer("image/png");
            const pageWidth = Math.round(viewport.width / RENDER_SCALE);
            const pageHeight = Math.round(viewport.height / RENDER_SCALE);

            sections.push({
                properties: {
                    page: {
                        margin: { top: 0, right: 0, bottom: 0, left: 0 },
                        size: {
                            width: Math.round(pageWidth * TWIPS_PER_POINT),
                            height: Math.round(pageHeight * TWIPS_PER_POINT)
                        }
                    }
                },
                children: [
                    new Paragraph({
                        alignment: AlignmentType.CENTER,
                        spacing: { before: 0, after: 0 },
                        children: [
                            new ImageRun({
                                data: image,
                                type: "png",
                                transformation: {
                                    width: pageWidth * PIXELS_PER_POINT,
                                    height: pageHeight * PIXELS_PER_POINT
                                }
                            })
                        ]
                    })
                ]
            });

            console.log(`Rendered page ${pageNumber}/${pdf.numPages}`);
            page.cleanup();
        }
    } finally {
        await loadingTask.destroy();
    }

    const document = new Document({ sections });
    fs.writeFileSync(outputPath, await Packer.toBuffer(document));
}

(async () => {
    const selectedPath = process.argv[2] || await handleFileOpen();
    if (!selectedPath) {
        throw new Error("No HTML file selected");
    }

    const inputPath = resolve(selectedPath);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`HTML file not found: ${inputPath}`);
    }

    const outputPath = resolve(process.argv[3] || join(
        process.cwd(),
        `converted-${basename(inputPath, extname(inputPath))}.docx`
    ));
    if (fs.existsSync(outputPath)) {
        throw new Error(`Output file already exists; choose another output path: ${outputPath}`);
    }

    const pdf = extractEmbeddedPdf(fs.readFileSync(inputPath, "utf8"));
    console.log("HTML input: ", inputPath);
    console.log("Convert PDF pages to DOCX page images ...");

    await createImageOnlyDocx(pdf, outputPath);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new Error("Failed to create the DOCX output.");
    }

    console.log("DOCX tersimpan di: ", outputPath);
    console.log("Catatan: setiap halaman dipertahankan sebagai gambar agar tata letak tetap sama.");
})().catch(error => {
    console.error("Gagal mengonversi HTML ke DOCX:", error.message);
    process.exitCode = 1;
});
