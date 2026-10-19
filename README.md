# PingRoom artifact delivery starter

Hand over report files in a PingRoom ping. Supply one to three local files; this
starter adds a checksum manifest, uploads the exact bytes, and sends one room ping.
The sample files contain a harmless four-order report. **Live attachments require
a PingRoom Pro account.** The offline demo needs no account.

## Try it offline

Requires Node.js 22 or newer. Choose **Use this template** on GitHub, or:

```sh
git clone https://github.com/pingroom/starter-artifact-delivery.git
cd starter-artifact-delivery
npm ci
npm run demo
npm test
```

The demo uses the real SDK with a local mock transport. It reads no credentials,
makes no network requests, and removes its temporary files. It simulates uploading
two sample files plus `manifest.txt`, then shows that repeating the same delivery
makes no new requests. Package installation needs npm access.

## Connect and send

1. [Install PingRoom](https://pingroom.io/i), sign in with Pro, and create a private
   room you own. File recipients must be able to access that room.
2. Run `npm run connect`. Open the printed link and approve the robot's access to
   the room. Reuse that link while pairing is pending.
3. Send the samples with an explicit delivery ID:

```sh
npm start -- sample-001
npm run status -- sample-001
```

To send your own output, pass explicit paths. Quote paths containing spaces:

```sh
npm start -- weekly-report-001 ./reports/summary.md ./reports/metrics.txt
```

`sent` means the API accepted a ping, not that anyone opened the files. Repeating
the same ID with the same filenames, order, bytes, credential, and room returns
the saved receipt. Keep the original files available for that comparison; use
`npm run status` when you only need to read the journal. A new ID means a new
intentional delivery. Do not run the same ID from separate machines or clones.

Pairing saves ignored `.pingroom/credentials.json` with `0600` file and `0700`
directory permissions on POSIX systems. Keep the directory private on Windows.
For CI, supply both `PINGROOM_TOKEN` and `PINGROOM_ROOM` through your secret store.
A complete pair overrides the saved connection; defined blank or partial pairs
are rejected. For local overrides, copy `.env.example` to `.env`, uncomment both
settings, and fill them in. Credentials are never stored in delivery journals.

## Files and the manifest

- Supply **1–3 regular files**, each **1 byte–5 MiB**. The manifest uses the fourth
  attachment slot. Allowed extensions are `md`, `pdf`, `html`, `txt`, `jpg`,
  `jpeg`, `png`, and `zip`. The server checks content against the extension, so
  renaming arbitrary bytes to `.pdf` will fail, and `.txt` accepts only plain
  text: JSON and CSV content are recognized as such and refused. Zip them instead.
- Names must be unique, use letters, numbers, dots, underscores, or hyphens,
  start with a letter or number, and contain at most 100 characters. A dot
  cannot come right before the extension. An uppercase extension is sent
  lowercased (`REPORT.PDF` becomes `REPORT.pdf`), as the server stores it.
  `manifest.txt` is reserved.
- Every file is read and hashed before the first upload. Uploads use those
  snapshots, so later path changes cannot silently replace the prepared bytes.
  The manifest is plain text: a `pingroom-artifact-manifest/v1` line, a
  `delivery_id` line, then one `<sha256>  <bytes>  <filename>` line per file. It
  excludes itself. Its own hash appears in the ping's structured data.
- This checksum manifest describes the supplied bytes; it is not a signature,
  malware scan, or proof of authorship. The SDK's `attachments.manifest()` is a
  separate ZIP-listing API and is not used here.
- Uploads require `pingroom:attachments:write` and Pro. Broadcasting requires room
  access and the connected human to own the room. Attachment IDs are single-use;
  unused uploads expire after 24 hours. Recipients fetch files through authenticated
  access, not permanent public URLs.

To integrate into an existing Node application, import `deliver` from
`src/delivery.js` and provide the configured SDK client, token fingerprint, room,
delivery ID, source paths, and private state directory, as shown in `src/main.js`.
Keep delivery IDs stable for the same intended handover. The starter never asks
for approval or evaluates file content as a command.

## Recover an interrupted delivery

Journals live in `.pingroom/deliveries/<delivery-id>/journal.json`. Local writes
flush the file and atomically replace the journal; directory entries are flushed
where supported. Keep this directory on persistent local storage. It is not a
distributed transaction or protection against losing the underlying disk.

Before any broadcast attempt, failures leave `upload_failed` or `uploading`.
Known unused uploads are cleaned up; running the same command can retry this
phase with fresh attachment IDs. A lost upload response may leave an unknown
unused upload that expires after 24 hours. Cleanup treats DELETE 404 as nothing
further to clean only in this phase: the API also uses 404 for inaccessible or
claimed IDs, so do not reuse these attachment IDs outside this starter.

The journal records `sending` before dispatch. A lost response, process crash,
malformed result, or failed receipt write may leave `sending` or `unknown`.
**Neither state retries automatically or deletes attachments.** `correlation_id`
is a trace label, not server idempotency. Read the journal and inspect the room:

```sh
npm run status -- weekly-report-001
```

If you have confirmed the matching ping and obtained its notification ID, record
that observation locally:

```sh
npm run resolve -- weekly-report-001 sent CONFIRMED_NOTIFICATION_ID
```

Otherwise, keep the uncertain state while investigating, or mark the attempt
abandoned with `npm run resolve -- weekly-report-001 abandon`. Abandoning does
not undo a possible ping and does not enable the same ID to resend. Use a new
ID only for an intentional new attempt after considering duplicate delivery.
Recovery commands change local state only; they do not verify the room for you.

Only one process may use a delivery ID at a time. If a crash leaves its
`delivery.lock` directory, inspect `owner.json`, confirm the previous process has
stopped, then remove only that lock directory. A stale-looking PID is insufficient
because PIDs can be reused. Preserve the journal. SIGINT/SIGTERM cancels uploads;
an already attempted broadcast may still succeed. A 15-second shutdown watchdog
can leave a lock and uncertain state. Do not delete journals to bypass recovery.

## Verify changes

CI runs credential-free tests and the demo on Node 22 and 24. Tests cover multipart
bytes, manifests, input limits, replay, scope changes, cleanup, cancellation,
ambiguous sends, and local locking. They do not prove device delivery or check a
real account's Pro entitlement.

[SDK](https://github.com/pingroom/sdk) · [CLI](https://github.com/pingroom/cli) ·
[Job progress starter](https://github.com/pingroom/starter-job-progress) ·
[Human review starter](https://github.com/pingroom/starter-human-review)

MIT licensed. `@pingroom/sdk` 0.7.1 is pinned with a lockfile.
