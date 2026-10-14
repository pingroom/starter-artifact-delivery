import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PingRoomError } from '@pingroom/sdk';
import { deliveryDirectory, loadConnection, saveConnection } from '../src/config.js';
import { errorSummary } from '../src/errors.js';

test('private credentials and complete environment overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pingroom-artifact-config-'));
  try {
    await saveConnection(root, { token: 'saved', room: 'saved-room' });
    assert.deepEqual(await loadConnection(root, {}), { token: 'saved', room: 'saved-room' });
    assert.deepEqual(await loadConnection(root, { PINGROOM_TOKEN: 'env', PINGROOM_ROOM: 'env-room' }), { token: 'env', room: 'env-room' });
    await assert.rejects(loadConnection(root, { PINGROOM_TOKEN: '' }), /blank or partial/);
    await assert.rejects(loadConnection(root, { PINGROOM_TOKEN: '', PINGROOM_ROOM: '' }), /blank or partial/);
    await assert.rejects(loadConnection(root, { PINGROOM_TOKEN: 'partial' }), /blank or partial/);
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(root, 'credentials.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(root)).mode & 0o777, 0o700);
    }
    await writeFile(join(root, 'credentials.json'), 'secret-non-json');
    await assert.rejects(loadConnection(root, {}), (error) => !error.message.includes('secret-non-json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delivery IDs cannot escape their journal directory', () => {
  for (const id of ['../escape', '', 'a/b', '.hidden', 'x'.repeat(65)]) assert.throws(() => deliveryDirectory('/tmp', id), /delivery ID/);
});

test('API diagnostics omit response bodies and server messages', () => {
  assert.equal(errorSummary(new PingRoomError('Token: secret', { status: 402, code: 'pro_required', body: { secret: 'token' } })), 'PingRoom pro_required (HTTP 402).');
});
