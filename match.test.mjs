import test from 'node:test';
import assert from 'node:assert/strict';
import { addPlayerLine } from './game.mjs';
import { applyRoundChatCommand } from './commands.mjs';
import { createMatchGame, normalizeGuess } from './match.mjs';
import { createRoleAllocation } from './role-allocation.mjs';
import { lineCodeAt, generateUniqueLineCode } from './line-codes.mjs';
import { createTwitchChatSender } from './twitch-chat.mjs';
import { WORD_BANK, validateWordBank } from './word-bank.mjs';

function fakeClock() {
  let time = 0; let nextId = 0;
  const timers = new Map();
  return {
    timers,
    now: () => time,
    setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance: (ms) => { time += ms; for (const [id, timer] of [...timers]) if (timer.delay <= ms) { timers.delete(id); timer.callback(); } },
  };
}
function addPlayers(lines, ids = ['viewer-a', 'viewer-b']) {
  for (const [index, id] of ids.entries()) addPlayerLine(lines, id, `Viewer ${index + 1}`);
}
function makeGame(lines = [], overrides = {}) {
  return createMatchGame({ lines, words: ['apple', 'bridge'], durationMs: 1000, ...fakeClock(), random: () => 0, ...overrides });
}

test('role pool scales to any participant count and consumes one slot per draw', () => {
  for (const [count, expectedSaboteurs] of [[1, 0], [2, 1], [3, 1], [5, 2], [10, 3], [17, 5], [50, 15]]) {
    const pool = createRoleAllocation(count, () => 0.25);
    const roles = Array.from({ length: count }, () => pool.draw().role);
    assert.equal(roles.filter((role) => role === 'saboteur').length, expectedSaboteurs);
    assert.equal(pool.draw().status, 'exhausted');
    assert.equal(pool.getCounters().remaining, 0);
  }
});

test('role draw order is randomized while the fixed 10-player allocation remains 7 to 3', () => {
  const readOrder = (random) => {
    const pool = createRoleAllocation(10, random);
    return Array.from({ length: 10 }, () => pool.draw().role);
  };
  const orderA = readOrder(() => 0);
  const orderB = readOrder(() => 0.99);
  assert.notDeepEqual(orderA, orderB);
  for (const order of [orderA, orderB]) {
    assert.equal(order.filter((role) => role === 'builder').length, 7);
    assert.equal(order.filter((role) => role === 'saboteur').length, 3);
  }
});

test('shared role draw requires an active round and has no player identity mapping', () => {
  const lines = []; const game = makeGame(lines); addPlayers(lines);
  assert.equal(game.drawRole().status, 'invalid-phase');
  assert.equal(game.startRound('broadcaster', 'broadcaster').status, 'started');
  const one = game.drawRole(); const two = game.drawRole();
  assert.equal(one.status, 'assigned'); assert.equal(two.status, 'assigned');
  assert.equal(one.targetWord, two.targetWord);
  assert.equal('userId' in one, false);
  assert.equal(game.drawRole().status, 'exhausted');
});

test('every click from the same browser consumes a fresh role slot until the pool is exhausted', () => {
  const lines = []; const game = makeGame(lines); addPlayers(lines, Array.from({ length: 10 }, (_, index) => `viewer-${index}`));
  game.startRound('broadcaster', 'broadcaster');
  const clicks = Array.from({ length: 10 }, () => game.drawRole('same-browser-cookie'));
  assert.ok(clicks.every((draw) => draw.status === 'assigned'));
  assert.equal(clicks.filter((draw) => draw.role === 'builder').length, 7);
  assert.equal(clicks.filter((draw) => draw.role === 'saboteur').length, 3);
  assert.ok(clicks.every((draw) => draw.targetWord === clicks[0].targetWord));
  assert.equal(game.drawRole('same-browser-cookie').status, 'exhausted');
});

test('simultaneous draws from one browser consume distinct slots and cannot over-allocate', async () => {
  const lines = []; const game = makeGame(lines);
  addPlayers(lines, Array.from({ length: 10 }, (_, index) => `viewer-${index}`));
  game.startRound('broadcaster', 'broadcaster');
  const results = await Promise.all(Array.from({ length: 11 }, (_, index) =>
    Promise.resolve().then(() => game.drawRole(index < 10 ? 'same-browser' : 'another-browser'))));
  assert.equal(results.filter((result) => result.status === 'assigned').length, 10);
  assert.equal(results.filter((result) => result.status === 'exhausted').length, 1);
  assert.equal(results.filter((result) => result.role === 'builder').length, 7);
  assert.equal(results.filter((result) => result.role === 'saboteur').length, 3);
});

test('role slots are discarded when the round ends and regenerated for the next round', () => {
  const lines = []; const game = makeGame(lines); addPlayers(lines);
  game.startRound('broadcaster', 'broadcaster');
  assert.equal(game.drawRole('persistent-browser').status, 'assigned');
  const target = game.drawRole().targetWord;
  assert.equal(game.submitGuess('broadcaster', 'broadcaster', target).status, 'correct');
  assert.equal(game.drawRole().status, 'invalid-phase');
  game.nextRound('broadcaster', 'broadcaster');
  assert.equal(game.startRound('broadcaster', 'broadcaster').status, 'started');
  assert.equal(game.drawRole('persistent-browser').status, 'assigned');
});

test('guess normalization and round resolution work without exposing the answer during active play', () => {
  assert.equal(normalizeGuess('  HELLO   World '), 'hello world');
  const lines = []; const game = makeGame(lines); addPlayers(lines);
  game.startRound('broadcaster', 'broadcaster');
  const role = game.drawRole();
  const activePublic = game.getPublicState({ width: 100, height: 100, lines });
  const serialized = JSON.stringify(activePublic);
  assert.equal(serialized.includes(role.targetWord), false);
  assert.equal(serialized.includes('builder'), false);
  assert.equal(serialized.includes('saboteur'), false);
  assert.equal(game.getHostState({ width: 100, height: 100, lines }).result, null);
  assert.equal(game.submitGuess('broadcaster', 'broadcaster', 'banana').status, 'incorrect');
  assert.equal(game.submitGuess('broadcaster', 'broadcaster', ` ${role.targetWord.toUpperCase()} `).status, 'correct');
  const ended = game.getPublicState({ width: 100, height: 100, lines });
  assert.equal('answer' in ended.result, false);
  assert.equal(JSON.stringify(ended).includes(role.targetWord), false);
  assert.equal('leaderboard' in ended, false);
});

test('timeout ends for Saboteurs; public result reveals answer only after end', () => {
  const lines = []; const clock = fakeClock();
  const game = createMatchGame({ lines, words: ['apple'], durationMs: 1000, ...clock, random: () => 0 });
  addPlayers(lines); game.startRound('broadcaster', 'broadcaster');
  const target = game.drawRole().targetWord;
  assert.equal(JSON.stringify(game.getPublicState({ width: 100, height: 100, lines })).includes(target), false);
  clock.advance(1000);
  const ended = game.getPublicState({ width: 100, height: 100, lines });
  assert.equal(ended.result.winner, 'saboteurs');
  assert.equal('answer' in ended.result, false);
  assert.equal(JSON.stringify(ended).includes(target), false);
});

test('broadcaster can end a round without awarding a team and the timer stops', () => {
  const lines = []; const clock = fakeClock();
  const game = createMatchGame({ lines, words: ['apple'], durationMs: 1000, ...clock, random: () => 0 });
  addPlayers(lines);
  assert.equal(game.startRound('broadcaster', 'broadcaster').status, 'started');
  assert.equal(game.endRound('viewer', 'broadcaster').status, 'unauthorized');
  const ended = game.endRound('broadcaster', 'broadcaster');
  assert.equal(ended.status, 'ended');
  assert.equal(ended.result.reason, 'broadcaster-ended');
  assert.equal(ended.result.winner, null);
  assert.equal('answer' in ended.result, false);
  assert.equal(game.lifecycle.getPhase(), 'ended');
  assert.equal(clock.timers.size, 0);
  assert.equal(game.getPublicState({ width: 100, height: 100, lines }).result.winner, null);
});

test('ending a match during an active round stops its timer and clears only that match state', () => {
  const lines = []; const clock = fakeClock();
  const game = createMatchGame({ lines, words: ['apple'], durationMs: 1000, ...clock, random: () => 0 });
  addPlayers(lines);
  game.startRound('broadcaster', 'broadcaster');
  assert.equal(clock.timers.size, 1);
  const reset = game.newMatch('broadcaster', 'broadcaster');
  assert.equal(reset.status, 'reset');
  assert.equal(clock.timers.size, 0);
  assert.equal(game.lifecycle.getPhase(), 'lobby');
  assert.deepEqual(lines, []);
  assert.equal(game.getPublicState({ width: 100, height: 100, lines }).playerCount, 0);
});

test('a host identity from another broadcaster cannot end a round or reset this match', () => {
  const lines = []; const game = makeGame(lines); addPlayers(lines);
  game.startRound('broadcaster-a', 'broadcaster-a');
  assert.equal(game.endRound('broadcaster-b', 'broadcaster-a').status, 'unauthorized');
  assert.equal(game.newMatch('broadcaster-b', 'broadcaster-a').status, 'unauthorized');
  assert.equal(game.lifecycle.getPhase(), 'active');
});

test('each new round gets a fresh word and exactly one role slot per participant', () => {
  const lines = []; const game = makeGame(lines); addPlayers(lines, ['one', 'two', 'three', 'four', 'five']);
  game.startRound('broadcaster', 'broadcaster');
  const firstWord = game.drawRole().targetWord;
  let draws = 1;
  while (game.drawRole().status === 'assigned') draws += 1;
  assert.equal(draws, 5);
  assert.equal(game.drawRole().status, 'exhausted');
  game.submitGuess('broadcaster', 'broadcaster', firstWord);
  game.nextRound('broadcaster', 'broadcaster');
  game.startRound('broadcaster', 'broadcaster');
  assert.notEqual(game.drawRole().targetWord, firstWord);
  let remaining = 1;
  while (game.drawRole().status === 'assigned') remaining += 1;
  assert.equal(remaining, 5);
});

test('line codes are human-readable, unique, and retained across round restoration', () => {
  assert.equal(lineCodeAt(0), 'AAA000');
  assert.equal(lineCodeAt(26 ** 3 * 1000 - 1), 'ZZZ999');
  assert.equal(generateUniqueLineCode(['AAA000'], (max) => 0), 'AAA001');
  const lines = []; const game = makeGame(lines);
  game.joinPlayer('viewer-a', 'A'); game.joinPlayer('viewer-b', 'B');
  const codes = lines.map((line) => line.code);
  assert.ok(codes.every((code) => /^[A-Z]{3}[0-9]{3}$/.test(code)));
  game.startRound('broadcaster', 'broadcaster'); game.drawRole();
  game.submitGuess('broadcaster', 'broadcaster', game.drawRole().targetWord);
  game.nextRound('broadcaster', 'broadcaster');
  assert.deepEqual(lines.map((line) => line.code), codes);
  assert.equal(game.newMatch('broadcaster', 'broadcaster').status, 'reset');
  assert.deepEqual(lines, []);
});

test('a repeat join reuses its line and code even if the chat reply fails', async () => {
  const lines = []; const game = makeGame(lines);
  const first = game.joinPlayer('viewer-a', 'Viewer A');
  const duplicate = game.joinPlayer('viewer-a', 'Viewer A');
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.lineCode, first.lineCode);
  assert.equal(lines.length, 1);
  const failingSender = createTwitchChatSender({ enabled: true, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await failingSender.sendJoinConfirmation('Viewer A', first.lineCode)).status, 'network-error');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].code, first.lineCode);
});

test('chat commands preserve per-user line ownership and lock the roster after round start', () => {
  const lines = []; const game = makeGame(lines);
  const join = (id, name) => applyRoundChatCommand(lines, id, name, '!join', game.lifecycle, 100, 100, game.joinPlayer);
  const joinedA = join('viewer-a', 'A');
  assert.equal(joinedA.status, 'joined'); assert.equal(joinedA.lineCode, lines[0].code);
  assert.equal(join('viewer-b', 'B').status, 'joined');
  const before = structuredClone(lines);
  assert.equal(applyRoundChatCommand(lines, 'viewer-x', 'X', '!move 5r', game.lifecycle, 100, 100, game.joinPlayer).status, 'rejected');
  assert.deepEqual(lines, before);
  game.startRound('broadcaster', 'broadcaster');
  assert.equal(join('viewer-c', 'C').status, 'rejected');
  assert.equal(applyRoundChatCommand(lines, 'viewer-a', 'A', '!move 5r', game.lifecycle, 100, 100, game.joinPlayer).status, 'applied');
  assert.equal(lines[0].a.x, before[0].a.x + 5); assert.equal(lines[1].a.x, before[1].a.x);
});

test('word bank is valid and includes broad, categorized coverage', () => {
  assert.ok(WORD_BANK.length >= 200); assert.deepEqual(validateWordBank(WORD_BANK), []);
  assert.ok(['easy', 'medium', 'hard'].every((level) => WORD_BANK.some((entry) => entry.difficulty === level)));
});
