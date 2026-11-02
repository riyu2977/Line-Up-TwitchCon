export function createTwitchChatSender({ fetchImpl = fetch, clientId, accessToken, broadcasterId, enabled, authorizationStatus }) {
  let sendQueue = Promise.resolve();
  let lastSentAt = 0;
  function sendMessage(message, replyParentMessageId) {
    const operation = sendQueue.then(async () => {
      const waitMs = Math.max(0, 1000 - (Date.now() - lastSentAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      lastSentAt = Date.now();
      return performSend(message, replyParentMessageId);
    });
    sendQueue = operation.catch(() => {});
    return operation;
  }

  async function performSend(message, replyParentMessageId) {
    const authStatus = typeof authorizationStatus === 'function' ? authorizationStatus() : authorizationStatus;
    if (authStatus === 'invalid-token') return { status: 'invalid-token', detail: 'The broadcaster access token is invalid. Reauthorize it.' };
    if (authStatus === 'sender-not-permitted' || authStatus === 'broadcaster-mismatch') return { status: 'forbidden', detail: 'The validated token user is not permitted to send as this broadcaster.' };
    if (authStatus && authStatus !== 'authorized' && authStatus !== 'missing-write-scope') {
      return { status: 'authorization-error', detail: `Chat send was not attempted: ${authStatus}.` };
    }
    if (!(typeof enabled === 'function' ? enabled() : enabled)) {
      return { status: 'missing-scope', detail: 'The broadcaster token needs user:write:chat.' };
    }
    try {
      const response = await fetchImpl('https://api.twitch.tv/helix/chat/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${typeof accessToken === 'function' ? accessToken() : accessToken}`,
          'Client-Id': clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          broadcaster_id: broadcasterId,
          sender_id: broadcasterId,
          message,
          ...(replyParentMessageId ? { reply_parent_message_id: replyParentMessageId } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        const knownErrors = {
          400: ['bad-request', 'Twitch rejected the message fields or reply parent ID.'],
          401: ['invalid-token', 'Twitch rejected the access token or its client ID. Reauthorize the broadcaster token.'],
          403: ['forbidden', 'The token user is not permitted to send to this broadcaster chat.'],
          429: ['rate-limited', 'Twitch rate-limited the chat send. Retry after the cooldown.'],
        };
        const [status, detail] = knownErrors[response.status] || ['twitch-error', `Twitch chat send failed with HTTP ${response.status}.`];
        return { status, detail, httpStatus: response.status };
      }
      const result = await response.json();
      if (result?.data?.[0]?.is_sent === true) return { status: 'sent', detail: 'Twitch confirmed the message was sent.' };
      const code = result?.data?.[0]?.drop_reason?.code;
      return { status: 'not-sent', detail: code ? `Twitch did not send the message (${String(code).replace(/[^a-z0-9_-]/gi, '').slice(0, 48)}).` : 'Twitch did not send the message; it may have been held or rejected.' };
    } catch (error) {
      return { status: 'network-error', detail: error?.name === 'TimeoutError' ? 'Twitch chat send timed out.' : 'Could not reach Twitch chat send API.' };
    }
  }
  return {
    sendMessage,
    sendJoinConfirmation(displayName, lineCode, replyParentMessageId) {
      const safeName = String(displayName || '').replace(/[\r\n]/g, '').slice(0, 25);
      const mention = safeName ? `@${safeName} ` : '';
      return sendMessage(`${mention}Your line code is ${lineCode}.`, replyParentMessageId);
    },
    announceRound(roleUrl, replyParentMessageId) {
      return sendMessage(`Lineup: The round has started! Open this link and click Get My Role to reveal your role and this round's word: ${roleUrl}`, replyParentMessageId);
    },
  };
}
