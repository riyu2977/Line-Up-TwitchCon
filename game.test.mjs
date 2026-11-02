import test from 'node:test';
import assert from 'node:assert/strict';
import { addPlayerLine, applyOwnedAction, moveLine, rotateLine } from './game.mjs';
import { applyPlayerCommand, applyRoundChatCommand, parseLineupCommand } from './commands.mjs';
import { createMessageDeduplicator, createRoundLifecycle, DEFAULT_ROUND_DURATION_MS, makePublicGameState } from './round.mjs';
import { getHostAccessMode, getHostActionIdentity, invalidateHostSession } from './host-auth.mjs';
import { createTwitchChatSender } from './twitch-chat.mjs';
import { createRoundAnnouncer, isPublicHttpsOrigin } from './chat-announcements.mjs';
import { assessBroadcasterChatToken } from './twitch-auth.mjs';

function line(id, ownerUserId, a, b) {
  return { id, ownerUserId, color: '#ff6fcf', a: { ...a }, b: { ...b } };
}

test('translation moves both endpoints equally and preserves length', () => {
  const lines = [line('one', 'viewer-a', { x: 60, y: 50 }, { x: 50, y: 50 })];
  moveLine(lines, 'one', -10, 5);
  assert.deepEqual(lines[0].a, { x: 50, y: 55 });
  assert.deepEqual(lines[0].b, { x: 40, y: 55 });
  assert.equal(Math.hypot(lines[0].a.x - lines[0].b.x, lines[0].a.y - lines[0].b.y), 10);
});

test('positive 90 degree rotation is clockwise on screen around fixed B', () => {
  const lines = [line('one', 'viewer-a', { x: 60, y: 50 }, { x: 50, y: 50 })];
  rotateLine(lines, 'one', 90);
  assert.deepEqual(lines[0].a, { x: 50, y: 60 });
  assert.deepEqual(lines[0].b, { x: 50, y: 50 });
  assert.equal(Math.hypot(lines[0].a.x - lines[0].b.x, lines[0].a.y - lines[0].b.y), 10);
});

test('rotation rejects a line endpoint leaving the canvas without mutating geometry', () => {
  const lines = [line('one', 'viewer-a', { x: 95, y: 50 }, { x: 95, y: 40 })];
  const before = structuredClone(lines);
  assert.throws(() => rotateLine(lines, 'one', -90), /leave the canvas/);
  assert.deepEqual(lines, before);
});

test('command parser accepts requested commands and rejects malformed or unsupported arguments', () => {
  assert.deepEqual(parseLineupCommand('!join'), { type: 'join' });
  assert.deepEqual(parseLineupCommand('!move 30l'), { type: 'move', dx: -30, dy: 0 });
  assert.deepEqual(parseLineupCommand('!move 30r'), { type: 'move', dx: 30, dy: 0 });
  assert.deepEqual(parseLineupCommand('!move 40u'), { type: 'move', dx: 0, dy: -40 });
  assert.deepEqual(parseLineupCommand('!move 40d'), { type: 'move', dx: 0, dy: 40 });
  assert.deepEqual(parseLineupCommand('!rotate 45'), { type: 'rotate', degrees: 45 });
  assert.deepEqual(parseLineupCommand('!color blue'), { type: 'color', value: '#4b87ff', colorName: 'blue' });
  assert.equal(parseLineupCommand('hello chat'), null);
  assert.equal(parseLineupCommand('!move 0l').type, 'invalid');
  assert.equal(parseLineupCommand('!move 101r').type, 'invalid');
  assert.equal(parseLineupCommand('!move 5 left').type, 'invalid');
  assert.equal(parseLineupCommand('!rotate nope').type, 'invalid');
  assert.equal(parseLineupCommand('!rotate 3601').type, 'invalid');
  assert.equal(parseLineupCommand('!color ultraviolet').type, 'invalid');
});

test('two viewers can change only the line owned by their Twitch user ID', () => {
  const lines = [
    line('line-a', '1001', { x: 20, y: 20 }, { x: 10, y: 20 }),
    line('line-b', '2002', { x: 60, y: 40 }, { x: 50, y: 40 }),
  ];
  assert.deepEqual(applyPlayerCommand(lines, '1001', '!move 5r', 100, 100), { status: 'applied', lineId: 'line-a' });
  assert.deepEqual(lines[0].a, { x: 25, y: 20 });
  assert.deepEqual(lines[1].a, { x: 60, y: 40 });
  const before = structuredClone(lines);
  assert.equal(applyPlayerCommand(lines, '1001', '!move 5l line-b', 100, 100).status, 'rejected');
  assert.deepEqual(lines, before);
  assert.equal(applyOwnedAction(lines, '2002', { type: 'color', value: '#4b87ff' }).id, 'line-b');
  assert.equal(lines[1].color, '#4b87ff');
  assert.equal(lines[0].color, '#ff6fcf');
});

test('join creates one owned line per Twitch user and duplicate joins do not add lines', () => {
  const lines = [];
  const first = addPlayerLine(lines, '1001', 'Viewer A');
  const duplicate = addPlayerLine(lines, '1001', 'Viewer A');
  const second = addPlayerLine(lines, '2002', 'Viewer B');
  const third = addPlayerLine(lines, '3003', 'Viewer C');
  const fourth = addPlayerLine(lines, '4004', 'Viewer D');
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(second.created, true);
  assert.equal(third.created, true);
  assert.equal(fourth.created, true);
  assert.equal(lines.length, 4);
  assert.equal(new Set(lines.map((item) => item.id)).size, 4);
  assert.equal(lines[0].ownerUserId, '1001');
  assert.equal(lines[1].ownerUserId, '2002');
  assert.equal(lines[2].ownerUserId, '3003');
  assert.equal(lines[3].ownerUserId, '4004');
  assert.equal(Math.hypot(lines[0].a.x - lines[0].b.x, lines[0].a.y - lines[0].b.y), 10);
  assert.deepEqual(lines[0].a, { x: 20, y: 20 });
  assert.deepEqual(lines[1].a, { x: 60, y: 40 });
  assert.deepEqual(lines[2].a, { x: 80, y: 80 });
  assert.deepEqual(lines[3].a, { x: 20, y: 20 });
});

test('invalid commands and out-of-bounds moves leave line geometry unchanged', () => {
  const lines = [line('line-a', '1001', { x: 95, y: 50 }, { x: 85, y: 50 })];
  const before = structuredClone(lines);
  assert.equal(applyPlayerCommand(lines, '1001', '!move 10r', 100, 100).status, 'rejected');
  assert.deepEqual(lines, before);
  assert.equal(applyPlayerCommand(lines, '1001', '!color not-a-color', 100, 100).status, 'rejected');
  assert.deepEqual(lines, before);
  assert.equal(applyPlayerCommand(lines, 'unknown-user', '!move 1l', 100, 100).status, 'rejected');
  assert.deepEqual(lines, before);
});

function fakeClock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  const cleared = [];
  return {
    timers,
    cleared,
    now: () => time,
    setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => { cleared.push(id); timers.delete(id); },
    advance: (ms) => { time += ms; for (const [id, timer] of [...timers]) { if (timer.delay <= ms) { timers.delete(id); timer.callback(); } } },
  };
}

test('round lifecycle starts in lobby and uses the configurable three-minute default', () => {
  const lines = [];
  const lifecycle = createRoundLifecycle({ lines });
  assert.equal(lifecycle.getPhase(), 'lobby');
  assert.equal(lifecycle.getRemainingMs(), 0);
  assert.equal(DEFAULT_ROUND_DURATION_MS, 180000);
});

test('only broadcaster identity can start and reset', () => {
  const lines = [];
  const lifecycle = createRoundLifecycle({ lines });
  assert.deepEqual(lifecycle.start('viewer-1', 'broadcaster'), { status: 'unauthorized' });
  assert.equal(lifecycle.getPhase(), 'lobby');
  assert.deepEqual(lifecycle.start('broadcaster', 'broadcaster'), { status: 'started' });
  assert.deepEqual(lifecycle.reset('viewer-1', 'broadcaster'), { status: 'unauthorized' });
  assert.equal(lifecycle.getPhase(), 'active');
  assert.deepEqual(lifecycle.reset('broadcaster', 'broadcaster'), { status: 'reset' });
  assert.equal(lifecycle.getPhase(), 'lobby');
});

test('lobby accepts joins, and starting freezes participation', () => {
  const lines = [];
  const lifecycle = createRoundLifecycle({ lines });
  assert.equal(lifecycle.canJoin(), true);
  assert.equal(applyRoundChatCommand(lines, 'viewer-1', 'Viewer', '!join', lifecycle).status, 'joined');
  lifecycle.start('broadcaster', 'broadcaster');
  assert.equal(lifecycle.canJoin(), false);
  assert.equal(applyRoundChatCommand(lines, 'viewer-2', 'Viewer 2', '!join', lifecycle).status, 'rejected');
  assert.equal(lines.length, 1);
  lifecycle.stop();
});

test('gameplay is accepted only while active and rejected after timeout', () => {
  const clock = fakeClock();
  const lines = [];
  const lifecycle = createRoundLifecycle({ lines, durationMs: 1000, ...clock });
  applyRoundChatCommand(lines, 'viewer-1', 'Viewer', '!join', lifecycle);
  assert.equal(applyRoundChatCommand(lines, 'viewer-1', 'Viewer', '!move 1r', lifecycle, 100, 100).status, 'rejected');
  lifecycle.start('broadcaster', 'broadcaster');
  assert.equal(lifecycle.canPlay(), true);
  assert.equal(applyRoundChatCommand(lines, 'viewer-1', 'Viewer', '!move 1r', lifecycle, 100, 100).status, 'applied');
  clock.advance(1000);
  assert.equal(lifecycle.getPhase(), 'ended');
  assert.equal(lifecycle.canPlay(), false);
  const before = structuredClone(lines);
  assert.equal(applyRoundChatCommand(lines, 'viewer-1', 'Viewer', '!move 1r', lifecycle, 100, 100).status, 'rejected');
  assert.deepEqual(lines, before);
});

test('round timeout transitions to ended even when timer callback is delayed', () => {
  let time = 0;
  const lifecycle = createRoundLifecycle({ lines: [], durationMs: 500, now: () => time, setTimer: () => 1, clearTimer: () => {} });
  lifecycle.start('broadcaster', 'broadcaster');
  time = 501;
  assert.equal(lifecycle.getPhase(), 'ended');
});

test('reset clears lines and pending timer; stop clears a running timer', () => {
  const clock = fakeClock();
  const lines = [];
  const lifecycle = createRoundLifecycle({ lines, durationMs: 500, ...clock });
  lifecycle.start('broadcaster', 'broadcaster');
  addPlayerLine(lines, 'viewer-1');
  const timerId = [...clock.timers.keys()][0];
  assert.deepEqual(lifecycle.reset('broadcaster', 'broadcaster'), { status: 'reset' });
  assert.equal(lines.length, 0);
  assert.deepEqual(clock.cleared, [timerId]);
  assert.equal(clock.timers.size, 0);
  lifecycle.start('broadcaster', 'broadcaster');
  lifecycle.stop();
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.cleared.length, 2);
});

test('duplicate Twitch message IDs are ignored while distinct and missing IDs are allowed', () => {
  const dedupe = createMessageDeduplicator();
  assert.equal(dedupe.isDuplicate('twitch-message-1'), false);
  assert.equal(dedupe.isDuplicate('twitch-message-1'), true);
  assert.equal(dedupe.isDuplicate('twitch-message-2'), false);
  assert.equal(dedupe.isDuplicate(undefined), false);
});

test('public game state exposes phase, time and lines without owner or secret fields', () => {
  const lines = [{ ...line('line-a', 'private-owner-id', { x: 1, y: 2 }, { x: 3, y: 4 }), team: 'secret-team', targetWord: 'secret-word', accessToken: 'secret-token' }];
  const clock = fakeClock();
  const lifecycle = createRoundLifecycle({ lines, durationMs: 5000, ...clock });
  lifecycle.start('broadcaster', 'broadcaster');
  const publicState = makePublicGameState({ width: 100, height: 100, lines }, lifecycle);
  assert.deepEqual(Object.keys(publicState).sort(), ['height', 'lines', 'phase', 'remainingMs', 'width']);
  assert.equal(publicState.phase, 'active');
  assert.equal(publicState.remainingMs, 5000);
  assert.deepEqual(Object.keys(publicState.lines[0]).sort(), ['a', 'b', 'code', 'color', 'id', 'label']);
  assert.equal(JSON.stringify(publicState).includes('secret'), false);
  lifecycle.stop();
});

test('local host bypass requires both development mode and the explicit true flag', () => {
  assert.equal(getHostAccessMode({ NODE_ENV: 'development', ENABLE_LOCAL_DEV_HOST: 'true' }, null, 'broadcaster'), 'development');
  assert.equal(getHostAccessMode({ NODE_ENV: 'development' }, null, 'broadcaster'), null);
  assert.equal(getHostAccessMode({ NODE_ENV: 'development', ENABLE_LOCAL_DEV_HOST: 'false' }, null, 'broadcaster'), null);
  assert.equal(getHostAccessMode({ NODE_ENV: 'production', ENABLE_LOCAL_DEV_HOST: 'true' }, null, 'broadcaster'), null);
  assert.equal(getHostAccessMode({ ENABLE_LOCAL_DEV_HOST: 'true' }, null, 'broadcaster'), null);
});

test('join confirmation sends only with explicit chat-write authorization and cannot parse as a game command', async () => {
  let request;
  const sender = createTwitchChatSender({
    clientId: 'client-test', accessToken: 'token-test', broadcasterId: 'broadcaster-test', enabled: true,
    fetchImpl: async (...args) => { request = args; return { ok: true, status: 200, json: async () => ({ data: [{ is_sent: true }] }) }; },
  });
  assert.deepEqual(await sender.sendJoinConfirmation('butterscotch07', 'ABC123', 'event-message-7'), { status: 'sent', detail: 'Twitch confirmed the message was sent.' });
  assert.equal(request[0], 'https://api.twitch.tv/helix/chat/messages');
  const options = request[1];
  assert.equal(options.headers.Authorization, 'Bearer token-test');
  assert.equal(options.headers['Client-Id'], 'client-test');
  const body = JSON.parse(options.body);
  assert.equal(body.sender_id, 'broadcaster-test');
  assert.equal(body.broadcaster_id, 'broadcaster-test');
  assert.equal(body.reply_parent_message_id, 'event-message-7');
  assert.match(body.message, /@butterscotch07 Your line code is ABC123\./);
  assert.equal(parseLineupCommand(body.message), null);
  assert.equal((await createTwitchChatSender({ enabled: false }).sendJoinConfirmation('Viewer', 'ABC123')).status, 'missing-scope');
  const failedSender = createTwitchChatSender({
    clientId: 'client-test', accessToken: 'token-test', broadcasterId: 'broadcaster-test', enabled: true,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ is_sent: false }] }) }),
  });
  assert.equal((await failedSender.sendJoinConfirmation('Viewer', 'ABC123')).status, 'not-sent');
  for (const [httpStatus, expected] of [[401, 'invalid-token'], [403, 'forbidden'], [429, 'rate-limited']]) {
    const apiFailure = createTwitchChatSender({
      clientId: 'client-test', accessToken: 'token-test', broadcasterId: 'broadcaster-test', enabled: true,
      fetchImpl: async () => ({ ok: false, status: httpStatus }),
    });
    assert.equal((await apiFailure.sendJoinConfirmation('Viewer', 'ABC123')).status, expected);
  }
});

test('validated Twitch token must match the client and broadcaster; write scope is separate from incoming chat', () => {
  const token = { client_id: 'client-1', user_id: 'broadcaster-1', scopes: ['user:read:chat'] };
  const base = { clientId: 'client-1', broadcasterId: 'broadcaster-1' };
  assert.deepEqual(assessBroadcasterChatToken(token, base), {
    status: 'missing-write-scope', ok: true, canRead: true, canWrite: false,
    senderMatchesBroadcaster: true, detail: 'The token is valid for this broadcaster but lacks user:write:chat.',
  });
  assert.equal(assessBroadcasterChatToken({ ...token, scopes: ['user:read:chat', 'user:write:chat'] }, base).status, 'authorized');
  assert.equal(assessBroadcasterChatToken({ ...token, user_id: 'someone-else' }, base).status, 'broadcaster-mismatch');
  assert.equal(assessBroadcasterChatToken({ ...token, client_id: 'other-client' }, base).status, 'client-id-mismatch');
  assert.equal(assessBroadcasterChatToken({ ...token, scopes: [] }, base).status, 'missing-read-scope');
});

test('public origin validation rejects local/private origins and accepts a public HTTPS origin', () => {
  assert.equal(isPublicHttpsOrigin('https://lineup-demo.com'), true);
  for (const url of [
    'http://lineup-demo.com', 'https://localhost:3000', 'https://127.0.0.1:3000',
    'https://10.0.0.4', 'https://192.168.1.8', 'https://172.20.0.1',
    'https://169.254.2.3', 'https://[::1]', 'https://[fd00::1]', 'https://lineup.local',
  ]) assert.equal(isPublicHttpsOrigin(url), false, url);
});

test('round announcement uses the configured public HTTPS role URL exactly once and never substitutes localhost', async () => {
  const posted = [];
  const sender = { announceRound: async (url) => { posted.push(url); return { status: 'sent', detail: 'Twitch confirmed the message was sent.' }; } };
  const announcer = createRoundAnnouncer({ sender, publicAppUrl: 'https://lineup-demo.com', rolePath: '/role/secret-session-link' });
  assert.deepEqual(await announcer.announce(1, 1), { status: 'sent', detail: 'Twitch confirmed the message was sent.' });
  assert.deepEqual(await announcer.announce(1, 1), { status: 'already-sent', detail: 'Twitch already confirmed this round announcement.' });
  assert.deepEqual(posted, ['https://lineup-demo.com/role/secret-session-link']);

  const missingUrl = createRoundAnnouncer({ sender, rolePath: '/role/secret-session-link' });
  assert.equal((await missingUrl.announce(1, 2)).status, 'missing-public-url');
  assert.equal(posted.some((url) => /localhost|127\.0\.0\.1/.test(url)), false);
  const insecureUrl = createRoundAnnouncer({ sender, publicAppUrl: 'http://localhost:3000', rolePath: '/role/x' });
  assert.equal((await insecureUrl.announce(1, 3)).status, 'invalid-public-url');
  const httpsLocalhost = createRoundAnnouncer({ sender, publicAppUrl: 'https://localhost:3000', rolePath: '/role/x' });
  assert.equal((await httpsLocalhost.announce(1, 4)).status, 'invalid-public-url');
  const httpsLoopback = createRoundAnnouncer({ sender, publicAppUrl: 'https://127.0.0.1:3000', rolePath: '/role/x' });
  assert.equal((await httpsLoopback.announce(1, 5)).status, 'invalid-public-url');
  const privateAddress = createRoundAnnouncer({ sender, publicAppUrl: 'https://10.1.2.3', rolePath: '/role/x' });
  assert.equal((await privateAddress.announce(1, 6)).status, 'invalid-public-url');
});

test('failed role announcements are not marked sent and duplicate delivery attempts are suppressed', async () => {
  let attempts = 0;
  const announcer = createRoundAnnouncer({
    sender: { announceRound: async () => { attempts += 1; return { status: 'network-error', detail: 'Could not reach Twitch.' }; } },
    publicAppUrl: 'https://lineup-demo.com', rolePath: '/role/session',
  });
  assert.equal((await announcer.announce(1, 1)).status, 'network-error');
  assert.equal((await announcer.announce(1, 1)).status, 'network-error');
  assert.equal(attempts, 1);
});

test('broadcaster OAuth sessions remain valid independently of the development gate', () => {
  assert.equal(getHostAccessMode({ NODE_ENV: 'development', ENABLE_LOCAL_DEV_HOST: 'true' }, { userId: 'viewer' }, 'broadcaster'), 'development');
  assert.equal(getHostAccessMode({ NODE_ENV: 'production', ENABLE_LOCAL_DEV_HOST: 'true' }, { userId: 'broadcaster' }, 'broadcaster'), 'broadcaster');
});

test('host authorization is bound to the authenticated broadcaster identity', () => {
  assert.deepEqual(getHostActionIdentity({ NODE_ENV: 'production' }, { userId: 'channel-a' }, 'channel-a'), { accessMode: 'broadcaster', userId: 'channel-a' });
  assert.equal(getHostActionIdentity({ NODE_ENV: 'production' }, { userId: 'channel-a' }, 'channel-b'), null);
});

test('signing out removes the browser host session so host actions no longer authorize', () => {
  const hostSessions = new Map([['cookie-session', { userId: 'broadcaster-a', broadcasterId: 'broadcaster-a' }]]);
  assert.equal(getHostActionIdentity({ NODE_ENV: 'production' }, hostSessions.get('cookie-session'), 'broadcaster-a').userId, 'broadcaster-a');
  assert.equal(invalidateHostSession(hostSessions, 'cookie-session'), true);
  assert.equal(hostSessions.get('cookie-session'), undefined);
  assert.equal(getHostActionIdentity({ NODE_ENV: 'production' }, hostSessions.get('cookie-session'), 'broadcaster-a'), null);
});

test('development host start and reset work without an OAuth session', () => {
  const lines = [];
  addPlayerLine(lines, 'viewer-1');
  const rounds = createRoundLifecycle({ lines });
  const env = { NODE_ENV: 'development', ENABLE_LOCAL_DEV_HOST: 'true' };
  const hostIdentity = getHostActionIdentity(env, null, 'broadcaster');
  assert.deepEqual(hostIdentity, { accessMode: 'development', userId: 'broadcaster' });
  assert.deepEqual(rounds.start(hostIdentity.userId, 'broadcaster'), { status: 'started' });
  assert.equal(rounds.getPhase(), 'active');
  assert.deepEqual(rounds.reset(hostIdentity.userId, 'broadcaster'), { status: 'reset' });
  assert.equal(rounds.getPhase(), 'lobby');
  assert.equal(lines.length, 0);
});

test('start and reset remain unauthorized without OAuth when the development gate is disabled', () => {
  const lines = [];
  addPlayerLine(lines, 'viewer-1');
  const rounds = createRoundLifecycle({ lines });
  const before = structuredClone(lines);
  const hostIdentity = getHostActionIdentity({ NODE_ENV: 'development', ENABLE_LOCAL_DEV_HOST: 'false' }, null, 'broadcaster');
  assert.equal(hostIdentity, null);
  assert.equal(rounds.start(hostIdentity?.userId, 'broadcaster').status, 'unauthorized');
  assert.equal(rounds.getPhase(), 'lobby');
  assert.equal(rounds.reset(hostIdentity?.userId, 'broadcaster').status, 'unauthorized');
  assert.deepEqual(lines, before);
});
