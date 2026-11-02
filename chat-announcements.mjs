import { isIP } from 'node:net';

function ipv4IsPrivate(host) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99) || (b === 0 && c === 9) || (b === 0 && c === 10))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 240;
}

function ipv6IsNonPublic(host) {
  const normalized = host.toLowerCase();
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff') || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return ipv4IsPrivate(mapped);
    const halves = mapped.split(':');
    if (halves.length === 2 && halves.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const high = Number.parseInt(halves[0], 16), low = Number.parseInt(halves[1], 16);
      return ipv4IsPrivate([high >> 8, high & 255, low >> 8, low & 255].join('.'));
    }
  }
  return false;
}

export function isPublicHttpsOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const localSuffix = /(?:^|\.)(?:localhost|local|internal|lan|home|test|example|invalid)$/.test(host);
    const ipVersion = isIP(host);
    const nonPublicIp = ipVersion === 4 ? ipv4IsPrivate(host) : ipVersion === 6 ? ipv6IsNonPublic(host) : false;
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/' &&
      !localSuffix && !nonPublicIp;
  } catch { return false; }
}

export function createRoundAnnouncer({ sender, publicAppUrl, rolePath, disabledReason = null }) {
  const announcements = new Map();
  let baseUrl = null;
  if (isPublicHttpsOrigin(publicAppUrl)) baseUrl = new URL(publicAppUrl).origin;

  return {
    async announce(matchNumber, roundNumber) {
      const key = `${matchNumber}:${roundNumber}`;
      if (announcements.has(key)) {
        const prior = await announcements.get(key);
        return prior.status === 'sent'
          ? { status: 'already-sent', detail: 'Twitch already confirmed this round announcement.' }
          : prior;
      }
      if (disabledReason) return { status: 'local-session', detail: disabledReason };
      if (!baseUrl) return publicAppUrl
        ? { status: 'invalid-public-url', detail: 'PUBLIC_APP_URL must be a public HTTPS origin, not localhost, a private address, or an internal hostname.' }
        : { status: 'missing-public-url', detail: 'Set PUBLIC_APP_URL to the deployed public HTTPS origin before sending a round link.' };
      const roleUrl = new URL(rolePath, baseUrl).toString();
      const pending = Promise.resolve().then(() => sender.announceRound(roleUrl));
      announcements.set(key, pending);
      const result = await pending;
      announcements.set(key, Promise.resolve(result));
      return result;
    },
  };
}
