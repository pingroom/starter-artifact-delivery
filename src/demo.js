import { PingRoom } from '@pingroom/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { samplePaths } from './config.js';
import { deliver } from './delivery.js';

const uploads = [];
let sends = 0;
// No environment credentials or global fetch: all requests terminate here.
const client = new PingRoom({
  token: 'offline-demo', baseUrl: 'https://offline.invalid',
  async fetch(url, options) {
    const path = new URL(url).pathname;
    let body;
    if (options.method === 'POST' && path === '/api/agent/attachments') {
      const file = options.body.get('file');
      const id = `demo-attachment-${uploads.length + 1}`;
      uploads.push({ filename: file.name, bytes: file.size });
      body = { attachment: { id, filename: file.name, size_bytes: file.size, mime_type: 'text/plain', created_at: '2026-10-14T00:00:00Z' } };
    } else if (options.method === 'POST' && path === '/api/agent/rooms/demo-room/notifications') {
      sends += 1;
      body = { id: 'demo-notification', ...JSON.parse(options.body) };
    } else throw new Error('Unexpected offline demo request.');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});
const root = await mkdtemp(join(tmpdir(), 'pingroom-artifact-demo-'));
try {
  const options = { client, tokenFingerprint: 'offline', room: 'demo-room', deliveryId: 'sample-001', paths: samplePaths, root };
  console.log('First run:', await deliver(options));
  console.log('Repeat same delivery:', await deliver(options));
  console.log(JSON.stringify({ uploads, sends }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
