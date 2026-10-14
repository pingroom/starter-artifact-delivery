import { join } from 'node:path';
import { acquireLock, atomicJson, readJson } from './storage.js';
import { deliveryDirectory, safeId, sha256 } from './config.js';
import { prepareFiles } from './files.js';
import { UnknownDeliveryError } from './errors.js';
import { PingRoomError } from '@pingroom/sdk';

const statuses = new Set(['uploading', 'upload_failed', 'sending', 'unknown', 'sent', 'abandoned']);

function validateJournal(journal) {
  if (!journal || journal.version !== 1 || !statuses.has(journal.status) || !Array.isArray(journal.uploads)
    || journal.uploads.length > 4 || journal.uploads.some((upload) => !safeId(upload.id))
    || (journal.status === 'sent' && !safeId(journal.notification_id))
    || typeof journal.scope !== 'string' || typeof journal.input_hash !== 'string') {
    throw new Error('Delivery journal is invalid. Restore it; do not reset it to retry a send.');
  }
}

async function cleanup(client, uploads) {
  const results = await Promise.allSettled(uploads.map((upload) => client.attachments.delete(upload.id)));
  // DELETE uses 404 for absent, inaccessible, and claimed IDs. This helper is
  // only called before this journal has attempted any broadcast. With the
  // same credential and no external reuse of IDs, 404 needs no further cleanup.
  return uploads.filter((_, index) => results[index].status === 'rejected'
    && !(results[index].reason instanceof PingRoomError && results[index].reason.status === 404));
}

/** Deliver one explicit set of bytes. A delivery ID is locally replay-safe;
 * it is not a server idempotency key and must not be reused elsewhere.
 */
export async function deliver({ client, tokenFingerprint, room, deliveryId, paths, root, signal }) {
  const directory = deliveryDirectory(root, deliveryId);
  if (!client?.attachments?.upload || !client?.attachments?.delete || !client?.broadcast || !tokenFingerprint || !safeId(room)) throw new Error('A configured SDK client, room, and connection fingerprint are required.');
  signal?.throwIfAborted();
  // Snapshot and validate every source before any API request. Upload these
  // exact bytes so a later path change cannot alter the reviewed manifest.
  const files = await prepareFiles(paths, deliveryId, signal);
  const descriptors = files.map(({ filename, size_bytes, sha256 }) => ({ filename, size_bytes, sha256 }));
  const inputHash = sha256(JSON.stringify(descriptors));
  const scope = sha256(JSON.stringify({ tokenFingerprint, room }));
  const release = await acquireLock(directory);
  let journal;
  let attempted = false;
  try {
    journal = await readJson(join(directory, 'journal.json'));
    if (journal) {
      validateJournal(journal);
      if (journal.scope !== scope || journal.input_hash !== inputHash) throw new Error('Delivery ID belongs to different files or a different connection. Inspect its journal; use a new ID only for an intentional new delivery.');
      if (journal.status === 'sent') return { reused: true, delivery_id: deliveryId, notification_id: journal.notification_id, status: 'sent' };
      if (journal.status === 'sending' || journal.status === 'unknown') throw new UnknownDeliveryError();
      if (journal.status === 'abandoned') throw new Error('This delivery was abandoned. The same ID cannot send again.');
      // No broadcast was ever attempted in these two statuses. Previous
      // unclaimed upload IDs can be discarded before making fresh uploads.
      const leftovers = await cleanup(client, journal.uploads);
      if (leftovers.length) throw new Error('Could not clean previous unclaimed uploads. Retry later; no ping was sent.');
    }
    journal = { version: 1, delivery_id: deliveryId, scope, input_hash: inputHash, room, status: 'uploading', files: descriptors, uploads: [] };
    await atomicJson(directory, 'journal.json', journal);
    try {
      for (const file of files) {
        signal?.throwIfAborted();
        const attachment = await client.attachments.upload({ filename: file.filename, content: file.bytes, signal });
        if (!safeId(attachment?.id)) throw new Error('Upload returned no valid attachment identity. No ping was sent.');
        if (journal.uploads.some((upload) => upload.id === attachment.id)) throw new Error('Upload returned a repeated attachment identity. No ping was sent.');
        journal.uploads.push({ id: attachment.id, filename: file.filename });
        if (attachment.filename !== file.filename || attachment.size_bytes !== file.size_bytes) throw new Error('Upload metadata does not match the prepared artifact. No ping was sent.');
        await atomicJson(directory, 'journal.json', journal);
      }
      signal?.throwIfAborted();
      journal.status = 'sending';
      // Flush this marker BEFORE the irreversible send. Any crash from here
      // is treated as uncertain, even if the request may not have started.
      await atomicJson(directory, 'journal.json', journal);
      signal?.throwIfAborted();
      attempted = true;
      const ping = await client.broadcast(room, {
        title: 'Artifact delivery', message: `Files ready: ${deliveryId}`,
        correlation_id: `artifact-${deliveryId}`,
        data: { delivery_id: deliveryId, manifest_sha256: files.at(-1).sha256 },
        attachment_ids: journal.uploads.map((upload) => upload.id),
      });
      if (!safeId(ping?.id)) throw new Error('Send returned no valid notification identity.');
      journal.status = 'sent';
      journal.notification_id = ping.id;
      await atomicJson(directory, 'journal.json', journal);
      return { reused: false, delivery_id: deliveryId, notification_id: ping.id, status: 'sent' };
    } catch (error) {
      if (attempted) {
        journal.status = 'unknown';
        try { await atomicJson(directory, 'journal.json', journal); } catch { /* The prior sending marker also blocks replay. */ }
        // Never delete attachments after a broadcast attempt: it may have
        // succeeded even though its response was lost or malformed.
        throw new UnknownDeliveryError();
      }
      journal.status = 'upload_failed';
      try { await atomicJson(directory, 'journal.json', journal); } catch { /* Preserve the original failure. */ }
      journal.uploads = await cleanup(client, journal.uploads);
      try { await atomicJson(directory, 'journal.json', journal); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  } finally { await release(); }
}

export async function readDelivery(root, deliveryId) {
  const journal = await readJson(join(deliveryDirectory(root, deliveryId), 'journal.json'));
  if (!journal) throw new Error('No journal exists for that delivery ID.');
  validateJournal(journal);
  return journal;
}

export async function resolveDelivery(root, deliveryId, resolution, notificationId) {
  if (!['sent', 'abandon'].includes(resolution) || (resolution === 'sent' && !safeId(notificationId))) {
    throw new Error('Use: npm run resolve -- <delivery-id> sent <confirmed-notification-id>, or ... abandon.');
  }
  const directory = deliveryDirectory(root, deliveryId);
  const release = await acquireLock(directory);
  try {
    const journal = await readDelivery(root, deliveryId);
    if (!['sending', 'unknown'].includes(journal.status)) throw new Error('Only an uncertain delivery may be manually resolved.');
    journal.status = resolution === 'sent' ? 'sent' : 'abandoned';
    journal.resolution = 'manual';
    if (resolution === 'sent') journal.notification_id = notificationId;
    await atomicJson(directory, 'journal.json', journal);
    return { delivery_id: deliveryId, status: journal.status, notification_id: journal.notification_id };
  } finally { await release(); }
}
