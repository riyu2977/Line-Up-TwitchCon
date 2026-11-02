import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcasterGamePath, buildRoleRevealUrl, canonicalLoopbackRedirect, consumeOAuthState, createTwitchAuthorizationUrl, exchangeAndValidateOAuthCode, isSameOriginApplicationRequest, resolveOAuthRedirectUri } from './web-flow.mjs';

test('Lineup OAuth always targets Twitch authorization with its configured callback and scopes', () => {
  const url = createTwitchAuthorizationUrl({
    clientId: 'lineup-client',
    redirectUri: 'http://localhost:3000/host/callback',
    state: 'state-value',
  });
  assert.equal(url.origin, 'https://id.twitch.tv');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'lineup-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/host/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'user:read:chat user:write:chat');
  assert.equal(url.searchParams.get('state'), 'state-value');
});

test('successful broadcaster sign-in resolves to a stable ID-specific game route', () => {
  assert.equal(broadcasterGamePath('123456'), '/game/123456');
  assert.throws(() => broadcasterGamePath('not-a-twitch-id'), /valid Twitch broadcaster ID/);
});

test('local hostname mismatch is normalized but production and canonical requests are untouched', () => {
  const request = { nodeEnv: 'development', requestHostname: '127.0.0.1', requestHost: '127.0.0.1:3000', redirectHostname: 'localhost', redirectHost: 'localhost:3000', pathname: '/host/login', search: '?next=1' };
  assert.equal(canonicalLoopbackRedirect(request), 'http://localhost:3000/host/login?next=1');
  assert.equal(canonicalLoopbackRedirect({ ...request, requestHost: 'localhost:3000' }), null);
  assert.equal(canonicalLoopbackRedirect({ ...request, nodeEnv: 'production' }), null);
});

test('same-origin mutations validate loopback locally and configured HTTPS origin in production', () => {
  assert.equal(isSameOriginApplicationRequest({ nodeEnv: 'development', requestHost: 'localhost:3000', requestOrigin: 'http://localhost:3000', developmentOrigin: 'http://localhost:3000' }), true);
  assert.equal(isSameOriginApplicationRequest({ nodeEnv: 'development', requestHost: '127.0.0.1:3000', requestOrigin: 'http://127.0.0.1:3000', developmentOrigin: 'http://localhost:3000' }), false);
  assert.equal(isSameOriginApplicationRequest({ nodeEnv: 'production', requestHost: 'lineup.example', requestOrigin: 'https://lineup.example', developmentOrigin: 'http://localhost:3000', publicOrigin: 'https://lineup.example' }), true);
  assert.equal(isSameOriginApplicationRequest({ nodeEnv: 'production', requestHost: 'evil.example', requestOrigin: 'https://lineup.example', publicOrigin: 'https://lineup.example' }), false);
  assert.equal(isSameOriginApplicationRequest({ nodeEnv: 'production', requestHost: 'lineup.example', requestOrigin: 'https://evil.example', publicOrigin: 'https://lineup.example' }), false);
});

test('role links use local origin only for local testing and require public HTTPS in production', () => {
  assert.equal(buildRoleRevealUrl({ nodeEnv: 'development', rolePath: '/role/abc', localOrigin: 'http://localhost:3000' }), 'http://localhost:3000/role/abc');
  assert.equal(buildRoleRevealUrl({ nodeEnv: 'production', rolePath: '/role/abc', publicOrigin: 'https://lineup.example' }), 'https://lineup.example/role/abc');
  assert.equal(buildRoleRevealUrl({ nodeEnv: 'production', rolePath: '/role/abc', localOrigin: 'http://localhost:3000' }), null);
  assert.equal(buildRoleRevealUrl({ nodeEnv: 'production', rolePath: '/role/abc', publicOrigin: 'http://localhost:3000' }), null);
});

test('development OAuth cannot be redirected to a third-party callback', () => {
  assert.equal(resolveOAuthRedirectUri({ nodeEnv: 'development', port: 3000 }), 'http://localhost:3000/host/callback');
  assert.equal(resolveOAuthRedirectUri({ nodeEnv: 'development', port: 3000, configuredRedirectUri: 'http://127.0.0.1:3000/host/callback' }), 'http://127.0.0.1:3000/host/callback');
  assert.throws(() => resolveOAuthRedirectUri({ nodeEnv: 'development', port: 3000, configuredRedirectUri: 'https://external-auth.example/oauth/callback' }), /Local Twitch OAuth must use/);
});

test('production OAuth callback must belong to the configured public Lineup origin', () => {
  assert.equal(resolveOAuthRedirectUri({ nodeEnv: 'production', port: 3000, publicOrigin: 'https://lineup.example' }), 'https://lineup.example/host/callback');
  assert.throws(() => resolveOAuthRedirectUri({ nodeEnv: 'production', port: 3000, publicOrigin: 'https://lineup.example', configuredRedirectUri: 'https://external-auth.example/oauth/callback' }), /PUBLIC_APP_URL/);
});

test('OAuth state must match the HttpOnly browser state and is consumed once', () => {
  const states = new Map([['valid-state', { expiresAt: 2000 }]]);
  assert.equal(consumeOAuthState(states, { cookieState: 'valid-state', returnedState: 'wrong', now: 1000 }), false);
  assert.equal(states.has('valid-state'), false);
  states.set('next-state', { expiresAt: 2000 });
  assert.equal(consumeOAuthState(states, { cookieState: 'next-state', returnedState: 'next-state', now: 1000 }), true);
  assert.equal(consumeOAuthState(states, { cookieState: 'next-state', returnedState: 'next-state', now: 1000 }), false);
  states.set('expired-state', { expiresAt: 999 });
  assert.equal(consumeOAuthState(states, { cookieState: 'expired-state', returnedState: 'expired-state', now: 1000 }), false);
});

test('OAuth callback exchanges code and validates the same Twitch application identity', async () => {
  const calls = [];
  const result = await exchangeAndValidateOAuthCode({
    clientId: 'lineup-client', clientSecret: 'test-only-secret', code: 'test-only-code',
    redirectUri: 'http://localhost:3000/host/callback',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'test-only-access', refresh_token: 'test-only-refresh' }) };
      return { ok: true, json: async () => ({ client_id: 'lineup-client', user_id: '12345', scopes: ['user:read:chat', 'user:write:chat'] }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://id.twitch.tv/oauth2/token');
  assert.equal(calls[0].options.body.get('client_id'), 'lineup-client');
  assert.equal(calls[0].options.body.get('redirect_uri'), 'http://localhost:3000/host/callback');
  assert.equal(calls[1].url, 'https://id.twitch.tv/oauth2/validate');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-only-access');
  assert.equal(result.identity.user_id, '12345');
  assert.equal(result.identity.client_id, 'lineup-client');
});

test('OAuth callback rejects token exchange failures and identity from a different app', async () => {
  await assert.rejects(exchangeAndValidateOAuthCode({
    clientId: 'lineup-client', clientSecret: 'test-only-secret', code: 'test-only-code', redirectUri: 'http://localhost:3000/host/callback',
    fetchImpl: async () => ({ ok: false, status: 400 }),
  }), /could not complete sign-in/);
  await assert.rejects(exchangeAndValidateOAuthCode({
    clientId: 'lineup-client', clientSecret: 'test-only-secret', code: 'test-only-code', redirectUri: 'http://localhost:3000/host/callback',
    fetchImpl: async (url) => url.endsWith('/token')
      ? { ok: true, json: async () => ({ access_token: 'test-only-access' }) }
      : { ok: true, json: async () => ({ client_id: 'different-app', user_id: '12345' }) },
  }), /configured application/);
});
