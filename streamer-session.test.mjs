import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamerSession } from './streamer-session.mjs';

function session(id) {
  return createStreamerSession({
    broadcasterId: id, accessToken: `secret-${id}`, clientId: 'client',
    publicAppUrl: 'https://lineup.example', rolePath: `/role/${id}`,
  });
}

function chat(id, messageId, userId, text) {
  return {
    metadata: { message_type: 'notification', message_id: messageId },
    payload: { event: {
      broadcaster_user_id: id, chatter_user_id: userId,
      chatter_user_name: `viewer-${userId}`, message_id: `chat-${messageId}`,
      message: { text },
    } },
  };
}

test('broadcaster sessions isolate chat commands, state, and public data', async () => {
  const a = session('broadcaster-a');
  const b = session('broadcaster-b');
  for (const [s, prefix] of [[a, 'a'], [b, 'b']]) {
    s.match.joinPlayer(`${prefix}-1`, `Viewer ${prefix}1`);
    s.match.joinPlayer(`${prefix}-2`, `Viewer ${prefix}2`);
    assert.equal(s.match.startRound(s.broadcasterId, s.broadcasterId).status, 'started');
  }

  const lineA = a.game.lines.find((line) => line.ownerUserId === 'a-1');
  const lineB = b.game.lines.find((line) => line.ownerUserId === 'b-1');
  const beforeA = structuredClone(lineA);
  const beforeB = structuredClone(lineB);
  assert.equal((await a.handleChatNotification(chat('broadcaster-a', 'evt-a', 'a-1', '!move 5r'))).status, 'processed');
  assert.notDeepEqual(lineA, beforeA);
  assert.deepEqual(lineB, beforeB);

  assert.equal((await b.handleChatNotification(chat('broadcaster-b', 'evt-b', 'b-1', '!move 5r'))).status, 'processed');
  assert.notDeepEqual(lineB, beforeB);
  assert.equal((await b.handleChatNotification(chat('broadcaster-a', 'evt-wrong', 'b-1', '!move 5r'))).status, 'wrong-channel');

  const publicA = JSON.stringify({ state: a.getPublicState(), status: a.getState() });
  const publicB = JSON.stringify({ state: b.getPublicState(), status: b.getState() });
  assert.ok(!publicA.includes('secret-broadcaster-a'));
  assert.ok(!publicB.includes('secret-broadcaster-b'));
  assert.notEqual(a.game, b.game);
  a.stop(); b.stop();
});

test('a duplicate Twitch EventSub message ID cannot apply twice', async () => {
  const s = session('broadcaster-d');
  s.match.joinPlayer('viewer-d1');
  s.match.joinPlayer('viewer-d2');
  s.match.startRound(s.broadcasterId, s.broadcasterId);
  const line = s.game.lines.find((item) => item.ownerUserId === 'viewer-d1');
  const original = structuredClone(line);
  const envelope = chat(s.broadcasterId, 'same-event', 'viewer-d1', '!move 3r');
  assert.equal((await s.handleChatNotification(envelope)).status, 'processed');
  assert.equal((await s.handleChatNotification(envelope)).status, 'duplicate');
  assert.equal(line.a.x - original.a.x, 3);
  assert.equal(line.b.x - original.b.x, 3);
  s.stop();
});

test('each session sends join replies only with its own broadcaster token and IDs', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ data: [{ is_sent: true }] }) };
  };
  const a = createStreamerSession({ broadcasterId: 'broadcaster-x', accessToken: 'private-x', clientId: 'client', publicAppUrl: 'https://lineup.example', rolePath: '/role/x', fetchImpl });
  const b = createStreamerSession({ broadcasterId: 'broadcaster-y', accessToken: 'private-y', clientId: 'client', publicAppUrl: 'https://lineup.example', rolePath: '/role/y', fetchImpl });
  for (const s of [a, b]) s.validateTokenMetadata({ client_id: 'client', user_id: s.broadcasterId, scopes: ['user:read:chat', 'user:write:chat'] });
  await a.handleChatNotification(chat('broadcaster-x', 'join-x', 'viewer-x', '!join'));
  await b.handleChatNotification(chat('broadcaster-y', 'join-y', 'viewer-y', '!join'));
  assert.equal(requests.length, 2);
  const bodies = requests.map(({ options }) => JSON.parse(options.body));
  assert.deepEqual(bodies.map(({ broadcaster_id, sender_id }) => [broadcaster_id, sender_id]), [
    ['broadcaster-x', 'broadcaster-x'], ['broadcaster-y', 'broadcaster-y'],
  ]);
  assert.deepEqual(requests.map(({ options }) => options.headers.Authorization), ['Bearer private-x', 'Bearer private-y']);
  assert.match(bodies[0].message, new RegExp(a.game.lines[0].code));
  assert.match(bodies[1].message, new RegExp(b.game.lines[0].code));
  a.stop(); b.stop();
});

test('an OAuth session refreshes and rotates credentials without exposing them in public state', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }) };
    return { ok: true, json: async () => ({ client_id: 'client', user_id: 'broadcaster-r', scopes: ['user:read:chat', 'user:write:chat'] }) };
  };
  const s = createStreamerSession({ broadcasterId: 'broadcaster-r', accessToken: 'expired-access', refreshToken: 'original-refresh', clientId: 'client', clientSecret: 'private-client-secret', publicAppUrl: 'https://lineup.example', rolePath: '/role/r', fetchImpl });
  await s.refreshAuthorization();
  assert.equal(requests[0].options.body.get('refresh_token'), 'original-refresh');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer rotated-access');
  assert.ok(!JSON.stringify({ state: s.getState(), game: s.getPublicState() }).includes('rotated-access'));
  assert.ok(!JSON.stringify({ state: s.getState(), game: s.getPublicState() }).includes('rotated-refresh'));
  s.stop();
});

test('chat activity shows line assignment and applied movement while remaining channel-scoped', async () => {
  const a = session('broadcaster-activity-a');
  const b = session('broadcaster-activity-b');
  const joinedA = await a.handleChatNotification(chat(a.broadcasterId, 'join-activity-a', 'viewer-a', '!join'));
  await a.handleChatNotification(chat(a.broadcasterId, 'join-activity-a2', 'viewer-a2', '!join'));
  await b.handleChatNotification(chat(b.broadcasterId, 'join-activity-b', 'viewer-b', '!join'));
  assert.match(joinedA.record.gameEvent, /^Joined · line code [A-Z]{3}[0-9]{3}$/);
  a.match.startRound(a.broadcasterId, a.broadcasterId);
  await a.handleChatNotification(chat(a.broadcasterId, 'move-activity-a', 'viewer-a', '!move 5r'));
  await a.handleChatNotification(chat(a.broadcasterId, 'rotate-activity-a', 'viewer-a', '!rotate 45'));
  await a.handleChatNotification(chat(a.broadcasterId, 'color-activity-a', 'viewer-a', '!color blue'));
  const events = a.getState().messages.map((message) => message.gameEvent).filter(Boolean);
  assert.ok(events.includes('Line moved'));
  assert.ok(events.includes('Line rotated around endpoint B'));
  assert.ok(events.includes('Line color changed'));
  assert.ok(!b.getState().messages.some((message) => message.senderId === 'viewer-a'));
  a.stop(); b.stop();
});

test('round start announcement uses the current round link once and records send status', async () => {
  const requests = [];
  const s = createStreamerSession({
    broadcasterId: 'broadcaster-announce', accessToken: 'private-token', clientId: 'client',
    publicAppUrl: 'https://lineup.example', rolePath: '/role/session-link',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ data: [{ is_sent: true }] }) };
    },
  });
  s.validateTokenMetadata({ client_id: 'client', user_id: s.broadcasterId, scopes: ['user:read:chat', 'user:write:chat'] });
  s.match.joinPlayer('viewer-one'); s.match.joinPlayer('viewer-two');
  const started = s.match.startRound(s.broadcasterId, s.broadcasterId);
  const announcement = await s.announceRound(started.roundNumber);
  const targetWord = s.match.drawRole().targetWord;
  const repeated = await s.announceRound(started.roundNumber);
  assert.equal(announcement.status, 'sent');
  assert.equal(repeated.status, 'already-sent');
  assert.equal(requests.length, 1);
  const message = JSON.parse(requests[0].options.body).message;
  assert.match(message, /https:\/\/lineup\.example\/role\/session-link/);
  assert.ok(!message.toLowerCase().includes(targetWord));
  assert.equal(s.getState().roundAnnouncement.status, 'already-sent');
  assert.ok(s.getState().messages.some((item) => item.activity === 'success'));
  s.stop();
});

test('announcement blockers and Twitch send failures remain explicit and are never marked sent', async () => {
  const noUrl = createStreamerSession({ broadcasterId: 'broadcaster-no-url', accessToken: 'token', clientId: 'client', rolePath: '/role/no-url' });
  noUrl.validateTokenMetadata({ client_id: 'client', user_id: noUrl.broadcasterId, scopes: ['user:read:chat', 'user:write:chat'] });
  noUrl.match.joinPlayer('one'); noUrl.match.joinPlayer('two');
  const round = noUrl.match.startRound(noUrl.broadcasterId, noUrl.broadcasterId);
  assert.equal((await noUrl.announceRound(round.roundNumber)).status, 'missing-public-url');
  assert.equal(noUrl.getState().roundAnnouncement.detail.includes('PUBLIC_APP_URL'), true);
  noUrl.stop();

  const failed = createStreamerSession({
    broadcasterId: 'broadcaster-send-fail', accessToken: 'token', clientId: 'client',
    publicAppUrl: 'https://lineup.example', rolePath: '/role/fail',
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  failed.validateTokenMetadata({ client_id: 'client', user_id: failed.broadcasterId, scopes: ['user:read:chat', 'user:write:chat'] });
  failed.match.joinPlayer('one'); failed.match.joinPlayer('two');
  const failedRound = failed.match.startRound(failed.broadcasterId, failed.broadcasterId);
  const send = await failed.announceRound(failedRound.roundNumber);
  assert.equal(send.status, 'twitch-error');
  assert.notEqual(send.status, 'sent');
  assert.equal(failed.getState().roundAnnouncement.status, 'twitch-error');
  failed.stop();
});

test('only a validated enabled EventSub chat subscription is reported connected', async () => {
  const s = createStreamerSession({
    broadcasterId: 'broadcaster-subscription', accessToken: 'token', clientId: 'client',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ type: 'channel.chat.message', status: 'enabled' }] }) }),
  });
  await s.subscribeToChat('eventsub-session');
  assert.equal(s.getState().eventSub.subscription, 'enabled');
  s.setEventSubState('connected', 'enabled', 10000);
  s.stop();
  assert.equal(s.getState().eventSub.connection, 'disconnected');
  s.setEventSubState('connected', 'enabled', 10000);
  assert.equal(s.getState().eventSub.connection, 'connected');
  s.stop();
});

test('stopping one broadcaster session leaves another broadcaster session connected', () => {
  const a = session('broadcaster-stop-a');
  const b = session('broadcaster-stop-b');
  a.setEventSubState('connected', 'enabled', 10000);
  b.setEventSubState('connected', 'enabled', 10000);
  a.stop();
  assert.equal(a.getState().eventSub.connection, 'disconnected');
  assert.equal(b.getState().eventSub.connection, 'connected');
  b.stop();
});
