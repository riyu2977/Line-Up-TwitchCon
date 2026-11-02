import { addPlayerLine } from './game.mjs';
import { WORD_BANK, normalizeWord, validateWordBank } from './word-bank.mjs';
import { createRoundLifecycle, makePublicGameState } from './round.mjs';
import { createRoleAllocation } from './role-allocation.mjs';

export const TARGET_WORDS = Object.freeze(WORD_BANK.map((entry) => entry.word));
const RECENT_WORD_LIMIT = 12;

export function normalizeGuess(value) {
  return normalizeWord(value);
}

export function createMatchGame({
  lines, durationMs, words = WORD_BANK, random = Math.random,
  setTimer, clearTimer, now,
}) {
  if (!Array.isArray(lines)) throw new TypeError('Match lines must be an array.');
  const entries = words.map((item) => typeof item === 'string'
    ? { word: item, category: 'custom', difficulty: 'easy' }
    : item);
  const validation = validateWordBank(entries);
  // Custom test or caller-supplied word lists retain the old string API; enforce
  // normalized uniqueness and non-empty words without requiring built-in categories.
  if (entries.some((item) => item.category === 'custom')) {
    const normalized = entries.map((item) => normalizeGuess(item.word));
    if (normalized.some((word) => !word) || new Set(normalized).size !== normalized.length) {
      throw new TypeError('Target words must be non-empty and unique after normalization.');
    }
  } else if (validation.length) {
    throw new TypeError(`Invalid target word bank: ${validation.join(' ')}`);
  }
  const wordList = entries.map((item) => normalizeGuess(item.word)).filter(Boolean);
  if (!wordList.length) throw new TypeError('At least one target word is required.');

  let matchNumber = 1;
  let roundNumber = 0;
  let participants = new Map(lines.filter((line) => line.ownerUserId).map((line) => [line.ownerUserId, { displayName: line.label, code: line.code }]));
  let roleAllocation = null;
  let targetWord = null;
  let recentWords = [];
  let result = null;

  function finalize(outcome) {
    if (result) return;
    result = { roundNumber, winner: outcome.winner ?? null, reason: outcome.reason, guess: outcome.guess ?? null };
    roleAllocation = null;
  }

  const lifecycle = createRoundLifecycle({ lines, durationMs, setTimer, clearTimer, now, onEnd: finalize });

  function authorized(userId, broadcasterId) {
    return typeof userId === 'string' && userId.length > 0 && userId === broadcasterId;
  }

  function joinPlayer(userId, displayName = 'Viewer') {
    if (lifecycle.getPhase() !== 'lobby') return { status: 'rejected', reason: 'Joining is closed.' };
    if (!userId || typeof userId !== 'string') return { status: 'rejected', reason: 'A Twitch user ID is required.' };
    const existing = lines.find((line) => line.ownerUserId === userId);
    if (existing) return { status: 'joined', lineId: existing.id, lineCode: existing.code, created: false };
    if (participants.has(userId)) return { status: 'rejected', reason: 'You have already joined this match.' };
    const { line } = addPlayerLine(lines, userId, displayName);
    participants.set(userId, { displayName, code: line.code });
    return { status: 'joined', lineId: line.id, lineCode: line.code, created: true };
  }

  function chooseWord() {
    const available = wordList.filter((word) => !recentWords.includes(word));
    const candidates = available.length ? available : wordList;
    const raw = Math.floor(random() * candidates.length);
    const selected = candidates[Math.max(0, Math.min(candidates.length - 1, raw))];
    recentWords.push(selected);
    if (recentWords.length > RECENT_WORD_LIMIT) recentWords.shift();
    return selected;
  }

  function startRound(userId, broadcasterId) {
    if (!authorized(userId, broadcasterId)) return { status: 'unauthorized' };
    if (lifecycle.getPhase() !== 'lobby') return { status: 'invalid-phase' };
    for (const line of lines) {
      if (line.ownerUserId && !participants.has(line.ownerUserId)) {
        participants.set(line.ownerUserId, { displayName: line.label, code: line.code });
      }
    }
    if (participants.size < 2 || lines.length < 2) return { status: 'insufficient-players' };
    const start = lifecycle.start(userId, broadcasterId);
    if (start.status !== 'started') return start;

    roundNumber += 1;
    result = null;
    roleAllocation = createRoleAllocation(participants.size, random);
    targetWord = chooseWord();
    return { status: 'started', roundNumber };
  }

  function drawRole() {
    if (!lifecycle.canPlay() || !roleAllocation || !targetWord) return { status: 'invalid-phase' };
    const allocation = roleAllocation.draw();
    if (allocation.status === 'exhausted') return allocation;
    return { status: 'assigned', role: allocation.role, targetWord, matchNumber, roundNumber };
  }

  function submitGuess(userId, broadcasterId, guess) {
    if (!authorized(userId, broadcasterId)) return { status: 'unauthorized' };
    if (!lifecycle.canPlay()) return { status: 'invalid-phase' };
    const normalized = normalizeGuess(guess);
    if (!normalized) return { status: 'invalid-guess' };
    if (normalized !== targetWord) return { status: 'incorrect' };
    lifecycle.finish({ winner: 'builders', reason: 'correct-guess', guess: String(guess).trim() });
    return { status: 'correct', result: { roundNumber: result.roundNumber, winner: result.winner, reason: result.reason } };
  }

  function endRound(userId, broadcasterId) {
    if (!authorized(userId, broadcasterId)) return { status: 'unauthorized' };
    if (!lifecycle.canPlay()) return { status: 'invalid-phase' };
    lifecycle.finish({ reason: 'broadcaster-ended', winner: null });
    return { status: 'ended', result: result ? { ...result } : null };
  }

  function restoreRoster() {
    lines.length = 0;
    for (const [userId, participant] of participants) {
      addPlayerLine(lines, userId, participant.displayName, participant.code);
    }
  }

  function nextRound(userId, broadcasterId) {
    if (!authorized(userId, broadcasterId)) return { status: 'unauthorized' };
    if (lifecycle.getPhase() !== 'ended') return { status: 'invalid-phase' };
    const reset = lifecycle.reset(userId, broadcasterId);
    if (reset.status !== 'reset') return reset;
    restoreRoster();
    roleAllocation = null;
    targetWord = null;
    result = null;
    return { status: 'reset', matchNumber, roundNumber };
  }

  function newMatch(userId, broadcasterId) {
    if (!authorized(userId, broadcasterId)) return { status: 'unauthorized' };
    const reset = lifecycle.reset(userId, broadcasterId);
    if (reset.status !== 'reset') return reset;
    matchNumber += 1;
    roundNumber = 0;
    participants = new Map();
    roleAllocation = null;
    targetWord = null;
    recentWords = [];
    result = null;
    return { status: 'reset', matchNumber };
  }

  function redactTargetText(value) {
    if (typeof value !== 'string' || lifecycle.getPhase() !== 'active' || !targetWord) return value;
    const escaped = targetWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const matcher = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    return value.replace(matcher, '[hidden target]');
  }

  function getPublicState(game) {
    const publicState = makePublicGameState(game, lifecycle);
    publicState.lines = publicState.lines.map((line) => ({ ...line, label: redactTargetText(line.label) }));
    return {
      ...publicState, matchNumber, roundNumber,
      playerCount: participants.size, canStart: lifecycle.getPhase() === 'lobby' && participants.size >= 2,
      result: result ? { roundNumber: result.roundNumber, winner: result.winner, reason: result.reason } : null,
    };
  }

  function getHostState(game) {
    return getPublicState(game);
  }

  function getPublicChatMessages(messages) {
    if (lifecycle.getPhase() !== 'active' || !targetWord) return messages;
    return messages.map((message) => ({
      ...message,
      senderName: redactTargetText(message.senderName),
      text: redactTargetText(String(message.text)),
      ...(message.commandOutcome ? { commandOutcome: { ...message.commandOutcome, reason: redactTargetText(message.commandOutcome.reason) } } : {}),
    }));
  }

  return {
    lifecycle,
    joinPlayer,
    startRound,
    drawRole,
    submitGuess,
    endRound,
    nextRound,
    newMatch,
    getPublicState,
    getHostState,
    getPublicChatMessages,
  };
}
