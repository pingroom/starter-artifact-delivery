import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, readJson } from './storage.js';

export const stateDirectory = fileURLToPath(new URL('../.pingroom/', import.meta.url));
export const samplePaths = ['report.md', 'metrics.txt'].map((name) => fileURLToPath(new URL(`../samples/${name}`, import.meta.url)));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function deliveryDirectory(root, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('Supply a delivery ID of 1–64 letters, numbers, hyphens, or underscores.');
  return join(root, 'deliveries', id);
}

export function loadEnvironment() {
  try { process.loadEnvFile('.env'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function saveConnection(directory, connection) {
  await atomicJson(directory, 'credentials.json', connection);
}

export async function loadConnection(directory = stateDirectory, env = process.env) {
  const token = env.PINGROOM_TOKEN?.trim();
  const room = env.PINGROOM_ROOM?.trim();
  let connection;
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) {
    if (!token || !room) throw new Error('Set both PINGROOM_TOKEN and PINGROOM_ROOM; blank or partial overrides are refused.');
    connection = { token, room };
  } else connection = await readJson(join(directory, 'credentials.json'));
  if (!connection || typeof connection.token !== 'string' || !connection.token.trim() || !safeId(connection.room)) {
    throw new Error('Run npm run connect, or set both PINGROOM_TOKEN and PINGROOM_ROOM.');
  }
  return { token: connection.token, room: connection.room };
}
