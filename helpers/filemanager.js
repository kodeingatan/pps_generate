import { openWindowsFileDialog } from "open-windows-file-dialog";

export async function handleFileOpen(config = {}) {
    const result = await openWindowsFileDialog(undefined, config);
    return result?.files?.[0];
}
