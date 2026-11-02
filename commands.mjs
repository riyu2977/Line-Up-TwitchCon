import { addPlayerLine, applyOwnedAction } from './game.mjs';

const COLORS = Object.freeze({
  blue: '#4b87ff',
});

export function parseLineupCommand(text) {
  if (typeof text !== 'string') return null;
  const input = text.trim();
  const knownCommand = /^!(join|move|rotate|color)(?:\s|$)/.exec(input);
  if (!knownCommand) return null;

  if (knownCommand[1] === 'join') {
    return input === '!join' ? { type: 'join' } : invalid('Use !join without arguments.');
  }

  if (knownCommand[1] === 'move') {
    const match = /^!move\s+([0-9]+)([lrud])$/.exec(input);
    if (!match) return invalid('Use !move followed by a positive amount and l, r, u, or d (for example, !move 30l).');
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100) return invalid('Move amount must be between 1 and 100 units.');
    const direction = { l: [-amount, 0], r: [amount, 0], u: [0, -amount], d: [0, amount] }[match[2]];
    return { type: 'move', dx: direction[0], dy: direction[1] };
  }

  if (knownCommand[1] === 'rotate') {
    const match = /^!rotate\s+(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))$/.exec(input);
    if (!match) return invalid('Use !rotate followed by a finite number of degrees (for example, !rotate 45).');
    const degrees = Number(match[1]);
    if (!Number.isFinite(degrees) || Math.abs(degrees) > 3600) return invalid('Rotation must be between -3600 and 3600 degrees.');
    return { type: 'rotate', degrees };
  }

  const colorMatch = /^!color\s+([a-z]+)$/.exec(input);
  if (!colorMatch || !Object.hasOwn(COLORS, colorMatch[1])) {
    return invalid(`Choose a supported color: ${Object.keys(COLORS).join(', ')}.`);
  }
  return { type: 'color', value: COLORS[colorMatch[1]], colorName: colorMatch[1] };
}

export function applyPlayerCommand(lines, ownerUserId, text, width, height) {
  const command = parseLineupCommand(text);
  if (!command) return { status: 'ignored' };
  if (command.type === 'invalid') return { status: 'rejected', reason: command.error };
  if (command.type === 'join') return { status: 'join' };
  try {
    const line = applyOwnedAction(lines, ownerUserId, command, width, height);
    return { status: 'applied', lineId: line.id };
  } catch (error) {
    return { status: 'rejected', reason: error.message };
  }
}

export function applyRoundChatCommand(lines, ownerUserId, displayName, text, lifecycle, width, height, joinPlayer) {
  const command = parseLineupCommand(text);
  if (!command) return { status: 'ignored' };
  if (command.type === 'invalid') return { status: 'rejected', reason: command.error };
  if (command.type === 'join') {
    if (!lifecycle.canJoin()) return { status: 'rejected', reason: 'Joining is closed.' };
    if (joinPlayer) return joinPlayer(ownerUserId, displayName);
    const result = addPlayerLine(lines, ownerUserId, displayName);
    return { status: 'joined', lineId: result.line.id, created: result.created };
  }
  if (!lifecycle.canPlay()) return { status: 'rejected', reason: 'The round is not active.' };
  return applyPlayerCommand(lines, ownerUserId, text, width, height);
}

function invalid(error) {
  return { type: 'invalid', error };
}

export { COLORS };

