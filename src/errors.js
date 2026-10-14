import { PingRoomError, PingRoomNetworkError, PingRoomTimeoutError } from '@pingroom/sdk';

export class UnknownDeliveryError extends Error {
  constructor() {
    super('The send outcome is uncertain. Inspect room history and run npm run status -- <delivery-id>; automatic resend is blocked.');
    this.name = 'UnknownDeliveryError';
  }
}

export function errorSummary(error) {
  if (error instanceof PingRoomError) {
    const code = typeof error.code === 'string' && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'request_failed';
    return `PingRoom ${code}${Number.isInteger(error.status) ? ` (HTTP ${error.status})` : ''}.`;
  }
  if (error instanceof PingRoomNetworkError || error instanceof PingRoomTimeoutError) return 'PingRoom network request failed or timed out.';
  return error instanceof Error ? error.message : 'Artifact delivery stopped.';
}
