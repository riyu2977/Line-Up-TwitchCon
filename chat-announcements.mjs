export function createRoundAnnouncer({ sender, publicAppUrl, rolePath }) {
  const announcements = new Map();
  let baseUrl = null;
  if (publicAppUrl) {
    try {
      const parsed = new URL(publicAppUrl);
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
      const isLoopback = hostname === 'localhost' || hostname.endsWith('.localhost') ||
        hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
      if (parsed.protocol === 'https:' && !isLoopback && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/') {
        baseUrl = parsed.origin;
      }
    } catch {}
  }

  return {
    async announce(matchNumber, roundNumber) {
      const key = `${matchNumber}:${roundNumber}`;
      if (announcements.has(key)) {
        const prior = await announcements.get(key);
        return prior.status === 'sent'
          ? { status: 'already-sent', detail: 'Twitch already confirmed this round announcement.' }
          : prior;
      }
      if (!baseUrl) return { status: 'missing-public-url', detail: 'Set PUBLIC_APP_URL to a public HTTPS origin before sending a round link.' };
      const roleUrl = new URL(rolePath, baseUrl).toString();
      const pending = Promise.resolve().then(() => sender.announceRound(roleUrl));
      announcements.set(key, pending);
      const result = await pending;
      announcements.set(key, Promise.resolve(result));
      return result;
    },
  };
}
