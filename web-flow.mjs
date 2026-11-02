export function createTwitchAuthorizationUrl({ clientId, redirectUri, state }) {
  const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'user:read:chat user:write:chat',
    state,
  }).toString();
  return authorize;
}

export function consumeOAuthState(stateStore, { cookieState, returnedState, now = Date.now() }) {
  const attempt = cookieState ? stateStore.get(cookieState) : null;
  const valid = Boolean(cookieState && attempt && attempt.expiresAt > now && returnedState === cookieState);
  if (cookieState) stateStore.delete(cookieState);
  return valid;
}

export async function exchangeAndValidateOAuthCode({ fetchImpl = fetch, clientId, clientSecret, code, redirectUri }) {
  const tokenResponse = await fetchImpl('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(15000),
  });
  if (!tokenResponse.ok) throw new Error('Twitch could not complete sign-in. Check the registered callback and app configuration.');
  const token = await tokenResponse.json();
  if (!token?.access_token) throw new Error('Twitch returned no access token. Retry sign-in.');
  const validation = await fetchImpl('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!validation.ok) throw new Error('Twitch authorization could not be validated.');
  const identity = await validation.json();
  if (identity.client_id !== clientId || typeof identity.user_id !== 'string' || !identity.user_id) {
    throw new Error('Twitch did not validate this account for the configured application.');
  }
  return { token, identity };
}

export function broadcasterGamePath(userId) {
  if (typeof userId !== 'string' || !/^\d+$/.test(userId)) throw new TypeError('A valid Twitch broadcaster ID is required.');
  return `/game/${encodeURIComponent(userId)}`;
}

export function resolveOAuthRedirectUri({ nodeEnv, configuredRedirectUri, publicOrigin, port }) {
  const redirectUri = configuredRedirectUri || (nodeEnv === 'production' && publicOrigin
    ? `${publicOrigin}/host/callback`
    : `http://localhost:${port}/host/callback`);
  const redirect = new URL(redirectUri);
  const loopback = redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname) &&
    redirect.host === `${redirect.hostname}:${port}`;
  const publicCallback = nodeEnv === 'production' && Boolean(publicOrigin) &&
    redirect.origin === publicOrigin && redirect.protocol === 'https:';
  if ((!loopback && !publicCallback) || redirect.pathname !== '/host/callback' ||
      redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error(nodeEnv === 'production'
      ? 'TWITCH_HOST_REDIRECT_URI must be PUBLIC_APP_URL/host/callback in production.'
      : `Local Twitch OAuth must use http://localhost:${port}/host/callback or its 127.0.0.1 equivalent.`);
  }
  return redirect.toString();
}

export function canonicalLoopbackRedirect({ nodeEnv, requestHostname, requestHost, redirectHostname, redirectHost, pathname, search }) {
  if (nodeEnv === 'production' || !['localhost', '127.0.0.1'].includes(redirectHostname) ||
      !['localhost', '127.0.0.1'].includes(requestHostname) || requestHost === redirectHost) return null;
  return `http://${redirectHost}${pathname}${search}`;
}

export function isSameOriginApplicationRequest({ nodeEnv, requestHost, requestOrigin, developmentOrigin, publicOrigin }) {
  const expectedOrigin = nodeEnv === 'production' ? publicOrigin : developmentOrigin;
  if (!expectedOrigin || requestOrigin !== expectedOrigin) return false;
  try { return requestHost === new URL(expectedOrigin).host; }
  catch { return false; }
}

export function buildRoleRevealUrl({ nodeEnv, rolePath, publicOrigin, localOrigin }) {
  const origin = publicOrigin || (nodeEnv === 'production' ? null : localOrigin);
  if (!origin || typeof rolePath !== 'string' || !rolePath.startsWith('/role/')) return null;
  try {
    const parsed = new URL(origin);
    if (nodeEnv === 'production' && parsed.protocol !== 'https:') return null;
    return new URL(rolePath, parsed.origin).toString();
  } catch { return null; }
}
