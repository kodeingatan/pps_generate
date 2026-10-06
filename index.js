import { convertToMarkdown } from "./helpers/index.js";



(async () => {
    const res = await convertToMarkdown("E:/.shortcut-targets-by-id/1mFzKZFuDi2btH81TVZ2TJRxc-gRTkl81/AFDAL/2026/REVIATALISASI/DINAS DISDIKBUD TAHAP II/KUNJUNGAN/SP.PPS-05 SD Negeri 2 Tijue/OKTOBER/PROGRES MINGGU KE - 11  SDN 2 TIJUE.pdf")
    console.log(res)
})()