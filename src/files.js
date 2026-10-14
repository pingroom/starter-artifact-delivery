import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { sha256 } from './config.js';

export const MAX_BYTES = 5 * 1024 * 1024;
const extensions = new Set(['.md', '.pdf', '.html', '.txt', '.jpg', '.jpeg', '.png', '.zip']);

async function snapshot(path, signal) {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw new Error('Each artifact must be a regular file of 1 byte–5 MiB.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length < 1 || length > MAX_BYTES) throw new Error('Artifact changed size outside the 1 byte–5 MiB limit.');
    return Buffer.from(buffer.subarray(0, length));
  } finally { await file.close(); }
}

export async function prepareFiles(paths, deliveryId, signal) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 3) throw new Error('Supply 1–3 artifact paths; manifest.txt uses the fourth attachment slot.');
  const names = new Set(['manifest.txt']);
  const files = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !path) throw new Error('Artifact paths must be nonempty strings.');
    const filename = basename(path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(filename) || !extensions.has(extname(filename).toLowerCase())) {
      throw new Error('Use a simple filename with md, pdf, html, txt, jpg, jpeg, png, or zip extension.');
    }
    if (names.has(filename.toLowerCase())) throw new Error('Filenames must be unique; manifest.txt is reserved.');
    names.add(filename.toLowerCase());
    const bytes = await snapshot(path, signal);
    files.push({ filename, bytes, size_bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { format: 'pingroom-artifact-manifest/v1', delivery_id: deliveryId, files: files.map(({ filename, size_bytes, sha256 }) => ({ filename, size_bytes, sha256 })) };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > MAX_BYTES) throw new Error('Manifest exceeds the attachment limit.');
  files.push({ filename: 'manifest.txt', bytes, size_bytes: bytes.length, sha256: sha256(bytes) });
  return files;
}
