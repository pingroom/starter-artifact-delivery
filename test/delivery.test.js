import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PingRoom } from '@pingroom/sdk';
import { deliver, readDelivery, resolveDelivery } from '../src/delivery.js';
import { prepareFiles, MAX_BYTES } from '../src/files.js';
import { deliveryDirectory, sha256 } from '../src/config.js';
import { acquireLock, atomicJson } from '../src/storage.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fixture(t, intercept = async () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'pingroom-delivery-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, 'report.md'), join(root, 'metrics.txt')];
  await writeFile(paths[0], '# Report\nFour orders ✅\n');
  await writeFile(paths[1], 'total_cents=9125\n');
  const calls = [];
  const uploads = [];
  let sendCount = 0;
  const client = new PingRoom({
    token: 'offline-test', baseUrl: 'https://offline.invalid', timeoutMs: 1_000,
    async fetch(url, options) {
      const path = new URL(url).pathname;
      const request = { path, method: options.method };
      if (path === '/api/agent/attachments' && options.method === 'POST') {
        assert.ok(options.body instanceof FormData);
        assert.equal(new Headers(options.headers).get('content-type'), null, 'The SDK/runtime must set the multipart boundary');
        const file = options.body.get('file');
        request.file = { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
        uploads.push(request.file);
      } else if (options.method === 'POST') request.body = JSON.parse(options.body);
      calls.push(request);
      const intercepted = await intercept(request, { uploads, calls, paths, signal: options.signal });
      if (intercepted !== undefined) return intercepted;
      if (request.file) return json({ attachment: { id: `att-${uploads.length}`, filename: request.file.filename, size_bytes: request.file.bytes.length, mime_type: 'text/plain', created_at: '2026-10-14T00:00:00Z' } });
      if (path === '/api/agent/rooms/test-room/notifications' && options.method === 'POST') {
        sendCount += 1;
        return json({ id: `ping-${sendCount}`, ...request.body });
      }
      if (options.method === 'DELETE' && /^\/api\/agent\/attachments\/att-\d+$/.test(path)) return new Response(null, { status: 204 });
      assert.fail(`Unexpected API request: ${options.method} ${path}`);
    },
  });
  return { root, paths, uploads, calls, options: { client, tokenFingerprint: 'offline-test', room: 'test-room', deliveryId: 'report-001', paths, root } };
}

test('uploads exact file snapshots and checksum manifest, then one attachment ping', async (t) => {
  const f = await fixture(t);
  const result = await deliver(f.options);
  assert.deepEqual(result, { reused: false, delivery_id: 'report-001', notification_id: 'ping-1', status: 'sent' });
  assert.equal(f.uploads.length, 3);
  const manifest = JSON.parse(f.uploads[2].bytes.toString());
  assert.equal(manifest.delivery_id, 'report-001');
  assert.equal(manifest.files.length, 2, 'Manifest excludes itself');
  assert.deepEqual(manifest.files, f.uploads.slice(0, 2).map((file) => ({ filename: file.filename, size_bytes: file.bytes.length, sha256: sha256(file.bytes) })));
  const send = f.calls.at(-1);
  assert.equal(send.path, '/api/agent/rooms/test-room/notifications');
  assert.deepEqual(send.body.attachment_ids, ['att-1', 'att-2', 'att-3']);
  assert.equal(send.body.correlation_id, 'artifact-report-001');
  assert.equal(send.body.data.manifest_sha256, sha256(f.uploads[2].bytes));
  assert.equal(JSON.stringify(send.body).includes('Four orders'), false, 'Bytes must not ride the ping JSON');
  assert.equal((await readDelivery(f.root, 'report-001')).status, 'sent');
});

test('same ID and same files reuse the local receipt without requests', async (t) => {
  const f = await fixture(t);
  await deliver(f.options);
  const requestCount = f.calls.length;
  assert.equal((await deliver(f.options)).reused, true);
  assert.equal(f.calls.length, requestCount);
});

test('different content or connection cannot reuse a delivery ID', async (t) => {
  const f = await fixture(t);
  await deliver(f.options);
  await assert.rejects(deliver({ ...f.options, room: 'other-room' }), /different files or a different connection/);
  await writeFile(f.paths[0], 'Changed contents');
  await assert.rejects(deliver(f.options), /different files or a different connection/);
  assert.equal(f.calls.length, 4);
});

test('file changes after preflight cannot alter uploaded bytes', async (t) => {
  const f = await fixture(t, async (request, { paths, uploads }) => {
    if (request.file && uploads.length === 1) await writeFile(paths[1], 'Changed during upload');
  });
  await deliver(f.options);
  assert.equal(f.uploads[1].bytes.toString(), 'total_cents=9125\n');
});

test('all file validation completes before any upload', async (t) => {
  const f = await fixture(t);
  const bad = join(f.root, 'empty.txt');
  await writeFile(bad, '');
  await assert.rejects(deliver({ ...f.options, paths: [f.paths[0], bad] }), /1 byte/);
  await writeFile(bad, 'x');
  await truncate(bad, MAX_BYTES + 1);
  await assert.rejects(deliver({ ...f.options, paths: [bad] }), /5 MiB/);
  await assert.rejects(deliver({ ...f.options, paths: [join(f.root, 'unsupported.json')] }), /extension/);
  await assert.rejects(deliver({ ...f.options, paths: [...f.paths, ...f.paths] }), /1–3/);
  await assert.rejects(deliver({ ...f.options, paths: [f.paths[0], f.paths[0]] }), /unique/);
  await assert.rejects(deliver({ ...f.options, paths: [join(f.root, 'manifest.txt')] }), /reserved/);
  assert.equal(f.calls.length, 0);
});

test('three source files use exactly four attachment slots', async (t) => {
  const f = await fixture(t);
  const extra = join(f.root, 'notes.txt');
  await writeFile(extra, 'Safe extra note');
  const files = await prepareFiles([...f.paths, extra], 'four-files');
  assert.equal(files.length, 4);
  assert.equal(files.at(-1).filename, 'manifest.txt');
});

test('an upload error deletes known unused uploads and preserves the upload failure', async (t) => {
  const f = await fixture(t, (request, { uploads }) => {
    if (request.file && uploads.length === 2) return json({ code: 'pro_required', message: 'Do not expose sensitive server text' }, 402);
  });
  await assert.rejects(deliver(f.options), (error) => error.status === 402 && error.code === 'pro_required');
  assert.deepEqual(f.calls.filter((call) => call.method === 'DELETE').map((call) => call.path), ['/api/agent/attachments/att-1']);
  assert.equal(f.calls.some((call) => call.path.endsWith('/notifications')), false);
  const journal = await readDelivery(f.root, 'report-001');
  assert.equal(journal.status, 'upload_failed');
  assert.deepEqual(journal.uploads, []);
});

test('an uncertain broadcast retains attachments and refuses automatic resend', async (t) => {
  const f = await fixture(t, (request) => {
    if (request.path.endsWith('/notifications')) throw new Error('Lost send response');
  });
  await assert.rejects(deliver(f.options), /send outcome is uncertain/);
  const count = f.calls.length;
  assert.equal((await readDelivery(f.root, 'report-001')).status, 'unknown');
  await assert.rejects(deliver(f.options), /send outcome is uncertain/);
  assert.equal(f.calls.length, count);
  assert.equal(f.calls.some((call) => call.method === 'DELETE'), false);
  await resolveDelivery(f.root, 'report-001', 'sent', 'confirmed-ping');
  assert.deepEqual(await deliver(f.options), { reused: true, delivery_id: 'report-001', notification_id: 'confirmed-ping', status: 'sent' });
});

test('abandoning an unknown send never enables the same ID to resend', async (t) => {
  const f = await fixture(t, (request) => request.path.endsWith('/notifications') ? json({ id: null }) : undefined);
  await assert.rejects(deliver(f.options), /uncertain/);
  await resolveDelivery(f.root, 'report-001', 'abandon');
  await assert.rejects(deliver(f.options), /abandoned/);
  assert.equal(f.calls.length, 4);
});

test('a persisted sending marker after a crash blocks further network requests', async (t) => {
  const f = await fixture(t);
  await deliver(f.options);
  const journal = await readDelivery(f.root, 'report-001');
  journal.status = 'sending';
  delete journal.notification_id;
  await atomicJson(deliveryDirectory(f.root, 'report-001'), 'journal.json', journal);
  await assert.rejects(deliver(f.options), /uncertain/);
  assert.equal(f.calls.length, 4);
});

test('pre-broadcast recovery tolerates a 404 for an expired or already removed upload', async (t) => {
  let recovering = false;
  const f = await fixture(t, (request, { uploads }) => {
    if (!recovering && request.file && uploads.length === 2) return json({ code: 'pro_required' }, 402);
    if (request.method === 'DELETE') return recovering ? json({}, 404) : json({}, 503);
  });
  await assert.rejects(deliver(f.options));
  assert.equal((await readDelivery(f.root, 'report-001')).uploads.length, 1);
  recovering = true;
  assert.equal((await deliver(f.options)).status, 'sent');
});

test('other cleanup errors prevent pre-broadcast recovery', async (t) => {
  const f = await fixture(t, (request, { uploads }) => {
    if (request.file && uploads.length === 2) return json({}, 402);
    if (request.method === 'DELETE') return json({}, 403);
  });
  await assert.rejects(deliver(f.options));
  const uploadCount = f.uploads.length;
  await assert.rejects(deliver(f.options), /Could not clean/);
  assert.equal(f.uploads.length, uploadCount);
});

test('cancellation after upload cleans it and never dispatches a ping', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (request, { uploads }) => {
    if (request.file && uploads.length === 1) controller.abort(new Error('Cancelled'));
  });
  await assert.rejects(deliver({ ...f.options, signal: controller.signal }));
  assert.equal(f.calls.some((call) => call.path.endsWith('/notifications')), false);
});

test('a second process cannot use the same delivery journal', async (t) => {
  const f = await fixture(t);
  const release = await acquireLock(deliveryDirectory(f.root, 'report-001'));
  try { await assert.rejects(deliver(f.options), /Delivery lock exists/); }
  finally { await release(); }
  assert.equal(f.calls.length, 0);
});

test('journal never stores the credential or file contents', async (t) => {
  const f = await fixture(t);
  await deliver(f.options);
  const raw = await readFile(join(deliveryDirectory(f.root, 'report-001'), 'journal.json'), 'utf8');
  assert.equal(raw.includes('offline-test'), false);
  assert.equal(raw.includes('Four orders'), false);
  assert.equal(raw.includes('total_cents='), false);
});
