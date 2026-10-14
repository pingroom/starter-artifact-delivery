import { stateDirectory } from './config.js';
import { readDelivery, resolveDelivery } from './delivery.js';
import { errorSummary } from './errors.js';

try {
  const [command, deliveryId, resolution, notificationId, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected recovery arguments.');
  if (command === 'status') {
    if (resolution || notificationId) throw new Error('Use: npm run status -- <delivery-id>.');
    const journal = await readDelivery(stateDirectory, deliveryId);
    console.log(JSON.stringify({ delivery_id: journal.delivery_id, status: journal.status, room: journal.room, notification_id: journal.notification_id, files: journal.files, uploads: journal.uploads }, null, 2));
  } else if (command === 'resolve') console.log(JSON.stringify(await resolveDelivery(stateDirectory, deliveryId, resolution, notificationId), null, 2));
  else throw new Error('Unknown recovery command.');
} catch (error) { console.error(errorSummary(error)); process.exitCode = 1; }
