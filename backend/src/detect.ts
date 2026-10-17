import fs from 'node:fs/promises';

/**
 * Artifact kind detection from file content (never from the extension alone).
 * The kind selects an analysis profile; REA then re-validates the format itself.
 */
export type ArtifactKind =
  | 'android-apk'
  | 'android-bundle'
  | 'javascript-archive'
  | 'electron-asar'
  | 'dotnet-assembly'
  | 'native-elf'
  | 'native-pe'
  | 'native-macho'
  | 'wasm'
  | 'sqlite'
  | 'archive'
  | 'unknown';

export interface Detection {
  kind: ArtifactKind;
  detail: string;
}

const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_NAMES = 200_000;

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** Lists entry names from a ZIP central directory without extracting anything. */
export async function listZipEntries(filePath: string): Promise<string[] | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || entries === 0xffff) {
      // ZIP64: locator sits 20 bytes before EOCD.
      const locatorAt = eocd - 20;
      if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== 0x07064b50) return null;
      const zip64At = Number(tail.readBigUInt64LE(locatorAt + 8));
      const rec = await readAt(handle, zip64At, 56);
      if (rec.readUInt32LE(0) !== 0x06064b50) return null;
      entries = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES || cdOffset + cdSize > size) return null;
    const cd = await readAt(handle, cdOffset, cdSize);
    const names: string[] = [];
    let p = 0;
    while (p + 46 <= cd.length && names.length < Math.min(entries, MAX_ZIP_NAMES)) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      names.push(cd.subarray(p + 46, p + 46 + nameLength).toString('utf8'));
      p += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    await handle.close();
  }
}

function isDotnetPe(head: Buffer): boolean {
  if (head.length < 0x40) return false;
  const peOffset = head.readUInt32LE(0x3c);
  if (peOffset + 24 > head.length || head.readUInt32LE(peOffset) !== 0x00004550) return false;
  const optional = peOffset + 24;
  const magic = head.readUInt16LE(optional);
  const dirBase = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : -1;
  if (dirBase < 0) return false;
  const clrEntry = dirBase + 14 * 8; // IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR
  if (clrEntry + 8 > head.length) return false;
  return head.readUInt32LE(clrEntry) !== 0 && head.readUInt32LE(clrEntry + 4) !== 0;
}

export async function detectArtifact(filePath: string, fileName: string): Promise<Detection> {
  const handle = await fs.open(filePath, 'r');
  let head: Buffer;
  try {
    head = await readAt(handle, 0, 4096);
  } finally {
    await handle.close();
  }
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) {
    const names = (await listZipEntries(filePath)) ?? [];
    const set = new Set(names);
    if (set.has('AndroidManifest.xml') && names.some((n) => /^classes\d*\.dex$/.test(n))) {
      return { kind: 'android-apk', detail: `APK com ${names.filter((n) => n.endsWith('.dex')).length} arquivo(s) DEX` };
    }
    if (names.some((n) => n.endsWith('.apk')) && (set.has('manifest.json') || set.has('toc.pb') || set.has('BundleConfig.pb'))) {
      return { kind: 'android-bundle', detail: 'Pacote dividido (XAPK/APKS/AAB)' };
    }
    const packageJson = names.filter((n) => /(^|\/)package\.json$/.test(n) && !n.includes('node_modules/'));
    const hasScripts = names.some((n) => /\.(m?js|cjs|ts|tsx|jsx|html)$/.test(n));
    if (packageJson.length > 0 || (hasScripts && names.some((n) => n.endsWith('.asar')))) {
      return { kind: 'javascript-archive', detail: `Projeto JavaScript/Web com ${names.length} entradas` };
    }
    if (hasScripts) {
      return { kind: 'javascript-archive', detail: `Arquivo web (sem package.json) com ${names.length} entradas` };
    }
    return { kind: 'archive', detail: `ZIP com ${names.length} entradas` };
  }
  if (head.length >= 16 && head.readUInt32LE(0) === 4 && /\.asar$/i.test(fileName)) {
    return { kind: 'electron-asar', detail: 'Arquivo ASAR do Electron' };
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return { kind: 'native-elf', detail: `ELF ${head[4] === 2 ? '64' : '32'}-bit` };
  }
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
    return isDotnetPe(head)
      ? { kind: 'dotnet-assembly', detail: 'Assembly .NET (PE/CLI)' }
      : { kind: 'native-pe', detail: 'Executável PE (Windows)' };
  }
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
      return { kind: 'native-macho', detail: 'Mach-O' };
    }
    if (magic === 0xcafebabe && head.length >= 8 && head.readUInt32BE(4) < 32) {
      return { kind: 'native-macho', detail: 'Mach-O universal (fat)' };
    }
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
    return { kind: 'wasm', detail: 'Módulo WebAssembly' };
  }
  if (head.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000') {
    return { kind: 'sqlite', detail: 'Banco SQLite' };
  }
  return { kind: 'unknown', detail: 'Formato não reconhecido' };
}
