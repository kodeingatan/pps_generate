import fs from "fs";
// Load our library that generates the document
import Docxtemplater from 'docxtemplater'
// Load PizZip library to load the docx/pptx/xlsx file in memory
import PizZip from 'pizzip'
import path from "path";


export function replaceDocxFile(fileDocxPath, docRender = {}) {
    // Load the docx file as binary content
    console.log("Load the docx file as binary content : ", fileDocxPath)
    const content = fs.readFileSync(
        fileDocxPath,
        "binary"
    );

    // Unzip the content of the file
    console.log("Unzipping the docx file : ", fileDocxPath)
    const zip = new PizZip(content);

    /*
     * Parse the template.
     * This function throws an error if the template is invalid,
     * for example, if the template is "Hello {user" (missing closing tag)
     */
    console.log("Parsing the template : ", fileDocxPath)
    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
    });

    /*
     * Render the document : Replaces :
     * - {first_name} with John
     * - {last_name} with Doe,
     * ...
     */
    console.log("Rendering the document : ", fileDocxPath)
    doc.render(docRender);

    /*
     * Get the output document and export it as a Node.js buffer
     * This method is available since docxtemplater@3.62.0
     */
    const buf = doc.toBuffer();

    // Write the Buffer to a file
    // const outputFilePath = fileDocxPath.replace('.docx', '_output.docx');
    fs.writeFileSync(path.dirname(fileDocxPath) + '/output.docx', buf);
    /*
     * Instead of writing it to a file, you could also
     * let the user download it, store it in a database,
     * on AWS S3, ...
     */
}