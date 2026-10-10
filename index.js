import fs from "fs"
import { convertMarkdownToDocx } from "@mohtasham/md-to-docx"
import { handleFileOpen } from "./helpers/filemanager.js"
import { convertToMarkdown } from "./helpers/obsidian.js"
import { askAI } from "./helpers/omniroute.js"

(async () => {



        console.log("Silahkan pilih file untuk dianalisis ...")
        const filePath = await handleFileOpen()

        console.log("Convert file ke markdown ...")
        const context = await convertToMarkdown(filePath)

        console.log("Menunggu jawaban pertanyaan ...")
        const question = await askAI(
            `
    lengkapi template laporan berikut dengan jelas dan rinci
    ## I. PENDAHULUAN
    ### 1. Dasar Penugasan
    - Surat Perintah Pengamanan Pembangunan Strategis Kepala Kejaksaan Negeri Pidie
      Nomor : .........................................................

    ### 2. Sumber Informasi / Permohonan Pengamanan Pembangunan Strategis
    - Surat dari Dinas Pendidikan Pemerintah dan Kebudayaan Kabupaten Pidie Nomor : 420/2830/2026 tanggal 17 April 2026 perihal Permohonan Pengawalan dan Pengamanan Kegiatan Revitalisasi Satuan Pendidikan Berdampak Banjir Jenjang Sekolah Dasar dalam Kabupaten Pidie.
    - Dinas Pendidikan Pemerintah dan Kebudayaan Kabupaten Pidie


    ### 3. Identitas Kegiatan
    | URAIAN | KETERANGAN |
    | :--- | :--- |
    | Nama Pekerjaan | .................................................................. |
    | Sumber Dana | .................................................................. |
    | Pagu Anggaran | Rp ............................................................ |
    | Nomor Perjanjian PKS | .................................................................. |
    | Tanggal Mulai | .................................................................. |
    | Tanggal Berakhir | .................................................................. |
    | Sekolah | .................................................................. |
    | Penagungjawab P2SP | .................................................................. |
    | Bendahara P2SP | .................................................................. |
    | Perangkat Daerah | .................................................................. |
    | Kepala Pelaksana | .................................................................. |
    | Pengawas | .................................................................. |
    | Periode Pemantauan Ke- | .................................................................. |



    ## II. URAIAN PERMASALAHAN
    Adanya potensi Ancaman, Gangguan, Hambatan dan Tantangan (AGHT) yang dapat menghambat pelaksanaan kegiatan pembangunan strategis, meliputi:
    1. **Pengamanan Personil**: Terhadap upaya/tindakan dari dalam maupun luar instansi yang dapat mempengaruhi integritas, objektivitas, dan rasa aman personil dalam melaksanakan tugas sesuai ketentuan peraturan perundang-undangan.
    2. **Pengamanan Materil/Aset**: Terhadap upaya/tindakan dari dalam maupun luar instansi yang dapat menghambat atau menggagalkan proses pengadaan lahan dan pemanfaatan aset negara.
    3. **Pengamanan Perizinan**: Terhadap kendala akibat kekosongan, ketidakjelasan, tumpang tindih peraturan perundang-undangan, maupun praktik pungutan liar.

    ---

    ## III. SASARAN
    | No | UNSUR UTAMA KETERANGAN & INFORMASI LAIN | DATA AWAL OPERASI | INSTRUKSI / PERMINTAAN | KETERANGAN |
    | :-- | :--- | :--- | :--- | :--- |
    | 1 | Memastikan tidak adanya Ancaman, Gangguan, Hambatan dan Tantangan (AGHT) oleh pihak tertentu dalam pelaksanaan kegiatan pembangunan strategis daerah | Materi pemaparan perangkat daerah terkait | Melakukan koordinasi, penggalangan, dan sosialisasi pelaksanaan kegiatan | • Sifat: Rahasia<br>• Batas waktu pelaporan: Sampai selesai pekerjaan |
    | 2 | Memastikan kegiatan pembangunan strategis dapat terlaksana sesuai rencana, waktu, biaya, dan spesifikasi teknis | Rencana kerja dan dokumen kontrak yang berlaku | Melakukan pengamanan terhadap personil, material, dan perizinan kepada seluruh pihak terkait pelaksanaan pekerjaan | |
    | 3 | ......................................................................................... | ......................................................................................... | ......................................................................................... | ......................................................................................... |
    buat lebih umum untuk sasaran


    ## IV. PELAKSANAAN KEGIATAN
    1. Melakukan pengawalan dan pengamanan pembangunan strategis terhadap pekerjaan **[Nama Pekerjaan]** dengan sumber dana **[Sumber Dana]** Tahun Anggaran **[Tahun Anggaran]** atas permohonan pengamanan dari **[Instansi Pemohon]**.
    2. Melakukan rapat pendahuluan/entry meeting dengan seluruh pemangku kepentingan terkait.
    3. Melakukan penandatanganan pakta integritas.
    4. Melakukan kunjungan lapangan/site visit pada tanggal **[Tanggal Kunjungan]**, dengan hasil sebagai berikut:
       - **Rincian Lingkup Pekerjaan**:
         .........................................................................................
         .........................................................................................
       - **Rekapitulasi Progres Pekerjaan Fisik**:

    | NO | URAIAN PEKERJAAN | BOBOT RENCANA (%) | REALISASI SEBELUMNYA (%) | REALISASI PERIODE INI (%) | REALISASI KUMULATIF (%) | DEVIASI (%) |
    | :-- | :--- | :---: | :---: | :---: | :---: | :---: |
    | 1 | ...| | | | | |
    | dsb. | ... | | | | | |
    | **JUMLAH** | | **100,00** | | | | |

       - **Analisis Capaian**:
         Capaian progres kumulatif mencapai **[Nilai %]** dibandingkan rencana sebesar **[Nilai %]**, sehingga terdapat deviasi **[positif/negatif]** sebesar **[Nilai %]**. Hal ini menunjukkan kinerja pelaksanaan **[lebih cepat/tepat waktu/tertinggal]** dari target yang ditetapkan.
       - **Kegiatan Kunjungan**:
         Seluruh rangkaian kegiatan pemantauan dan kunjungan lapangan berjalan aman, tertib, dan lancar tanpa gangguan yang berarti.



    ## V. KENDALA DAN HAMBATAN PELAKSANAAN
    [Jenis Kendala 1] merupakan kendala yang muncul akibat [uraikan penyebab secara rinci]. Adanya kondisi ini memberikan dampak berupa [uraikan dampak yang timbul terhadap pelaksanaan pekerjaan]. Sebagai langkah penanganan yang telah dilakukan adalah [uraikan tindakan yang sudah dijalankan untuk mengurangi atau mengatasi kendala tersebut].
    [Jenis Kendala dsb. ...] merupakan kendala yang muncul akibat [uraikan penyebab secara rinci]. Adanya kondisi ini memberikan dampak berupa [uraikan dampak yang timbul terhadap pelaksanaan pekerjaan]. Sebagai langkah penanganan yang telah dilakukan adalah [uraikan tindakan yang sudah dijalankan untuk mengurangi atau mengatasi kendala tersebut].



    ## VI. PENUTUP
    ### 1. Kesimpulan
    Berdasarkan hasil pemantauan, pelaksanaan pekerjaan **[Nama Pekerjaan]** berada pada kondisi **[terkendali/terhambat]** dengan progres kumulatif mencapai **[Nilai %]**. Terdapat kendala **[sebutkan kendala utama]** yang mempengaruhi kelancaran pelaksanaan, namun dapat diminimalisir dengan upaya mitigasi yang telah dilakukan. Sampai saat ini belum ditemukan indikasi pelanggaran hukum maupun penyimpangan yang merugikan keuangan negara.

    ### 2. Saran
    Mohon kepada Pimpinan agar:
    - Tetap melanjutkan pengamanan pembangunan strategis sampai pekerjaan selesai dan diserahterimakan;
    - Mengkoordinasikan penyelesaian kendala yang terjadi kepada instansi berwenang;
    - .........................................................................................
    `,
    //     const question = await askAI(
    //         `
    // berdasarkan CONTEXT, ubah dalam bentuk format json berikut : 
    // {
    //   "rencana": Number,
    //   "progress": Number,
    //   "deviasi": Number
    // }

    // RULES:
    // 1. tampilakn hasil harus berupa json
    // `,
            {
                context,
            }
        )

        console.log("Jawaban AI:\n", question)

    fs.writeFileSync("output.docx", Buffer.from(await (await convertMarkdownToDocx(question)).arrayBuffer()))

})()