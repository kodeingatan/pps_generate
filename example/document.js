import fs from "fs";
import path from "path";
import { patchMarkdownInDocxToBuffer } from "@mohtasham/md-to-docx";


export async function replaceDocxFile(fileDocxPath, docRender = {}) {
    // Load the docx file as binary content
    console.log("Load the docx file as binary content : ", fileDocxPath)
        const content = fs.readFileSync(fileDocxPath);
        const output = await patchMarkdownInDocxToBuffer(content, docRender, {
            placeholderDelimiters: { start: "{", end: "}" },
        });
        fs.writeFileSync(path.join(path.dirname(fileDocxPath), "output.docx"), output);

}