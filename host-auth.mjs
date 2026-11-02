export function getHostAccessMode(env, session, broadcasterId) {
  if (session && typeof broadcasterId === 'string' && session.userId === broadcasterId) return 'broadcaster';
  if (env?.NODE_ENV === 'development' && env?.ENABLE_LOCAL_DEV_HOST === 'true') return 'development';
  return null;
}

export function getHostActionIdentity(env, session, broadcasterId) {
  const accessMode = getHostAccessMode(env, session, broadcasterId);
  if (!accessMode) return null;
  const userId = accessMode === 'development' ? broadcasterId : session?.userId;
  if (typeof userId !== 'string' || !userId) return null;
  return { accessMode, userId };
}

export function invalidateHostSession(hostSessions, sessionId) {
  if (!(hostSessions instanceof Map) || typeof sessionId !== 'string' || !sessionId) return false;
  return hostSessions.delete(sessionId);
}
