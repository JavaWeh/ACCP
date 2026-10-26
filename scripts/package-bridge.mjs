import { createHash } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

export const BRIDGE_TARGETS = [
  { goos: 'linux', goarch: 'amd64', ext: '', archive: 'tar.gz' },
  { goos: 'linux', goarch: 'arm64', ext: '', archive: 'tar.gz' },
  { goos: 'darwin', goarch: 'amd64', ext: '', archive: 'tar.gz' },
  { goos: 'darwin', goarch: 'arm64', ext: '', archive: 'tar.gz' },
  { goos: 'windows', goarch: 'amd64', ext: '.exe', archive: 'zip' },
];

/**
 * @param {string[]} argv
 * @returns {{ out: string, version: string, skipCompile: boolean, prebuiltDir: string, help: boolean }}
 */
export function parsePackageArgs(argv) {
  let out = '';
  let version = '';
  let skipCompile = false;
  let prebuiltDir = '';
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--skip-compile') {
      skipCompile = true;
      continue;
    }
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('Missing --out directory');
      out = value;
      i += 1;
      continue;
    }
    if (arg === '--version') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('Missing --version value');
      version = value;
      i += 1;
      continue;
    }
    if (arg === '--prebuilt-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('Missing --prebuilt-dir directory');
      prebuiltDir = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!help && (!out || !version)) {
    throw new Error('Usage: node scripts/package-bridge.mjs --out DIR --version vX.Y.Z [--prebuilt-dir DIR]');
  }
  return { out, version, skipCompile, prebuiltDir, help };
}

/**
 * Archive basename without compression suffix.
 * @param {string} version
 * @param {{ goos: string, goarch: string }} target
 */
export function archiveBaseName(version, target) {
  return `accp-bridge-${version}-${target.goos}-${target.goarch}`;
}

/**
 * Full archive file name.
 * @param {string} version
 * @param {{ goos: string, goarch: string, archive: string }} target
 */
export function archiveFileName(version, target) {
  return `${archiveBaseName(version, target)}.${target.archive}`;
}

/**
 * @param {Buffer | string} data
 * @returns {string} lowercase hex
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * GNU coreutils-style SHA256SUMS lines (hash + two spaces + filename).
 * @param {{ name: string, hash: string }[]} entries
 */
export function formatSha256Sums(entries) {
  return `${entries.map((e) => `${e.hash}  ${e.name}`).join('\n')}\n`;
}

/**
 * Minimal ustar tar with a single file (sufficient for Bridge binary packaging).
 * @param {string} name path inside archive
 * @param {Buffer} content
 * @returns {Buffer}
 */
export function buildUstarTar(name, content) {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`tar member name too long: ${name}`);
  }
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000644\0', 100, 8, 'utf8'); // mode
  header.write('0000000\0', 108, 8, 'utf8'); // uid
  header.write('0000000\0', 116, 8, 'utf8'); // gid
  const sizeOctal = content.length.toString(8).padStart(11, '0');
  header.write(`${sizeOctal}\0`, 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8'); // mtime
  header.write('        ', 148, 8, 'utf8'); // checksum placeholder
  header.write('0', 156, 1, 'utf8'); // typeflag regular file
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');

  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  const checksum = `${sum.toString(8).padStart(6, '0')}\0 `;
  header.write(checksum, 148, 8, 'utf8');

  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(pad), Buffer.alloc(1024)]);
}

/**
 * Minimal ZIP (store only) with a single file.
 * @param {string} name
 * @param {Buffer} content
 * @returns {Buffer}
 */
export function buildStoreZip(name, content) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(content);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method store
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0, 12); // date
  local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc >>> 0, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42); // relative offset of local header
  nameBuf.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + content.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([local, content, central, end]);
}

/** @param {Buffer} buf */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} goBin
 * @param {string} repoRoot
 * @param {{ goos: string, goarch: string, ext: string }} target
 * @param {string} binaryPath
 */
export function crossCompileBridge(goBin, repoRoot, target, binaryPath) {
  mkdirSync(dirname(binaryPath), { recursive: true });
  const result = spawnSync(
    goBin,
    ['build', '-trimpath', '-ldflags=-s -w', '-o', binaryPath, './cmd/accp-bridge'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: target.goos,
        GOARCH: target.goarch,
      },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`go build ${target.goos}/${target.goarch} failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * @param {string} archivePath
 * @param {string} memberName
 * @param {Buffer} content
 * @param {'tar.gz' | 'zip'} kind
 */
export async function writeArchive(archivePath, memberName, content, kind) {
  mkdirSync(dirname(archivePath), { recursive: true });
  if (kind === 'zip') {
    writeFileSync(archivePath, buildStoreZip(memberName, content));
    return;
  }
  const tar = buildUstarTar(memberName, content);
  await pipeline(Readable.from(tar), createGzip(), createWriteStream(archivePath));
}

/**
 * @param {{
 *   repoRoot: string,
 *   outDir: string,
 *   version: string,
 *   goBin?: string,
 *   skipCompile?: boolean,
 *   prebuiltDir?: string,
 *   binaries?: Record<string, Buffer | string>,
 * }} opts
 * binaries key = `${goos}-${goarch}` when skipCompile (tests / fixtures).
 * prebuiltDir expects files named `{goos}-{goarch}` or `{goos}-{goarch}.exe`.
 */
export async function packageBridge(opts) {
  const {
    repoRoot,
    outDir,
    version,
    goBin = 'go',
    skipCompile = false,
    prebuiltDir = '',
    binaries = {},
  } = opts;

  mkdirSync(outDir, { recursive: true });
  const work = join(outDir, '.work');
  mkdirSync(work, { recursive: true });

  /** @type {{ name: string, hash: string }[]} */
  const sums = [];

  try {
    for (const target of BRIDGE_TARGETS) {
      const key = `${target.goos}-${target.goarch}`;
      const binaryName = `accp-bridge${target.ext}`;
      const binaryPath = join(work, `${key}${target.ext || ''}`);
      let content;
      if (prebuiltDir) {
        const candidate = join(prebuiltDir, `${key}${target.ext}`);
        content = readFileSync(candidate);
      } else if (skipCompile) {
        const fixture = binaries[key];
        if (fixture == null) {
          throw new Error(`skip-compile requires binary fixture for ${key}`);
        }
        content = Buffer.isBuffer(fixture) ? fixture : Buffer.from(fixture);
      } else {
        crossCompileBridge(goBin, repoRoot, target, binaryPath);
        content = readFileSync(binaryPath);
      }

      const name = archiveFileName(version, target);
      const archivePath = join(outDir, name);
      await writeArchive(archivePath, binaryName, content, /** @type {'tar.gz'|'zip'} */ (target.archive));
      const archiveBytes = readFileSync(archivePath);
      sums.push({ name, hash: sha256Hex(archiveBytes) });
    }

    const sumsText = formatSha256Sums(sums);
    writeFileSync(join(outDir, 'SHA256SUMS.txt'), sumsText);
    return { archives: sums.map((s) => s.name), sumsPath: join(outDir, 'SHA256SUMS.txt') };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parsePackageArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node scripts/package-bridge.mjs --out DIR --version vX.Y.Z [--prebuilt-dir DIR]');
      process.exitCode = 0;
    } else {
      const outDir = resolve(process.cwd(), args.out);
      const result = await packageBridge({
        repoRoot: process.cwd(),
        outDir,
        version: args.version,
        skipCompile: args.skipCompile,
        prebuiltDir: args.prebuiltDir ? resolve(process.cwd(), args.prebuiltDir) : '',
      });
      console.log(`Packaged ${result.archives.length} Bridge archives into ${outDir}`);
      console.log(`Wrote ${result.sumsPath}`);
    }
  } catch (error) {
    console.error(`package-bridge failed: ${error.message}`);
    process.exitCode = 1;
  }
}
