/**
 * Minimal .zip reader for "Extract folder": reads the central directory and returns each entry's
 * name and bytes. Supports stored (0) and deflated (8) entries — what zip tools write — using the
 * platform's DecompressionStream, so it runs in Node 18+ and in browsers. No zip64, no encryption.
 */

export interface ZipEntry {
  /** Path inside the archive, '/'-separated; a folder entry ends with '/'. */
  name: string;
  data: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntries(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is the last 22 bytes plus an optional comment (≤ 64 KB).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Extract folder: the source is not a .zip archive');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new Error('Extract folder: corrupt .zip central directory');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/');
    offset += 46 + nameLength + extraLength + commentLength;

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error(`Extract folder: corrupt .zip entry '${name}'`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`Extract folder: unsupported compression method ${method} for '${name}'`);
    entries.push({ name, data: method === 8 ? await inflateRaw(raw) : raw.slice() });
  }
  return entries;
}
