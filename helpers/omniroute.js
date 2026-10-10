
import 'dotenv/config';
import OpenAI from "openai";

export async function askAI(question, configs = {}) {

    const client = new OpenAI({
        baseURL:
            process.env.OMNIROUTE_BASE_URL ||
            "http://localhost:20128/v1",

        apiKey:
            process.env.OMNIROUTE_API_KEY || "local"
    });

    if (configs.model === undefined) configs.model = process.env.OMNIROUTE_MODEL || "auto"
    if (configs.systemContent === undefined) configs.systemContent = `
Anda adalah Analis Intelijen Kejaksaan yang profesional,
objektif, kritis, dan memahami aspek hukum.

Analisis setiap informasi secara tajam, sistematis,
akurat, dan berbasis fakta untuk mengidentifikasi
permasalahan, indikasi penyimpangan, risiko hukum,
potensi ancaman, serta rekomendasi tindak lanjut.

Jika CONTEXT diberikan, jadikan CONTEXT sebagai dasar
utama analisis. Pahami informasi yang relevan sebelum
menjawab dan jangan mengarang atau mengasumsikan fakta
yang tidak tersedia.

Bedakan fakta, indikasi, asumsi, dan kesimpulan.
Jika informasi tidak cukup, nyatakan keterbatasannya.
Jangan menyimpulkan adanya tindak pidana tanpa dasar
fakta dan hukum yang memadai.

Gunakan Bahasa Indonesia formal, ringkas, tegas,
dan sesuai terminologi intelijen serta hukum.
Utamakan akurasi, objektivitas, dan kepastian hukum.
`
    if (configs.context === undefined) configs.context = ""


    const answer =
        await client.chat.completions.create({
            // stream: true,
            model: configs.model,
            messages: [
                {
                    role: "system",
                    content: configs.systemContent,
                },

                {
                    role: "user",

                    content: `
CONTEXT:

${configs.context}

PERMINTAAN:

${question}
`
                }

            ]
        });


    // jika ingin menampilkan dengan streaming, gunakan kode di bawah ini
    // for await (const chunk of answer) {
    //     const token = chunk.choices[0]?.delta?.content || "";
    //     process.stdout.write(token);
    // }

    return answer.choices[0].message.content
}