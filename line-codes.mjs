import { randomInt } from 'node:crypto';

export const LINE_CODE_SPACE = 26 ** 3 * 1000;

export function lineCodeAt(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= LINE_CODE_SPACE) {
    throw new RangeError('Line-code index is outside the supported range.');
  }
  const number = index % 1000;
  const letters = Math.floor(index / 1000);
  const first = Math.floor(letters / (26 ** 2));
  const second = Math.floor(letters / 26) % 26;
  const third = letters % 26;
  return String.fromCharCode(65 + first, 65 + second, 65 + third) + String(number).padStart(3, '0');
}

export function generateUniqueLineCode(existingCodes = [], randomIndex = randomInt) {
  const occupied = new Set(existingCodes.filter((code) => typeof code === 'string'));
  if (occupied.size >= LINE_CODE_SPACE) throw new RangeError('No unique line codes remain in this match.');

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const index = randomIndex(LINE_CODE_SPACE);
    if (!Number.isSafeInteger(index) || index < 0 || index >= LINE_CODE_SPACE) {
      throw new RangeError('Line-code random source returned an invalid index.');
    }
    const code = lineCodeAt(index);
    if (!occupied.has(code)) return code;
  }

  const start = randomIndex(LINE_CODE_SPACE);
  for (let offset = 0; offset < LINE_CODE_SPACE; offset += 1) {
    const code = lineCodeAt((start + offset) % LINE_CODE_SPACE);
    if (!occupied.has(code)) return code;
  }
  throw new RangeError('No unique line codes remain in this match.');
}
