import { CANVAS_SIZE } from './game.mjs';
import { applyRoundChatCommand, parseLineupCommand } from './commands.mjs';
import { createMessageDeduplicator, DEFAULT_ROUND_DURATION_MS } from './round.mjs';
import { createMatchGame } from './match.mjs';
import { createTwitchChatSender } from './twitch-chat.mjs';
import { createRoundAnnouncer } from './chat-announcements.mjs';
import { assessBroadcasterChatToken } from './twitch-auth.mjs';

const MAX_MESSAGES = 100;

/** A server-owned, broadcaster-isolated Lineup session. Secrets never appear in its public views. */
export function createStreamerSession({
  broadcasterId, accessToken, refreshToken = null, clientId, clientSecret = null, publicAppUrl, rolePath,
  durationMs = DEFAULT_ROUND_DURATION_MS, fetchImpl = fetch,
  random, setTimer, clearTimer, now,
}) {
  if (typeof broadcasterId !== 'string' || !broadcasterId) throw new TypeError('A broadcaster ID is required.');
  if (typeof accessToken !== 'string' || !accessToken) throw new TypeError('A server-side access token is required.');
  let currentAccessToken = accessToken;
  let currentRefreshToken = refreshToken;
  const game = { width: CANVAS_SIZE, height: CANVAS_SIZE, lines: [] };
  const match = createMatchGame({ lines: game.lines, durationMs, random, setTimer, clearTimer, now });
  const messageIds = createMessageDeduplicator();
  const state = {
    status: 'validating', detail: 'Validating Twitch authorization.', broadcasterId,
    connectedAt: null, messages: [], incomingMessagesReceived: 0, lastIncomingAt: null,
    eventSubConnection: 'disconnected', eventSubSubscription: 'not-created',
    lastEventSubMessageAt: null, keepaliveTimeoutMs: null,
  };
  const outgoingChat = {
    authorization: 'not-checked', detail: 'Twitch authorization has not been validated.',
    senderMatchesBroadcaster: null, lastMessage: null, lastMessageAt: null,
  };
  let chatWriteEnabled = false;
  let lastRoundAnnouncement = null;
  const sender = createTwitchChatSender({
    fetchImpl, clientId, accessToken: () => currentAccessToken, broadcasterId,
    enabled: () => chatWriteEnabled,
    authorizationStatus: () => outgoingChat.authorization,
  });
  const announcer = createRoundAnnouncer({ sender, publicAppUrl, rolePath });

  function setStatus(status, detail) { state.status = status; state.detail = detail; }
  function setEventSubState(connection, subscription, keepaliveTimeoutMs = state.keepaliveTimeoutMs) {
    state.eventSubConnection = connection;
    state.eventSubSubscription = subscription;
    state.keepaliveTimeoutMs = keepaliveTimeoutMs;
  }
  function noteEventSubMessage() { state.lastEventSubMessageAt = new Date().toISOString(); }
  function addActivity(text, status = 'info') {
    const record = {
      receivedAt: new Date().toISOString(), senderId: broadcasterId,
      senderName: 'Lineup', broadcasterId, isBroadcaster: true, text,
      activity: status,
    };
    state.messages.unshift(record);
    state.messages.length = Math.min(state.messages.length, MAX_MESSAGES);
    return record;
  }
  function recordOutgoingResult(result) {
    outgoingChat.lastMessage = result;
    outgoingChat.lastMessageAt = new Date().toISOString();
    if (result.status === 'invalid-token') {
      chatWriteEnabled = false;
      outgoingChat.authorization = 'invalid-token';
      outgoingChat.detail = result.detail;
      outgoingChat.senderMatchesBroadcaster = false;
    } else if (result.status === 'forbidden') {
      outgoingChat.authorization = 'sender-not-permitted';
      outgoingChat.detail = result.detail;
      outgoingChat.senderMatchesBroadcaster = false;
    }
  }

  function validateTokenMetadata(token) {
    const assessment = assessBroadcasterChatToken(token, { clientId, broadcasterId });
    chatWriteEnabled = assessment.ok && assessment.canWrite;
    outgoingChat.authorization = assessment.status;
    outgoingChat.detail = assessment.detail;
    outgoingChat.senderMatchesBroadcaster = assessment.senderMatchesBroadcaster;
    if (!assessment.ok) throw new Error(assessment.detail);
    return assessment;
  }

  async function validate() {
    let response;
    try {
      response = await fetchImpl('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `Bearer ${currentAccessToken}` }, signal: AbortSignal.timeout(15000),
      });
    } catch {
      chatWriteEnabled = false;
      outgoingChat.authorization = 'validation-unavailable';
      outgoingChat.detail = 'Could not reach Twitch token validation.';
      throw new Error('Could not reach Twitch token validation.');
    }
    if (!response.ok) {
      chatWriteEnabled = false;
      outgoingChat.authorization = 'invalid-token';
      outgoingChat.detail = `Twitch token validation failed (HTTP ${response.status}).`;
      throw new Error(outgoingChat.detail);
    }
    const token = await response.json();
    validateTokenMetadata(token);
    return token;
  }

  async function refreshAuthorization() {
    if (!currentRefreshToken || !clientSecret) throw new Error('This Twitch session has no refreshable authorization; reconnect the channel.');
    const response = await fetchImpl('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: currentRefreshToken }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Twitch token refresh failed (HTTP ${response.status}); reconnect this channel.`);
    const tokens = await response.json();
    if (!tokens.access_token || !tokens.refresh_token) throw new Error('Twitch returned an incomplete refreshed authorization. Reconnect this channel.');
    currentAccessToken = tokens.access_token;
    currentRefreshToken = tokens.refresh_token;
    await validate();
  }

  async function subscribeToChat(sessionId) {
    const response = await fetchImpl('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentAccessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId },
        transport: { method: 'websocket', session_id: sessionId },
      }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Twitch rejected EventSub subscription (HTTP ${response.status}); check this broadcaster's chat authorization.`);
    const result = await response.json();
    const enabled = result?.data?.some((subscription) => subscription.type === 'channel.chat.message' && subscription.status === 'enabled');
    if (!enabled) throw new Error('Twitch did not confirm an enabled channel chat subscription.');
    setEventSubState('connected', 'enabled');
  }

  function applyChatCommand(senderId, senderName, messageText) {
    if (typeof senderId !== 'string' || !senderId) return { status: 'ignored' };
    match.lifecycle.expireIfDue();
    try {
      const result = applyRoundChatCommand(game.lines, senderId, senderName, messageText,
        match.lifecycle, game.width, game.height, match.joinPlayer);
      return {
        status: result.status,
        ...(result.status === 'applied' ? { action: parseLineupCommand(messageText)?.type || 'command' } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.lineCode ? { lineCode: result.lineCode } : {}),
        ...(result.created !== undefined ? { created: result.created } : {}),
      };
    } catch {
      return { status: 'rejected', reason: 'Command could not be applied.' };
    }
  }

  async function handleChatNotification(envelope) {
    const event = envelope?.payload?.event;
    if (!event || event.broadcaster_user_id !== broadcasterId) return { status: 'wrong-channel' };
    const messageId = envelope.metadata?.message_id;
    if (messageIds.isDuplicate(messageId)) return { status: 'duplicate' };
    const record = {
      receivedAt: new Date().toISOString(), senderId: event.chatter_user_id,
      senderName: event.chatter_user_name, broadcasterId,
      isBroadcaster: event.chatter_user_id === broadcasterId, text: event.message?.text ?? '',
    };
    state.messages.unshift(record);
    state.messages.length = Math.min(state.messages.length, MAX_MESSAGES);
    state.incomingMessagesReceived += 1;
    state.lastIncomingAt = record.receivedAt;
    noteEventSubMessage();
    record.commandOutcome = applyChatCommand(record.senderId, record.senderName, record.text);
    if (record.commandOutcome.status === 'joined') {
      record.gameEvent = `Joined · line code ${record.commandOutcome.lineCode}`;
    } else if (record.commandOutcome.status === 'applied') {
      const labels = { move: 'Line moved', rotate: 'Line rotated around endpoint B', color: 'Line color changed' };
      record.gameEvent = labels[record.commandOutcome.action] || 'Game command applied';
    }
    if (record.commandOutcome.status === 'joined') {
      record.replyStatus = await sender.sendJoinConfirmation(record.senderName, record.commandOutcome.lineCode, event.message_id);
      recordOutgoingResult(record.replyStatus);
    }
    return { status: 'processed', record };
  }

  async function announceRound(roundNumber) {
    lastRoundAnnouncement = { roundNumber, ...(await announcer.announce(match.getPublicState(game).matchNumber, roundNumber)) };
    recordOutgoingResult(lastRoundAnnouncement);
    const activityText = lastRoundAnnouncement.status === 'sent' || lastRoundAnnouncement.status === 'already-sent'
      ? 'Round role-reveal link sent to Twitch chat.'
      : `Round role-reveal announcement ${lastRoundAnnouncement.status}: ${lastRoundAnnouncement.detail || 'Twitch did not confirm sending.'}`;
    addActivity(activityText, lastRoundAnnouncement.status === 'sent' || lastRoundAnnouncement.status === 'already-sent' ? 'success' : 'error');
    return lastRoundAnnouncement;
  }

  function getState() {
    return {
      status: state.status, detail: state.detail, broadcasterId,
      connectedAt: state.connectedAt,
      incomingChat: {
        status: state.status === 'listening' ? (state.incomingMessagesReceived ? 'receiving' : 'subscribed; waiting for messages') : state.status,
        messagesReceived: state.incomingMessagesReceived, lastMessageAt: state.lastIncomingAt,
      },
      outgoingChat: { ...outgoingChat },
      eventSub: {
        connection: state.eventSubConnection,
        subscription: state.eventSubSubscription,
        lastMessageAt: state.lastEventSubMessageAt,
        keepaliveTimeoutMs: state.keepaliveTimeoutMs,
      },
      roundAnnouncement: lastRoundAnnouncement ? { ...lastRoundAnnouncement } : null,
      messages: match.getPublicChatMessages(state.messages),
    };
  }

  return {
    broadcasterId, game, match, state, outgoingChat,
    validate, refreshAuthorization, validateTokenMetadata, subscribeToChat, setStatus,
    handleChatNotification, announceRound, recordOutgoingResult,
    setEventSubState, noteEventSubMessage, addActivity,
    getState,
    getPublicState: () => match.getPublicState(game),
    getHostState: () => match.getHostState(game),
    stop: () => { match.lifecycle.stop(); setEventSubState('disconnected', 'not-created'); },
  };
}
