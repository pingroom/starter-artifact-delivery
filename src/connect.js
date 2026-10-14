import { PingRoom } from '@pingroom/sdk';
import { saveConnection, stateDirectory } from './config.js';
import { errorSummary } from './errors.js';
import { shutdownSignal } from './signals.js';

const shutdown = shutdownSignal();
try {
  console.log('Deliver files and their checksum manifest to a PingRoom room. Attachments require Pro.');
  console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
  const client = new PingRoom({ timeoutMs: 10_000 });
  const pairing = await client.auth.startPairing({ agent_label: 'Artifact delivery' });
  console.log(`Approve this robot and select a private room you own: ${pairing.pair_browser_url ?? pairing.pair_url}`);
  const active = await client.auth.waitForPairing(pairing, { signal: shutdown.signal });
  const room = active.home_room ?? active.room;
  if (!room?.invite_code) throw new Error('No delivery room returned. Create a private room you own and connect again.');
  await saveConnection(stateDirectory, { token: active.credential, room: room.invite_code });
  console.log('Connected. Saved .pingroom/credentials.json. Run npm start -- sample-001 to send the sample files.');
} catch (error) { console.error(errorSummary(error)); process.exitCode ||= 1; }
finally { shutdown.dispose(); }
