import {
    RecursiveCharacterTextSplitter
} from "@langchain/textsplitters";
import matter from "gray-matter";

export async function splitTextIntoChunks(text, chunkSize = 1200, chunkOverlap = 200) {
    const splitter =
        new RecursiveCharacterTextSplitter({
            chunkSize,
            chunkOverlap
        });

    const parsed = matter(text);

    const chunks =
        await splitter.splitText(parsed.content);

    return chunks;
}
