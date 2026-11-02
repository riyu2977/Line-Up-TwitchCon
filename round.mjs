export const DEFAULT_ROUND_DURATION_MS = 3 * 60 * 1000;

export function createRoundLifecycle({
  lines,
  durationMs = DEFAULT_ROUND_DURATION_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  onEnd = () => {},
}) {
  if (!Array.isArray(lines)) throw new TypeError('Round lines must be an array.');
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new TypeError('Round duration must be a positive safe integer.');

  let phase = 'lobby';
  let deadline = null;
  let timer = null;

  function endRound(outcome) {
    if (phase !== 'active') return false;
    if (timer !== null) clearTimer(timer);
    timer = null;
    phase = 'ended';
    deadline = null;
    onEnd(outcome);
    return true;
  }

  function expireIfDue() {
    if (phase === 'active' && now() >= deadline) endRound({ reason: 'timeout', winner: 'saboteurs' });
  }

  function authorized(senderId, broadcasterId) {
    return typeof senderId === 'string' && senderId.length > 0 &&
      typeof broadcasterId === 'string' && broadcasterId.length > 0 &&
      senderId === broadcasterId;
  }

  return {
    start(senderId, broadcasterId) {
      expireIfDue();
      if (!authorized(senderId, broadcasterId)) return { status: 'unauthorized' };
      if (phase !== 'lobby') return { status: 'invalid-phase' };
      phase = 'active';
      deadline = now() + durationMs;
      timer = setTimer(() => endRound({ reason: 'timeout', winner: 'saboteurs' }), durationMs);
      return { status: 'started' };
    },

    finish(outcome) {
      expireIfDue();
      return endRound(outcome);
    },

    reset(senderId, broadcasterId) {
      if (!authorized(senderId, broadcasterId)) return { status: 'unauthorized' };
      if (timer !== null) clearTimer(timer);
      timer = null;
      deadline = null;
      phase = 'lobby';
      lines.length = 0;
      return { status: 'reset' };
    },

    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      deadline = null;
    },

    expireIfDue,
    getPhase() {
      expireIfDue();
      return phase;
    },
    getRemainingMs() {
      expireIfDue();
      return phase === 'active' ? Math.max(0, deadline - now()) : 0;
    },
    canJoin() {
      return this.getPhase() === 'lobby';
    },
    canPlay() {
      return this.getPhase() === 'active';
    },
  };
}

export function createMessageDeduplicator(limit = 5000) {
  const seen = new Set();
  const order = [];
  return {
    isDuplicate(messageId) {
      if (typeof messageId !== 'string' || !messageId) return false;
      if (seen.has(messageId)) return true;
      seen.add(messageId);
      order.push(messageId);
      if (order.length > limit) seen.delete(order.shift());
      return false;
    },
  };
}

export function makePublicGameState(game, lifecycle) {
  return {
    width: game.width,
    height: game.height,
    phase: lifecycle.getPhase(),
    remainingMs: lifecycle.getRemainingMs(),
    lines: game.lines.map(({ id, code, label, color, a, b }) => ({ id, code, label, color, a, b })),
  };
}
