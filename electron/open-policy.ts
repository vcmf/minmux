// Which files the OS's default app may open on a click (docs/design/WORKDIR_OBJECTS.md, "Never
// execute"). An agent can write any file into a folder, and for some types the default action
// runs them; so only an allowlist of types each platform opens as data goes through, after
// symlinks are resolved. Anything else is revealed in the file manager instead. Pure.

export type Os = "darwin" | "win32" | "linux"

// Opened as data on every platform: documents, images, media, archives, text.
const DATA = new Set(
  (
    "pdf epub rtf txt md markdown csv tsv json jsonc yaml yml toml xml ini log " +
    "doc docx xls xlsx ppt pptx odt ods odp pages numbers key " +
    "png jpg jpeg gif webp bmp ico heic heif tif tiff avif psd " +
    "mp3 m4a wav aac flac ogg opus mp4 m4v mov avi mkv webm " +
    "zip tar gz tgz bz2 xz 7z rar " +
    "html htm css svg " +
    "ts tsx mts cts jsx rs go c h cc cpp hpp java kt swift rb php sql lua dart scala ex exs zig"
  ).split(" "),
)

// Run, not opened, by a platform's default action (or by a common setup of it).
const RUNS: Record<Os, Set<string>> = {
  darwin: new Set(["command", "tool", "app", "pkg", "mpkg", "workflow", "terminal", "scpt"]),
  win32: new Set(
    // …and script languages an installer may register to run (Ruby, Lua, PHP, Perl, Tcl, R).
    (
      "js jse vbs vbe wsf wsh hta py pyw ps1 bat cmd com scr pif reg lnk url msi exe jar cpl msc inf " +
      "rb rbw lua php pl pm tcl r"
    ).split(" "),
  ),
  linux: new Set(["desktop", "appimage", "sh", "run", "bin", "jar"]),
}

const extOf = (p: string) => {
  const name = p.split(/[\\/]/).pop() ?? ""
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

// `real` is the path after resolving symlinks. A folder (an .app bundle) or a type not on the
// list (a file with no extension, which may be a script with the exec bit) is never opened. An
// allowlisted type opens by its type, as the OS does, whatever its mode: USB drives and shares
// mark every file executable.
/** May the OS default app open this file? */
export function osMayOpen(real: string, st: { isFile: boolean }, os: Os): boolean {
  if (!st.isFile) return false
  const ext = extOf(real)
  return DATA.has(ext) && !RUNS[os].has(ext)
}
