import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { DEFAULT_ROUND_DURATION_MS } from './round.mjs';
import { createStreamerSession } from './streamer-session.mjs';
import { getHostActionIdentity, invalidateHostSession } from './host-auth.mjs';
import { assessBroadcasterChatToken } from './twitch-auth.mjs';
import { renderRolePage, rolePageStatus } from './role-page.mjs';
import { isPublicHttpsOrigin } from './chat-announcements.mjs';
import { broadcasterGamePath, buildRoleRevealUrl, canonicalLoopbackRedirect, consumeOAuthState, createTwitchAuthorizationUrl, exchangeAndValidateOAuthCode, isSameOriginApplicationRequest, resolveOAuthRedirectUri } from './web-flow.mjs';

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.TWITCH_CLIENT_ID?.trim();
const ACCESS_TOKEN = process.env.TWITCH_ACCESS_TOKEN?.trim();
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID?.trim();
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET?.trim();
const NODE_ENV = process.env.NODE_ENV || 'development';
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, '');
const ROUND_DURATION_MS = DEFAULT_ROUND_DURATION_MS;
const publicOrigin = isPublicHttpsOrigin(PUBLIC_APP_URL) ? new URL(PUBLIC_APP_URL) : null;
const OAUTH_REDIRECT_URI = resolveOAuthRedirectUri({ nodeEnv: NODE_ENV,
  configuredRedirectUri: process.env.TWITCH_HOST_REDIRECT_URI?.trim(),
  publicOrigin: publicOrigin?.origin, port: PORT });
const redirectUrl = new URL(OAUTH_REDIRECT_URI);
const HOST_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SECURE_COOKIE = NODE_ENV === 'production' ? '; Secure' : '';
const sessions = new Map();
const roleLinks = new Map();
const oauthStates = new Map();
const hostSessions = new Map();
const eventSubs = new Map();
let shuttingDown = false;
function makeSession(broadcasterId, accessToken, extra = {}) {
  const roleToken = randomBytes(32).toString('base64url');
  const session = createStreamerSession({ broadcasterId, accessToken, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    publicAppUrl: PUBLIC_APP_URL, rolePath: `/role/${roleToken}`, durationMs: ROUND_DURATION_MS, ...extra });
  session.rolePath = `/role/${roleToken}`;
  sessions.set(broadcasterId, session);
  roleLinks.set(roleToken, session);
  return session;
}

function stopEventSub(broadcasterId) {
  const connection = eventSubs.get(broadcasterId);
  if (!connection) return;
  connection.stopped = true;
  clearTimeout(connection.retryTimer);
  clearTimeout(connection.heartbeatTimer);
  const session = sessions.get(broadcasterId);
  session?.setEventSubState('disconnected', 'not-created', null);
  connection.socket?.close();
  eventSubs.delete(broadcasterId);
}

function armEventSubWatchdog(session, connection, socket) {
  clearTimeout(connection.heartbeatTimer);
  if (!connection.keepaliveTimeoutMs) return;
  connection.heartbeatTimer = setTimeout(() => {
    if (connection.stopped || eventSubs.get(session.broadcasterId) !== connection || connection.socket !== socket) return;
    session.setStatus('disconnected', 'No Twitch EventSub messages arrived before the keepalive deadline. Reconnecting.');
    session.setEventSubState('disconnected', 'unknown', connection.keepaliveTimeoutMs);
    socket.close();
  }, connection.keepaliveTimeoutMs + 1000);
}

function connectEventSub(session, url = 'wss://eventsub.wss.twitch.tv/ws', reconnecting = false) {
  if (shuttingDown) return;
  const id = session.broadcasterId;
  const connection = eventSubs.get(id) || { stopped: false, retryTimer: null, heartbeatTimer: null, socket: null, keepaliveTimeoutMs: null };
  connection.stopped = false;
  eventSubs.set(id, connection);
  clearTimeout(connection.retryTimer);
  clearTimeout(connection.heartbeatTimer);
  session.setEventSubState('connecting', reconnecting ? 'enabled' : 'pending', connection.keepaliveTimeoutMs);
  session.setStatus('connecting', `Opening EventSub for broadcaster ${id}.`);
  try { connection.socket = new WebSocket(url); }
  catch { scheduleEventSubRetry(session, connection, 'Could not create the Twitch WebSocket connection.'); return; }
  const socket = connection.socket;
  socket.addEventListener('open', () => {
    session.setEventSubState('connected', reconnecting ? 'enabled' : 'pending', connection.keepaliveTimeoutMs);
    session.setStatus('connected', 'Waiting for Twitch EventSub session welcome.');
  });
  socket.addEventListener('message', async (message) => {
    let envelope;
    try { envelope = JSON.parse(message.data); }
    catch { session.setStatus('error', 'Received an unreadable message from Twitch.'); return; }
    const kind = envelope.metadata?.message_type;
    if (kind === 'session_welcome') {
      try {
        const timeoutSeconds = envelope.payload?.session?.keepalive_timeout_seconds;
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('Twitch welcome did not include a valid keepalive timeout.');
        connection.keepaliveTimeoutMs = timeoutSeconds * 1000;
        session.setEventSubState('connected', reconnecting ? 'enabled' : 'pending', connection.keepaliveTimeoutMs);
        session.noteEventSubMessage();
        armEventSubWatchdog(session, connection, socket);
        if (!reconnecting) await session.subscribeToChat(envelope.payload.session.id);
        session.state.connectedAt = new Date().toISOString();
        session.setEventSubState('connected', 'enabled', connection.keepaliveTimeoutMs);
        session.setStatus('listening', `EventSub is subscribed for broadcaster ${id}.`);
      } catch (error) {
        session.setStatus('error', error.message || 'Could not subscribe to Twitch chat.');
        session.setEventSubState('disconnected', 'failed', connection.keepaliveTimeoutMs);
        connection.stopped = true;
        clearTimeout(connection.heartbeatTimer);
        socket.close();
      }
    } else if (kind === 'session_keepalive') {
      session.noteEventSubMessage();
      armEventSubWatchdog(session, connection, socket);
    } else if (kind === 'notification' && envelope.metadata?.subscription_type === 'channel.chat.message') {
      session.noteEventSubMessage();
      armEventSubWatchdog(session, connection, socket);
      await session.handleChatNotification(envelope);
    } else if (kind === 'session_reconnect') {
      session.setStatus('reconnecting', 'Twitch requested an EventSub reconnect.');
      session.setEventSubState('reconnecting', 'enabled', connection.keepaliveTimeoutMs);
      const reconnectUrl = envelope.payload?.session?.reconnect_url;
      if (typeof reconnectUrl === 'string' && reconnectUrl.startsWith('wss://')) connectEventSub(session, reconnectUrl, true);
      else scheduleEventSubRetry(session, connection, 'Twitch supplied no valid reconnect URL; opening a fresh EventSub session.', 250);
    } else if (kind === 'revocation') {
      session.setStatus('error', 'Twitch revoked this chat subscription. Reauthorize this channel.');
      session.setEventSubState('disconnected', 'revoked', connection.keepaliveTimeoutMs);
      connection.stopped = true;
      clearTimeout(connection.heartbeatTimer);
      socket.close();
    }
  });
  socket.addEventListener('error', () => {
    session.setEventSubState('disconnected', 'unknown', connection.keepaliveTimeoutMs);
    session.setStatus('connection error', 'Could not maintain this Twitch WebSocket.');
  });
  socket.addEventListener('close', (event) => {
    if (connection.stopped || shuttingDown || eventSubs.get(id) !== connection || connection.socket !== socket) return;
    clearTimeout(connection.heartbeatTimer);
    session.setEventSubState('disconnected', 'unknown', connection.keepaliveTimeoutMs);
    session.setStatus('disconnected', `Twitch WebSocket closed (code ${event.code || 'unknown'}). Retrying.`);
    scheduleEventSubRetry(session, connection, 'Retrying Twitch EventSub.');
  });
}

function scheduleEventSubRetry(session, connection, detail, delay = 5000) {
  if (shuttingDown || connection.stopped || connection.retryTimer) return;
  session.setStatus('retrying', detail);
  session.setEventSubState('reconnecting', 'unknown', connection.keepaliveTimeoutMs);
  connection.retryTimer = setTimeout(() => {
    connection.retryTimer = null;
    connectEventSub(session);
  }, delay);
}

function selectPublicSession(request, requestUrl) {
  const selectedId = requestUrl.searchParams.get('channel');
  if (selectedId) return sessions.get(selectedId) || null;
  const id = parseCookies(request).lineup_host_session;
  const host = id && hostSessions.get(id);
  if (host && host.expiresAt > Date.now()) return sessions.get(host.broadcasterId) || null;
  return BROADCASTER_ID ? sessions.get(BROADCASTER_ID) || null : null;
}

function sessionFromHostCookie(request) {
  const id = parseCookies(request).lineup_host_session;
  const host = id && hostSessions.get(id);
  if (!host || host.expiresAt <= Date.now()) {
    if (id) hostSessions.delete(id);
    return null;
  }
  const session = sessions.get(host.broadcasterId);
  return session && host.userId === session.broadcasterId ? { host, session, id } : null;
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lineup — Twitch chat drawing game</title>
<style>
:root{color-scheme:dark;font:14px system-ui,sans-serif;background:#111318;color:#eef0f6}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{padding:10px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:8px}header{min-height:0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}header .heading{min-width:0}#header-account{display:flex;align-items:flex-start;justify-content:flex-end;min-width:90px}h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:0 0 6px}.muted,.intro{color:#aeb3c0;line-height:1.35;margin:3px 0}.panel{padding:10px;border:1px solid #30343e;border-radius:8px;background:#191c23;margin:0;min-height:0}.game{height:100%;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(245px,290px);gap:8px}.canvas-panel{display:grid;grid-template-rows:minmax(0,1fr) auto;justify-items:center;min-height:0}.canvas-wrap{height:100%;width:min(100%,calc(100vh - 110px));min-height:0;aspect-ratio:1}canvas{display:block;width:100%;height:100%;background:#12141a;border-radius:5px}.sidebar{min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);gap:8px}.chat{min-height:0;display:grid;grid-template-rows:auto auto minmax(0,1fr)}.status{padding:8px 10px;border:1px solid #383d49;border-radius:7px;background:#191c23;margin:4px 0}#state{font-weight:700;color:#c59cff}#detail{color:#c0c4cf;margin-top:2px;font-size:12px}button,input{font:inherit;color:#eef0f6;background:#252832;border:1px solid #3c414d;border-radius:5px;padding:7px}button{cursor:pointer;margin:3px 4px 3px 0}button:disabled{opacity:.48;cursor:not-allowed}input{width:100%}label{display:block;color:#c2c6d0;margin:6px 0 4px}.row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px;padding:8px 3px;border-bottom:1px solid #2a2d35}.name{font-weight:650}.id,.meta{font:11px ui-monospace,monospace;color:#aeb3c0;overflow-wrap:anywhere}.text{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:3px}.badge{background:#77dfb0;color:#101116;border-radius:4px;padding:2px 5px;font-size:10px;margin-left:4px}#role-details{margin-top:7px;padding:9px;background:#222630;border-radius:7px}#host-notice{min-height:1em;color:#9ce0ba;font-size:12px}#messages{overflow-y:auto;overscroll-behavior:contain;min-height:0;scrollbar-gutter:stable}.game-event{color:#9ce0ba;font-size:12px;margin-top:3px}.connection-state{font-weight:700}#header-account button{margin:0}.empty{color:#999eaa;padding:12px 4px}a{color:#c59cff}@media(max-width:760px){body{height:100%;overflow:hidden;grid-template-rows:auto minmax(0,1fr)}.game{height:100%;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);overflow:hidden}.canvas-wrap{width:min(100%,calc(50vh - 65px));height:100%;aspect-ratio:1}.sidebar{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr);overflow:hidden}.chat{height:auto}}@media(max-width:560px){body{padding:6px;gap:5px}header .intro{font-size:12px}.game{gap:5px}.panel{padding:7px}.row{grid-template-columns:1fr;gap:3px;padding:5px 2px}.canvas-wrap{width:min(100%,calc(48vh - 55px))}}
</style></head><body>
<header><div class="heading"><h1>Lineup</h1><p class="intro">Twitch chat: <strong>!join</strong> in the lobby; active commands: !move 20d, !rotate 45, !color blue. See your line code in chat.</p><p id="round-status" class="intro">Waiting for round status…</p></div><div id="header-account" aria-label="Account controls"></div></header>
<main class="game"><section class="panel canvas-panel"><div class="canvas-wrap"><canvas id="canvas" aria-label="Shared Lineup drawing canvas"></canvas></div><p class="muted">A is hollow · B is filled · codes identify lines · overlap is allowed</p></section>
<aside class="sidebar"><section class="panel"><h2>Round and host controls</h2><p id="public-result" class="muted">No round has ended yet.</p><div id="host-access">Checking authorization…</div><p id="host-role-link" class="muted" hidden></p><p id="host-phase" class="muted">Loading…</p><p id="host-result"></p><p id="host-notice" role="status"></p><div id="host-controls"><button id="host-start" disabled>Start round</button><button id="host-end-round" disabled hidden>End round</button><button id="host-next" disabled hidden>Open next-round lobby</button><button id="host-new-match" disabled title="End this match and clear its participants and lines">End match / New match</button><button id="host-disconnect" disabled hidden>Disconnect Twitch</button><form id="host-guess-form" hidden><label for="host-guess">Guess the target word</label><input id="host-guess" maxlength="80" autocomplete="off"><button type="submit" disabled>Submit guess</button></form><p id="host-roster-note" class="muted">At least two viewers must join with !join before a round can start.</p></div></section>
<section class="panel chat"><h2>Twitch chat activity</h2><div class="status"><div id="state">Starting</div><div id="detail"></div></div><div id="messages"><div class="empty">Waiting for chat messages…</div></div></section></aside></main>
<script>
const $=selector=>document.querySelector(selector),stateEl=$('#state'),detailEl=$('#detail'),messagesEl=$('#messages'),roundStatus=$('#round-status'),publicResult=$('#public-result'),canvas=$('#canvas'),ctx=canvas.getContext('2d');
const hostAccess=$('#host-access'),headerAccount=$('#header-account'),hostPhase=$('#host-phase'),hostResult=$('#host-result'),hostNotice=$('#host-notice'),hostStart=$('#host-start'),hostEndRound=$('#host-end-round'),hostNext=$('#host-next'),hostNew=$('#host-new-match'),hostDisconnect=$('#host-disconnect'),hostGuessForm=$('#host-guess-form'),hostGuess=$('#host-guess'),hostRosterNote=$('#host-roster-note');let gameState,hostBusy=false;
function esc(value){return String(value).replace(/[&<>\"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]))}
function drawGame(){if(!gameState)return;const size=gameState.width,scale=Math.min(canvas.width,canvas.height)/size;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.save();ctx.scale(scale,scale);ctx.fillStyle='#12141a';ctx.fillRect(0,0,size,size);ctx.strokeStyle='#272b34';ctx.lineWidth=.12;for(let i=0;i<=size;i+=10){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,size);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(size,i);ctx.stroke()}ctx.strokeStyle='#626875';ctx.lineWidth=.35;ctx.strokeRect(0,0,size,size);for(const line of gameState.lines){ctx.strokeStyle=line.color;ctx.fillStyle=line.color;ctx.lineWidth=.65;ctx.beginPath();ctx.moveTo(line.a.x,line.a.y);ctx.lineTo(line.b.x,line.b.y);ctx.stroke();for(const [name,point] of [['A',line.a],['B',line.b]]){ctx.beginPath();ctx.arc(point.x,point.y,1.05,0,Math.PI*2);if(name==='A'){ctx.fillStyle='#12141a';ctx.fill();ctx.strokeStyle=line.color;ctx.lineWidth=.45;ctx.stroke()}else ctx.fill();ctx.font='2.5px system-ui';ctx.fillStyle=line.color;ctx.fillText(name,point.x+1.5,point.y-1.2)}ctx.font='2.5px ui-monospace,monospace';ctx.fillStyle=line.color;ctx.fillText(line.code||'',(line.a.x+line.b.x)/2+1.5,(line.a.y+line.b.y)/2-1.5)}ctx.restore()}
function resizeCanvas(){const rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);drawGame()}window.addEventListener('resize',resizeCanvas);
function renderHost(host){
 const authorized=Boolean(host.authenticated);
 hostAccess.innerHTML=host.accessMode==='development'?'<strong>LOCAL DEVELOPMENT ACCESS</strong> · Limited to local development.':host.accessMode==='broadcaster'?'<strong>Broadcaster verified.</strong>':'<a href="/host/login">Sign in with Twitch as the broadcaster</a>';
 const roleLink=$('#host-role-link');roleLink.hidden=!authorized||!host.roleRevealUrl;roleLink.innerHTML=authorized&&host.roleRevealUrl?'<a href="'+esc(host.roleRevealUrl)+'" target="_blank" rel="noopener">Open role-reveal page</a> · Shared link; roles are available during an active round.':'';
 headerAccount.innerHTML=host.accessMode==='broadcaster'?'<button id="host-logout" type="button">Sign out</button>':'';
 hostStart.disabled=!authorized||hostBusy||!host.canStart;
 hostEndRound.hidden=host.phase!=='active';hostEndRound.disabled=!authorized||hostBusy;
 hostNext.hidden=host.phase!=='ended';hostNext.disabled=!authorized||hostBusy;
 hostNew.disabled=!authorized||hostBusy;
 hostDisconnect.hidden=!authorized;hostDisconnect.disabled=!authorized||hostBusy;
 hostGuessForm.hidden=host.phase!=='active';hostGuessForm.querySelector('button').disabled=!authorized||hostBusy;
 hostPhase.textContent='Match '+host.matchNumber+' · Round '+host.roundNumber+' · '+host.phase+' · '+host.playerCount+' players'+(host.phase==='active'?' · '+Math.ceil(host.remainingMs/1000)+'s remaining':'');
 hostRosterNote.textContent=host.phase==='lobby'&&!host.canStart?'At least two viewers must join with !join before a round can start.':'Players are locked for this round once it starts.';
 if(host.result?.reason==='broadcaster-ended')hostResult.textContent='Round ended by broadcaster.';
 else hostResult.textContent=host.result?'Winner: '+host.result.winner:'';
 const logout=$('#host-logout');if(logout)logout.onclick=()=>hostAction('/api/host/logout');
 hostDisconnect.onclick=()=>{if(confirm('Disconnect this Twitch channel? You will need to sign in again to reconnect it.'))hostAction('/api/host/disconnect')};
}
const pathChannel=location.pathname.startsWith('/game/')?location.pathname.slice(6):null;const selectedChannel=pathChannel||new URLSearchParams(location.search).get('channel');const channelQuery=selectedChannel?'?channel='+encodeURIComponent(selectedChannel):'';
async function refresh(){
 try{
  const [stateResponse,gameResponse,hostResponse]=await Promise.all([fetch('/api/state'+channelQuery,{cache:'no-store'}),fetch('/api/game'+channelQuery,{cache:'no-store'}),fetch('/api/host/session'+channelQuery,{cache:'no-store'})]);
  const status=await stateResponse.json(),host=await hostResponse.json();gameState=await gameResponse.json();
  const eventSub=status.eventSub||{};
  const connection=eventSub.connection==='connected'&&eventSub.subscription==='enabled'?'Connected':eventSub.connection==='reconnecting'?'Reconnecting':eventSub.connection==='connecting'||eventSub.subscription==='pending'?'Connecting':'Disconnected';
  stateEl.textContent=connection;
  detailEl.textContent=(status.detail||'Twitch chat status unavailable.')+(eventSub.subscription&&eventSub.subscription!=='enabled'?' · Subscription: '+eventSub.subscription:'')+(status.incomingChat?' · Incoming messages: '+status.incomingChat.messagesReceived:'')+(status.roundAnnouncement?' · Round announcement: '+status.roundAnnouncement.status+(status.roundAnnouncement.detail?' — '+status.roundAnnouncement.detail:''):'')+' · Outgoing auth: '+(status.outgoingChat?.authorization||'unknown')+(status.outgoingChat?.detail?' — '+status.outgoingChat.detail:'')+(status.outgoingChat?.lastMessage?' · Last send: '+status.outgoingChat.lastMessage.status+' — '+status.outgoingChat.lastMessage.detail:'');
  if(!gameState.error){
   roundStatus.textContent='Match '+gameState.matchNumber+' · Round '+gameState.roundNumber+' · '+gameState.phase+(gameState.phase==='active'?' · '+Math.ceil(gameState.remainingMs/1000)+' seconds remaining':'')+' · '+gameState.playerCount+' players';
   if(gameState.result?.reason==='broadcaster-ended')publicResult.textContent='Round ended by broadcaster.';
   else publicResult.textContent=gameState.result?'Winner: '+gameState.result.winner+(gameState.result.reason==='correct-guess'?' · correct guess':' · time expired'):'No round has ended yet.';
   drawGame();
  }else{gameState=null;ctx.clearRect(0,0,canvas.width,canvas.height);roundStatus.textContent='Connect a Twitch channel to view its game.'}
  const followingLatest=messagesEl.scrollTop<=16;
  messagesEl.innerHTML=status.messages?.length?status.messages.map(message=>'<article class="row"><div><div class="name">'+esc(message.senderName)+(message.activity?'<span class="badge">ACTIVITY</span>':message.isBroadcaster?'<span class="badge">BROADCASTER</span>':'')+'</div><div class="meta">'+new Date(message.receivedAt).toLocaleTimeString()+'</div></div><div><div class="text">'+esc(message.text)+'</div>'+(message.gameEvent?'<div class="game-event">'+esc(message.gameEvent)+'</div>':'')+(message.commandOutcome&&message.commandOutcome.status!=='ignored'?'<div class="meta">Command: '+esc(message.commandOutcome.status)+(message.commandOutcome.lineCode?' · Line code '+esc(message.commandOutcome.lineCode):'')+(message.commandOutcome.reason?' · '+esc(message.commandOutcome.reason):'')+'</div>':'')+(message.replyStatus?'<div class="meta">Join reply: '+esc(message.replyStatus.status)+' — '+esc(message.replyStatus.detail)+'</div>':'')+'</div></article>').join(''):'<div class="empty">Waiting for chat messages…</div>';
  if(followingLatest)messagesEl.scrollTop=0;
  renderHost(host);
 }catch{stateEl.textContent='Disconnected';detailEl.textContent='Could not reach the Lineup server. Check that it is running.'}
}
function disableHostActions(){for(const button of [hostStart,hostEndRound,hostNext,hostNew,hostDisconnect,hostGuessForm.querySelector('button')])button.disabled=true}
async function hostAction(path,body){if(hostBusy)return;hostBusy=true;hostNotice.textContent='';disableHostActions();let succeeded=false;try{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:body===undefined?'{}':JSON.stringify(body)}),data=await response.json();if(!response.ok)throw Error(data.message||data.error||'Host action failed');succeeded=true;hostNotice.textContent=data.message||'';if(path.endsWith('/guess'))hostGuess.value=''}catch(error){hostNotice.textContent=error.message}finally{hostBusy=false;if(succeeded&&(path.endsWith('/disconnect')||path.endsWith('/logout')))location.assign('/');else refresh()}}
hostStart.onclick=()=>hostAction('/api/host/start');hostEndRound.onclick=()=>hostAction('/api/host/end-round');hostNext.onclick=()=>hostAction('/api/host/next-round');hostNew.onclick=()=>{if(confirm('End this match and clear its participants, lines, and round state?'))hostAction('/api/host/new-match')};hostDisconnect.onclick=()=>{if(confirm('Disconnect this Twitch channel? You will need to sign in again to reconnect it.'))hostAction('/api/host/disconnect')};hostGuessForm.addEventListener('submit',event=>{event.preventDefault();hostAction('/api/host/guess',{guess:hostGuess.value})});
resizeCanvas();refresh();setInterval(refresh,1000);
</script></body></html>`;

function loginPage(message = '', showRetry = false) {
  const notice = message ? `<p role="alert" style="padding:12px;background:#35242a;border-radius:8px;color:#ffd5dc">${String(message).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])}</p>` : '';
  const retry = showRetry ? '<p><a href="/host/login" style="color:#c59cff">Try Twitch sign-in again</a></p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lineup — Sign in</title><style>:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#111318;color:#eef0f6}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(100%,520px);padding:32px;background:#191c23;border:1px solid #30343e;border-radius:14px;box-shadow:0 18px 60px #0006}h1{font-size:36px;margin:0 0 8px;color:#c59cff}.muted{color:#b7bbc6;line-height:1.6}a.button{display:inline-block;margin-top:14px;padding:12px 20px;border-radius:8px;background:#9147ff;color:white;font-weight:700;text-decoration:none}a.button:hover{background:#a76bff}</style></head><body><main class="card"><h1>Lineup</h1><p class="muted">A Twitch chat drawing game. Your community builds a picture together while you try to guess the hidden word.</p>${notice}${retry}<p><strong>Broadcaster sign-in</strong></p><p class="muted">Sign in with the Twitch account that owns the channel where you want to host Lineup. Twitch will ask you to authorize Lineup directly.</p><a class="button" href="/host/login">Sign in with Twitch</a></main></body></html>`;
}

function sendHtml(response, status, html) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(html);
}

function sendOAuthFailure(response, status, message, clearCookie = '') {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...(clearCookie ? { 'Set-Cookie': clearCookie } : {}) });
  response.end(loginPage(message, true));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [part, ''];
    try { return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))]; }
    catch { return [part.slice(0, separator), '']; }
  }));
}

function sameOriginRequest(request) {
  return isSameOriginApplicationRequest({ nodeEnv: NODE_ENV, requestHost: request.headers.host,
    requestOrigin: request.headers.origin, developmentOrigin: redirectUrl.origin, publicOrigin: publicOrigin?.origin });
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

function beginOAuth(response) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return sendOAuthFailure(response, 503, 'Twitch sign-in is not configured yet. Set the Lineup Client ID and TWITCH_CLIENT_SECRET, then restart the server. ');
  }
  const currentTime = Date.now();
  for (const [key, attempt] of oauthStates) if (attempt.expiresAt <= currentTime) oauthStates.delete(key);
  for (const [key, session] of hostSessions) if (session.expiresAt <= currentTime) hostSessions.delete(key);
  const oauthState = randomBytes(32).toString('hex');
  oauthStates.set(oauthState, { expiresAt: currentTime + OAUTH_STATE_TTL_MS });
  const authorize = createTwitchAuthorizationUrl({ clientId: CLIENT_ID, redirectUri: OAUTH_REDIRECT_URI, state: oauthState });
  console.info(`[OAuth] Starting Twitch authorization at ${authorize.origin}${authorize.pathname}; callback=${OAUTH_REDIRECT_URI}; scopes=user:read:chat,user:write:chat; client_id_configured=${Boolean(CLIENT_ID)}.`);
  response.writeHead(302, { Location: authorize.toString(), 'Cache-Control': 'no-store', 'Set-Cookie': `lineup_oauth_state=${oauthState}; HttpOnly; SameSite=Lax; Path=/host/callback; Max-Age=600${SECURE_COOKIE}` });
  response.end();
}

async function readJsonBody(request, maxBytes = 2048) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RangeError('Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new TypeError('Request body must be valid JSON.');
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${PORT}`}`);
  const canonicalLocation = canonicalLoopbackRedirect({ nodeEnv: NODE_ENV, requestHostname: requestUrl.hostname,
    requestHost: request.headers.host, redirectHostname: redirectUrl.hostname, redirectHost: redirectUrl.host,
    pathname: requestUrl.pathname, search: requestUrl.search });
  if (canonicalLocation) {
    response.writeHead(308, { Location: canonicalLocation, 'Cache-Control': 'no-store' });
    return response.end();
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/game') {
    const session = selectPublicSession(request, requestUrl);
    return sendJson(response, session ? 200 : 404, session ? session.getPublicState() : { error: 'Select a connected channel with ?channel=<broadcaster-id>.' });
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/state') {
    const session = selectPublicSession(request, requestUrl);
    return sendJson(response, session ? 200 : 404, session ? session.getState() : { error: 'No connected channel selected.' });
  }
  const rolePageMatch = requestUrl.pathname.match(/^\/role\/([A-Za-z0-9_-]+)$/);
  if (request.method === 'GET' && rolePageMatch && roleLinks.has(rolePageMatch[1])) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(renderRolePage(rolePageMatch[1]));
  }
  const roleStatusMatch = requestUrl.pathname.match(/^\/api\/role\/([A-Za-z0-9_-]+)\/status$/);
  if (request.method === 'GET' && roleStatusMatch && roleLinks.has(roleStatusMatch[1])) {
    const session = roleLinks.get(roleStatusMatch[1]);
    return sendJson(response, 200, rolePageStatus(session.getPublicState()));
  }
  const roleDrawMatch = requestUrl.pathname.match(/^\/api\/role\/([A-Za-z0-9_-]+)\/draw$/);
  if (request.method === 'POST' && roleDrawMatch && roleLinks.has(roleDrawMatch[1])) {
    if (!sameOriginRequest(request)) return sendJson(response, 403, { error: 'Role draws must come from the role page.' });
    const result = roleLinks.get(roleDrawMatch[1]).match.drawRole();
    const status = result.status === 'invalid-phase' ? 409 : result.status === 'exhausted' ? 410 : 200;
    const message = result.status === 'exhausted' ? 'All role slots for this round have been drawn.'
      : result.status === 'invalid-phase' ? 'Role draws are available only during an active round.' : undefined;
    return sendJson(response, status, { ...result, ...(message ? { message } : {}) });
  }
  if (request.method === 'GET' && requestUrl.pathname === '/host') {
    response.writeHead(303, { Location: '/host/login', 'Cache-Control': 'no-store' });
    return response.end();
  }
  if (request.method === 'GET' && requestUrl.pathname === '/host/login') { beginOAuth(response); return; }
  if (request.method === 'GET' && requestUrl.pathname === '/host/callback') {
    const browserState = parseCookies(request).lineup_oauth_state;
    const clearStateCookie = 'lineup_oauth_state=; HttpOnly; SameSite=Lax; Path=/host/callback; Max-Age=0';
    if (!consumeOAuthState(oauthStates, { cookieState: browserState, returnedState: requestUrl.searchParams.get('state') })) {
      return sendOAuthFailure(response, 400, 'Twitch sign-in could not be verified because its security state was invalid or expired. ', clearStateCookie);
    }
    oauthStates.delete(browserState);
    if (requestUrl.searchParams.has('error')) return sendOAuthFailure(response, 401, 'Twitch authorization was declined. ', clearStateCookie);
    const code = requestUrl.searchParams.get('code');
    if (!code || !CLIENT_ID || !CLIENT_SECRET) return sendOAuthFailure(response, 400, 'Twitch authorization callback is incomplete. Check the app configuration and try again. ', clearStateCookie);
    (async () => {
      const { token, identity } = await exchangeAndValidateOAuthCode({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, redirectUri: OAUTH_REDIRECT_URI });
      const assessment = assessBroadcasterChatToken(identity, { clientId: CLIENT_ID, broadcasterId: identity.user_id });
      if (!assessment.ok) return sendOAuthFailure(response, 403, `${assessment.detail} `, clearStateCookie);
      const oldSession = sessions.get(identity.user_id);
      if (oldSession) {
        oldSession.stop(); stopEventSub(identity.user_id);
        for (const [roleToken, linkedSession] of roleLinks) if (linkedSession === oldSession) roleLinks.delete(roleToken);
      }
      const session = makeSession(identity.user_id, token.access_token, { refreshToken: token.refresh_token });
      session.validateTokenMetadata(identity);
      session.setStatus('authorized', `Twitch token validated for broadcaster ${identity.user_id}; connecting to EventSub.`);
      connectEventSub(session);
      const sessionId = randomBytes(32).toString('hex');
      hostSessions.set(sessionId, { userId: identity.user_id, broadcasterId: identity.user_id, expiresAt: Date.now() + HOST_SESSION_TTL_MS });
      response.writeHead(303, { Location: broadcasterGamePath(identity.user_id), 'Cache-Control': 'no-store', 'Set-Cookie': [clearStateCookie, `lineup_host_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${HOST_SESSION_TTL_MS / 1000}${SECURE_COOKIE}`] });
      response.end();
    })().catch(() => sendOAuthFailure(response, 502, 'Twitch sign-in failed while contacting Twitch. Check connectivity, the registered callback URL, and app credentials, then retry. ', clearStateCookie));
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/host/session') {
    const host = sessionFromHostCookie(request);
    const selected = requestUrl.searchParams.get('channel');
    if (host && selected && selected !== host.session.broadcasterId) return sendJson(response, 403, { error: 'This host session cannot access another channel.' });
    const session = host?.session || (selected ? sessions.get(selected) : selectPublicSession(request, requestUrl));
    if (!session) return sendJson(response, 404, { error: 'No connected channel selected.' });
    const verifiedHost = host && host.host.userId === session.broadcasterId ? { userId: host.host.userId } : null;
    const allowDevHost = !host && session.broadcasterId === BROADCASTER_ID;
    const identity = getHostActionIdentity(allowDevHost ? process.env : { NODE_ENV: 'production' }, verifiedHost, session.broadcasterId);
    return sendJson(response, 200, { ...(identity ? session.getHostState() : session.getPublicState()), authenticated: Boolean(identity), accessMode: identity?.accessMode || null, durationMs: ROUND_DURATION_MS,
      ...(identity ? { roleRevealUrl: buildRoleRevealUrl({ nodeEnv: NODE_ENV, rolePath: session.rolePath, publicOrigin: publicOrigin?.origin, localOrigin: redirectUrl.origin }) } : {}) });
  }
  const hostActions = ['/api/host/start', '/api/host/end-round', '/api/host/new-match', '/api/host/next-round', '/api/host/guess', '/api/host/logout', '/api/host/disconnect'];
  if (request.method === 'POST' && hostActions.includes(requestUrl.pathname)) {
    if (!sameOriginRequest(request)) return sendJson(response, 403, { error: 'Host control request must come from this application origin.' });
    const host = sessionFromHostCookie(request);
    const devSession = NODE_ENV === 'development' && process.env.ENABLE_LOCAL_DEV_HOST === 'true' && BROADCASTER_ID ? sessions.get(BROADCASTER_ID) : null;
    const session = host?.session || devSession;
    const identity = getHostActionIdentity(process.env, host ? { userId: host.host.userId } : null, session?.broadcasterId);
    if (!session || !identity) return sendJson(response, 401, { error: 'Sign in with this channel’s broadcaster account first.' });
    if (requestUrl.pathname === '/api/host/logout') {
      if (host) invalidateHostSession(hostSessions, host.id);
      return sendJson(response, 200, { message: 'Signed out.' }, { 'Set-Cookie': 'lineup_host_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (requestUrl.pathname === '/api/host/disconnect') {
      session.stop(); stopEventSub(session.broadcasterId);
      sessions.delete(session.broadcasterId);
      for (const [token, linkedSession] of roleLinks) if (linkedSession === session) roleLinks.delete(token);
      for (const [cookieId, hostRecord] of hostSessions) if (hostRecord.broadcasterId === session.broadcasterId) hostSessions.delete(cookieId);
      return sendJson(response, 200, { message: 'Twitch channel disconnected.' }, { 'Set-Cookie': 'lineup_host_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    let result;
    if (requestUrl.pathname === '/api/host/start') {
      result = session.match.startRound(identity.userId, session.broadcasterId);
      if (result.status === 'started') {
        const announcement = await session.announceRound(result.roundNumber);
        result = { ...result, announcement };
        if (announcement.status === 'sent' || announcement.status === 'already-sent') {
          console.info(`[Lineup] Role link announcement ${announcement.status} for broadcaster ${session.broadcasterId}, match ${session.match.getPublicState(session.game).matchNumber}, round ${result.roundNumber}.`);
        } else {
          console.warn(`[Lineup] Role link announcement ${announcement.status} for broadcaster ${session.broadcasterId}, round ${result.roundNumber}: ${announcement.detail || 'No confirmation from Twitch.'}`);
        }
      }
    } else if (requestUrl.pathname === '/api/host/end-round') {
      result = session.match.endRound(identity.userId, session.broadcasterId);
      if (result.status === 'ended') session.addActivity('Round ended by broadcaster.', 'info');
    } else if (requestUrl.pathname === '/api/host/next-round') result = session.match.nextRound(identity.userId, session.broadcasterId);
    else if (requestUrl.pathname === '/api/host/guess') {
      let body;
      try { body = await readJsonBody(request); } catch (error) { return sendJson(response, error instanceof RangeError ? 413 : 400, { error: error.message }); }
      result = session.match.submitGuess(identity.userId, session.broadcasterId, body?.guess);
    } else {
      result = session.match.newMatch(identity.userId, session.broadcasterId);
      if (result.status === 'reset') session.addActivity('Match ended; roster and lines cleared for the next match.', 'info');
    }
    let message = 'Request completed.';
    if (result.status === 'started') {
      const announcement = result.announcement;
      message = announcement?.status === 'sent' || announcement?.status === 'already-sent'
        ? 'Round started. The role-reveal link was confirmed in Twitch chat.'
        : `Round started, but the role link was not sent (${announcement?.status || 'unknown'}): ${announcement?.detail || 'Twitch did not confirm sending.'}`;
    } else if (result.status === 'ended') message = 'Round ended by broadcaster.';
    else if (result.status === 'insufficient-players') message = 'At least two viewers must join before a round can start.';
    else if (result.status === 'reset') message = requestUrl.pathname.endsWith('/next-round') ? 'Next-round lobby opened.' : 'Match ended and reset; broadcaster remains connected.';
    else if (result.status === 'correct') message = 'Correct guess. Builders win.';
    else if (result.status === 'incorrect') message = 'Incorrect guess. The round continues.';
    else if (result.status === 'invalid-phase') message = 'This action is not available in the current phase.';
    else if (result.status === 'invalid-guess') message = 'Enter a guess before submitting.';
    else if (result.status === 'unauthorized') message = 'Broadcaster authorization failed.';
    if (result.status === 'reset' && requestUrl.pathname.endsWith('/next-round')) session.addActivity('Next-round lobby opened.', 'info');
    return sendJson(response, result.status === 'invalid-phase' ? 409 : result.status === 'unauthorized' ? 403 : 200, { ...result, message });
  }
  if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
    const host = sessionFromHostCookie(request);
    if (host) {
      response.writeHead(303, { Location: broadcasterGamePath(host.session.broadcasterId), 'Cache-Control': 'no-store' });
      return response.end();
    }
    return sendHtml(response, 200, loginPage());
  }
  const gameRoute = requestUrl.pathname.match(/^\/game\/([0-9]+)$/);
  if (request.method === 'GET' && gameRoute) {
    const host = sessionFromHostCookie(request);
    if (!host) return sendHtml(response, 401, loginPage('Sign in as this channel’s broadcaster to open its game. '));
    if (host.session.broadcasterId !== gameRoute[1]) return sendHtml(response, 403, loginPage('This browser session belongs to a different broadcaster. Sign in as the channel owner to continue. '));
    return sendHtml(response, 200, page);
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[Local server] Port ${PORT} is already in use. Set PORT to another available port and restart.`);
  } else {
    console.error(`[Local server] Could not listen on 127.0.0.1:${PORT} (${error.code || 'unknown error'}).`);
  }
  process.exitCode = 1;
});

server.listen(PORT, NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', async () => {
  console.log(`Lineup server listening on port ${PORT}.`);
  console.log(`Twitch OAuth callback configured as ${OAUTH_REDIRECT_URI}.`);
  if (!PUBLIC_APP_URL) console.warn('[Lineup] PUBLIC_APP_URL is unset; round links can be opened locally by the host but cannot be announced to Twitch chat.');
  else if (!publicOrigin) console.warn('[Lineup] PUBLIC_APP_URL is not a valid public HTTPS origin; role-link announcements are blocked.');
  if (CLIENT_ID && ACCESS_TOKEN && BROADCASTER_ID) {
    try {
      const bootstrapSession = makeSession(BROADCASTER_ID, ACCESS_TOKEN);
      const identity = await bootstrapSession.validate();
      if (identity.user_id !== BROADCASTER_ID) throw new Error('Configured chat token owner does not match TWITCH_BROADCASTER_ID.');
      bootstrapSession.setStatus('authorized', `Configured broadcaster ${BROADCASTER_ID} validated; connecting to EventSub.`);
      connectEventSub(bootstrapSession);
    } catch (error) {
      const session = sessions.get(BROADCASTER_ID);
      session?.setStatus('setup required', error.message || 'Could not validate the configured Twitch token.');
    }
  } else {
    console.log('No legacy Twitch channel bootstrap is configured; use /host/login to connect a broadcaster.');
  }
});

// Keep each active user token validated. Expired/revoked authorizations are
// isolated to that channel; other broadcasters continue running.
const validationTimer = setInterval(async () => {
  if (shuttingDown) return;
  for (const session of sessions.values()) {
    try { await session.validate(); }
    catch (error) {
      if (session.outgoingChat.authorization === 'invalid-token') {
        try {
          await session.refreshAuthorization();
          stopEventSub(session.broadcasterId);
          session.setStatus('authorized', 'Twitch authorization refreshed; reconnecting EventSub.');
          connectEventSub(session);
        } catch (refreshError) {
          session.setStatus('authorization error', refreshError.message || error.message || 'Twitch token validation failed.');
          const connection = eventSubs.get(session.broadcasterId);
          if (connection) { connection.stopped = true; connection.socket?.close(); }
        }
      } else {
        session.setStatus('authorization check unavailable', error.message || 'Twitch token validation failed.');
      }
    }
  }
}, 60 * 60 * 1000);

function shutdown() {
  shuttingDown = true;
  for (const session of sessions.values()) session.stop();
  clearInterval(validationTimer);
  for (const id of eventSubs.keys()) stopEventSub(id);
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
