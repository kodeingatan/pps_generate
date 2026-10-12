import fs from "fs";
import path from "path";
import { handleFolderOpen } from "../helpers/filemanager.js";
import { v4 as uuidv4 } from "uuid"
import { replaceDocxFile } from "./document.js";

const sessionId = uuidv4();

(async () => {
    const folderPath = await handleFolderOpen()
    const dirs = fs.readdirSync(folderPath)

    const laporanKunjunganPath = path.join(folderPath, "TEMPLATE LAPORAN KUNJUNGAN.docx")
    // {PELAKSANAAN KEGIATAN}
    // {KENDALA DAN HAMBATAN PELAKSANAAN}
    // {KESIMPULAN}
    // {SARAN}

    await replaceDocxFile(laporanKunjunganPath, {
        "PELAKSANAAN KEGIATAN": `### Pelaksanaan Kegiatan

1. Melakukan kunjungan lapangan.
2. **Progres pekerjaan** mencapai 75%.

 - Kendala: cuaca hujan.
 - Tindak lanjut: penyesuaian jadwal.`,
        "KENDALA DAN HAMBATAN PELAKSANAAN": "test",
        "KESIMPULAN": "test",
        "SARAN": "test"
    })

    console.log("Selected folder:", folderPath);
    console.log("Subdirectories:", dirs);
})()