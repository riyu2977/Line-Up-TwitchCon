export const CHAT_READ_SCOPE = 'user:read:chat';
export const CHAT_WRITE_SCOPE = 'user:write:chat';

export function assessBroadcasterChatToken(token, { clientId, broadcasterId }) {
  if (!token || typeof token !== 'object') return { status: 'invalid-token', ok: false, canRead: false, canWrite: false, senderMatchesBroadcaster: false, detail: 'Twitch did not return token metadata.' };
  if (token.client_id !== clientId) return { status: 'client-id-mismatch', ok: false, canRead: false, canWrite: false, senderMatchesBroadcaster: false, detail: 'The token belongs to a different Twitch application client ID.' };
  if (token.user_id !== broadcasterId) return { status: 'broadcaster-mismatch', ok: false, canRead: false, canWrite: false, senderMatchesBroadcaster: false, detail: 'The token owner does not match the configured broadcaster.' };
  const scopes = Array.isArray(token.scopes) ? token.scopes : [];
  const canRead = scopes.includes(CHAT_READ_SCOPE);
  const canWrite = scopes.includes(CHAT_WRITE_SCOPE);
  if (!canRead) return { status: 'missing-read-scope', ok: false, canRead, canWrite, senderMatchesBroadcaster: true, detail: `The token lacks ${CHAT_READ_SCOPE}; incoming chat cannot connect.` };
  return {
    status: canWrite ? 'authorized' : 'missing-write-scope',
    ok: true,
    canRead,
    canWrite,
    senderMatchesBroadcaster: true,
    detail: canWrite ? `The validated broadcaster token has ${CHAT_WRITE_SCOPE}.` : `The token is valid for this broadcaster but lacks ${CHAT_WRITE_SCOPE}.`,
  };
}
