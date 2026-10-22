import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const MIME: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
const MAX_BYTES = 64 * 1024;

/** Read a logo file as a `data:` URI. The page shows it in an `<img>`, so the CSP needs no new source. */
export async function readLogo(path: string): Promise<string> {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`--logo ${path}: use an .svg, .png or .webp file`);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (e) {
    throw new Error(`--logo ${path}: cannot read the file (${(e as NodeJS.ErrnoException).code ?? "unknown error"})`);
  }
  if (bytes.length > MAX_BYTES) throw new Error(`--logo ${path}: ${bytes.length} bytes, the limit is 64 KiB`);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
