import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const lastDirectoryFile = path.join(os.homedir(), ".pps-last-directory");
let lastOpenedDirectory = readLastDirectory();

function readLastDirectory() {
    try {
        const directory = fs.readFileSync(lastDirectoryFile, "utf8").trim();
        return directory && fs.statSync(directory).isDirectory() ? directory : undefined;
    } catch {
        return undefined;
    }
}

function rememberDirectory(directory) {
    if (!directory) return;
    lastOpenedDirectory = directory;
    try {
        fs.writeFileSync(lastDirectoryFile, directory, "utf8");
    } catch {
        // Keep the current process state even if persistent storage is unavailable.
    }
}

function getInitialDirectory(config) {
    return config.initialDirectory ?? lastOpenedDirectory ?? process.cwd();
}

function toPowerShellLiteral(value) {
    const encoded = Buffer.from(value, "utf8").toString("base64");
    return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

function buildFileFilter(filter = "*.*") {
    if (filter === "*" || filter === "*.*") return "All files (*.*)|*.*";
    if (filter.includes("|")) return filter;

    const extension = filter.replace("*", "").replace(".", "");
    return extension ? `${extension.toUpperCase()} files (${filter})|${filter}` : "All files (*.*)|*.*";
}

async function runPowerShellDialog(script) {
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedScript
    ], { windowsHide: true });

    return stdout;
}

export async function handleFileOpen(config = {}) {
    const pathSeparator = "|<<PATH_SEPARATOR>>|";
    const initialDirectory = getInitialDirectory(config);
    rememberDirectory(initialDirectory);
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = ${config.multiple === false ? "$false" : "$true"}
$dialog.InitialDirectory = ${toPowerShellLiteral(initialDirectory)}
$dialog.Filter = ${toPowerShellLiteral(buildFileFilter(config.filter ?? "*.*"))}
$dialog.CheckFileExists = ${config.checkFileExists === false ? "$false" : "$true"}
$dialog.CheckPathExists = $true
$dialog.SupportMultiDottedExtensions = $true
$dialog.Title = ${toPowerShellLiteral(config.title ?? "Select File(s)")}
$dialog.RestoreDirectory = $true
${config.defaultExtension ? `$dialog.DefaultExt = ${toPowerShellLiteral(config.defaultExtension)}` : ""}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    foreach ($fileName in $dialog.FileNames) {
        [Console]::Out.Write("$fileName${pathSeparator}")
    }
}
`;
    const stdout = await runPowerShellDialog(script);
    const selectedFile = stdout.split(pathSeparator).find((filePath) => filePath.trim())?.trim();
    if (selectedFile) rememberDirectory(path.dirname(selectedFile));
    return selectedFile;
}

export async function handleFolderOpen(config = {}) {
    const initialDirectory = getInitialDirectory(config);
    rememberDirectory(initialDirectory);
    const script = `
$source = @'
using System;
using System.Runtime.InteropServices;

namespace PpsFolderPicker {
    [Flags]
    enum FileDialogOptions : uint {
        NoChangeDirectory = 0x00000008,
        PickFolders = 0x00000020,
        ForceFileSystem = 0x00000040,
        PathMustExist = 0x00000800
    }

    enum DisplayNameType {
        FileSystemPath = unchecked((int)0x80058000)
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    class FileOpenDialog { }

    [ComImport]
    [Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr types);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(FileDialogOptions options);
        void GetOptions(out FileDialogOptions options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int location);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr bindingContext, ref Guid handler, ref Guid interfaceId, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(DisplayNameType nameType, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem item, uint hint, out int order);
    }

    public static class NativeFolderPicker {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(
            string path, IntPtr bindingContext, ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

        public static string SelectFolder(string title, string initialDirectory) {
            IFileDialog dialog = (IFileDialog)new FileOpenDialog();
            try {
                dialog.SetOptions(
                    FileDialogOptions.PickFolders |
                    FileDialogOptions.ForceFileSystem |
                    FileDialogOptions.PathMustExist |
                    FileDialogOptions.NoChangeDirectory);
                dialog.SetTitle(title);

                if (!String.IsNullOrWhiteSpace(initialDirectory) && System.IO.Directory.Exists(initialDirectory)) {
                    Guid shellItemId = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                    IShellItem initialFolder;
                    SHCreateItemFromParsingName(initialDirectory, IntPtr.Zero, ref shellItemId, out initialFolder);
                    dialog.SetFolder(initialFolder);
                    Marshal.ReleaseComObject(initialFolder);
                }

                int result = dialog.Show(IntPtr.Zero);
                if (result == unchecked((int)0x800704C7)) return null;
                Marshal.ThrowExceptionForHR(result);

                IShellItem selectedFolder;
                dialog.GetResult(out selectedFolder);
                try {
                    IntPtr path;
                    selectedFolder.GetDisplayName(DisplayNameType.FileSystemPath, out path);
                    try { return Marshal.PtrToStringUni(path); }
                    finally { Marshal.FreeCoTaskMem(path); }
                }
                finally { Marshal.ReleaseComObject(selectedFolder); }
            }
            finally { Marshal.ReleaseComObject(dialog); }
        }
    }
}
'@
Add-Type -TypeDefinition $source
$selectedPath = [PpsFolderPicker.NativeFolderPicker]::SelectFolder(
    ${toPowerShellLiteral(config.title ?? "Select a folder")},
    ${toPowerShellLiteral(initialDirectory)})
if ($selectedPath) { [Console]::Out.Write($selectedPath) }
`;
    const stdout = await runPowerShellDialog(script);
    const selectedFolder = stdout.trim() || undefined;
    if (selectedFolder) rememberDirectory(selectedFolder);
    return selectedFolder;
}
