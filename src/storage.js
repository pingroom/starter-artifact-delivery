import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function readJson(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record');
    return value;
  } catch { throw new Error('A local journal or credential file is invalid. Restore it before continuing.'); }
}

export async function atomicJson(directory, name, value) {
  await privateDirectory(directory);
  const temporary = join(directory, `.write-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, join(directory, name));
    // Flush the directory entry on systems that support directory fsync.
    let handle;
    try { handle = await open(directory, 'r'); await handle.sync(); }
    catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(error.code)) throw error;
    } finally { await handle?.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export async function acquireLock(directory) {
  await privateDirectory(directory);
  const path = join(directory, 'delivery.lock');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Delivery lock exists. Inspect its owner.json and confirm the previous process stopped before removing the lock.');
    throw error;
  }
  const owner = { pid: process.pid, nonce: randomUUID(), started_at: new Date().toISOString() };
  try { await atomicJson(path, 'owner.json', owner); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return async () => {
    const current = await readJson(join(path, 'owner.json'));
    if (current?.nonce === owner.nonce) await rm(path, { recursive: true, force: true });
  };
}
