import { generateUniqueLineCode } from './line-codes.mjs';

export const CANVAS_SIZE = 100;

// The three layouts are reused as deterministic starting positions on join.
export function createDemoLines() {
  return [
    { id: 'demo-1', label: 'Demo line 1', color: '#ff6fcf', a: { x: 20, y: 20 }, b: { x: 10, y: 20 } },
    { id: 'demo-2', label: 'Demo line 2', color: '#60d7f4', a: { x: 60, y: 40 }, b: { x: 50, y: 40 } },
    { id: 'demo-3', label: 'Demo line 3', color: '#ffd166', a: { x: 80, y: 80 }, b: { x: 70, y: 80 } },
  ];
}

export function addPlayerLine(lines, ownerUserId, displayName = 'Viewer', retainedCode = undefined) {
  if (typeof ownerUserId !== 'string' || !ownerUserId) throw new TypeError('A Twitch user ID is required.');
  const existing = lines.find((item) => item.ownerUserId === ownerUserId);
  if (existing) return { line: existing, created: false };

  const templates = createDemoLines();
  const template = templates[lines.length % templates.length];
  const code = retainedCode ?? generateUniqueLineCode(lines.map((item) => item.code));
  if (!/^[A-Z]{3}[0-9]{3}$/.test(code) || lines.some((item) => item.code === code)) {
    throw new RangeError('Line code is invalid or already in use for this match.');
  }
  const line = {
    ...template,
    id: `player-${lines.length + 1}`,
    ownerUserId,
    label: displayName,
    code,
    a: { ...template.a },
    b: { ...template.b },
  };
  lines.push(line);
  return { line, created: true };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function moveLine(lines, id, dx, dy, width = CANVAS_SIZE, height = CANVAS_SIZE) {
  if (!finite(dx) || !finite(dy)) throw new TypeError('Move offsets must be finite numbers.');
  const line = lines.find((item) => item.id === id);
  if (!line) throw new RangeError('Unknown line ID.');
  const nextA = { x: line.a.x + dx, y: line.a.y + dy };
  const nextB = { x: line.b.x + dx, y: line.b.y + dy };
  if (![nextA, nextB].every((point) => point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height)) {
    throw new RangeError('Move rejected: an endpoint would leave the canvas.');
  }
  line.a = nextA;
  line.b = nextB;
}

export function rotateLine(lines, id, degrees, width = CANVAS_SIZE, height = CANVAS_SIZE) {
  if (!finite(degrees)) throw new TypeError('Rotation must be a finite number.');
  const line = lines.find((item) => item.id === id);
  if (!line) throw new RangeError('Unknown line ID.');

  const radians = degrees * Math.PI / 180;
  const dx = line.a.x - line.b.x;
  const dy = line.a.y - line.b.y;
  const x = dx * Math.cos(radians) - dy * Math.sin(radians);
  const y = dx * Math.sin(radians) + dy * Math.cos(radians);
  const nextA = { x: cleanZero(line.b.x + x), y: cleanZero(line.b.y + y) };
  if (nextA.x < 0 || nextA.x > width || nextA.y < 0 || nextA.y > height) {
    throw new RangeError('Rotation rejected: endpoint A would leave the canvas.');
  }
  line.a = nextA;
}

export function recolorLine(lines, id, color) {
  const line = lines.find((item) => item.id === id);
  if (!line) throw new RangeError('Unknown line ID.');
  line.color = color;
}

// Resolve a line only from the authenticated chat sender, never a command target.
export function applyOwnedAction(lines, ownerUserId, command, width = CANVAS_SIZE, height = CANVAS_SIZE) {
  const line = lines.find((item) => item.ownerUserId === ownerUserId);
  if (!line) throw new RangeError('Join with !join before controlling a line.');
  if (command.type === 'move') moveLine(lines, line.id, command.dx, command.dy, width, height);
  else if (command.type === 'rotate') rotateLine(lines, line.id, command.degrees, width, height);
  else if (command.type === 'color') recolorLine(lines, line.id, command.value);
  else throw new TypeError('Unsupported game command.');
  return line;
}

function cleanZero(value) {
  return Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(10));
}
