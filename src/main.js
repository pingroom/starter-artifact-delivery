import { PingRoom } from '@pingroom/sdk';
import { loadConnection, loadEnvironment, samplePaths, sha256, stateDirectory } from './config.js';
import { deliver } from './delivery.js';
import { errorSummary } from './errors.js';
import { shutdownSignal } from './signals.js';

const shutdown = shutdownSignal();
try {
  loadEnvironment();
  const [deliveryId, ...paths] = process.argv.slice(2);
  if (!deliveryId) throw new Error('Use: npm start -- <delivery-id> [file1 file2 file3]. Omit paths to send the harmless sample files.');
  const { token, room } = await loadConnection();
  const result = await deliver({
    client: new PingRoom({ token, timeoutMs: 10_000 }), tokenFingerprint: sha256(token),
    room, deliveryId, paths: paths.length ? paths : samplePaths, root: stateDirectory, signal: shutdown.signal,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(errorSummary(error)); process.exitCode ||= 1; }
finally { shutdown.dispose(); }
