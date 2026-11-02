# Lineup

Lineup is a Twitch chat drawing and social deduction game. Viewers join during
the lobby, each receive a uniquely coded line, and control only their own line
on the shared 100 × 100 canvas. Builders cooperate to make the target word
recognizable; Saboteurs try to make it harder to recognize.

## Requirements and configuration

Requires Node.js 22 or newer. The app has no runtime npm dependencies.

Copy `.env.example` to `.env` and configure. `TWITCH_CLIENT_SECRET` is required for the streamer OAuth flow:

- `TWITCH_CLIENT_ID`: Twitch application client ID.
- `TWITCH_CLIENT_SECRET`: required for broadcaster host OAuth.
- `TWITCH_ACCESS_TOKEN` and `TWITCH_BROADCASTER_ID`: optional legacy bootstrap for one locally configured channel. For normal multi-streamer use, each broadcaster connects through Twitch OAuth and the resulting token stays server-side in memory.
- `TWITCH_HOST_REDIRECT_URI`: registered callback. For production, set it to
  `PUBLIC_APP_URL/host/callback`.
- `PUBLIC_APP_URL`: optional bare HTTPS origin for deployment, such as
  `https://lineup-demo.com`. When set, a round start posts the absolute
  `/role/<unpredictable-token>` URL to chat. If it is absent, Lineup does not
  post a link and never substitutes localhost. During local development, an
  authenticated host page shows a localhost role-page link for testing only;
  it is never sent to Twitch.
- `PORT`: optional local or hosting-provider port; defaults to 3000.

Keep `.env` private. It is ignored by Git. Tokens remain server-side.

### Connect a Twitch channel

Open the Lineup origin. Without a broadcaster session, it displays the in-app sign-in screen. The **Sign in with Twitch** button starts Lineup's OAuth flow at Twitch's official authorization endpoint. Authorize while signed in as the channel owner. OAuth asks for `user:read:chat` and `user:write:chat`; the callback verifies the token with Twitch before it creates a channel session and EventSub subscription, then redirects to `/game/<broadcaster-id>`. That channel-specific path requires the matching HttpOnly broadcaster session to display the host game. If local browsing uses a different loopback hostname from the registered callback, Lineup redirects it to the callback's canonical hostname. Host actions use the cookie-bound verified broadcaster ID, never a client-supplied identity. The optional environment token can bootstrap the originally configured local channel. OAuth access and rotating refresh tokens are held only in server memory. The server refreshes a session after token validation fails, then reconnects its EventSub socket; restart recovery and durable encrypted credential storage are not implemented.

## Run and test

```sh
npm start
npm test
```

Open <http://localhost:3000>. In development the server binds to `127.0.0.1`,
validates the configured broadcaster chat token, and subscribes to
`channel.chat.message` through Twitch EventSub WebSocket. In production, set
`NODE_ENV=production`, configure `PUBLIC_APP_URL`, and run behind the hosting
provider's HTTPS reverse proxy; the Node process binds to `0.0.0.0` for the
provider's port routing.

For local host-control testing only:

```sh
NODE_ENV=development ENABLE_LOCAL_DEV_HOST=true npm start
```

The bypass requires both settings and is ignored in production. It applies only to the legacy configured broadcaster session. OAuth callback must exactly match the Twitch Developer Console registration.

## Rounds and Twitch chat

Viewers send `!join` during the lobby. Each Twitch user can join once per match;
the roster closes when a round starts. At least two players are required.
Each line gets a unique `AAA000` style code from the game backend. A successful
join receives `@viewer Your line code is ABC123.` in chat when the broadcaster
token has `user:write:chat`. Repeating `!join` reuses the existing line and
code. The reply is sent as the broadcaster, not a separate bot account. Send
failures do not undo the join and are reported in the local chat activity list.

Starting a round picks a word, shuffles the role slots, and starts a three
minute timer. The pool is approximately 70% Builders and 30% Saboteurs. The
host submits guesses in the host controls. A correct guess wins for Builders;
timeout wins for Saboteurs. Round results expose the winner and reason; the
target word remains confined to a successful role-page draw. The host can open
another round with the same roster or start a fresh match.

When both `PUBLIC_APP_URL` and `user:write:chat` are configured, starting a
round posts the direct shared role page URL to Twitch chat. The link has a
random token and opens the **Role Assignment** page. Its purple, responsive
LEGO-inspired frame presents **Get My Role** before showing the allocated role
and current round word. Each click consumes one slot from the server's
pre-shuffled 70:30 pool, including exactly 7 Builders and 3 Saboteurs for 10
players; the pool size is the number of participants in the match. The button
can be clicked again to draw another role until the pool is empty. The shared
link does not verify Twitch identity, and Lineup does not claim that a role
draw is identity-verified private delivery.
`PUBLIC_APP_URL` must be the externally reachable HTTPS origin viewers use;
Lineup rejects localhost and loopback URLs. For production, set both
`PUBLIC_APP_URL=https://<your-deployed-host>` and
`TWITCH_HOST_REDIRECT_URI=https://<your-deployed-host>/host/callback`, then
register that exact callback URL in the Twitch Developer Console. Do not use
the token generator as the callback. Without a public URL, the round still
starts, but the dashboard reports that the announcement was blocked and why.
A round announcement is marked sent only when Twitch confirms submission.

The broadcaster controls can end an active round without awarding either team,
open the next-round lobby with the same roster, or end the match and clear its
participants and lines. Ending a match leaves the broadcaster signed in and
connected. **Disconnect Twitch** stops only that channel's EventSub session and
removes its channel session; **Sign out** invalidates the current browser's
host session. Chat activity and connection/subscription status are shown in the
dashboard for the selected broadcaster, and the activity list remains scoped
to that broadcaster.

Chat commands:

- `!join` — join during lobby.
- `!move 20l`, `!move 20r`, `!move 20u`, `!move 20d` — translate both endpoints
  equally. Amounts are 1–100; a move is rejected if either endpoint leaves the
  canvas.
- `!rotate 45` — rotate around endpoint B. Positive rotation is clockwise on
  screen. Values −3600 to 3600 degrees are accepted if the result stays in the
  canvas.
- `!color blue` — change the owned line's color.

Lines may cross or overlap. Endpoint A is hollow; B is filled. Line ownership
comes from Twitch's `chatter_user_id`. Duplicate EventSub message IDs are
ignored. Public game state does not expose owner IDs, roles, or the active
word; the host active-round state also omits the word. The app redacts target
word occurrences from its own public chat activity while the round is active.
Twitch chat itself remains public.

## Production configuration and limitations

The supplied Render origin is `https://line-up-twitch-game.onrender.com`.
Configure `PUBLIC_APP_URL` to that HTTPS origin and
`TWITCH_HOST_REDIRECT_URI` to its `/host/callback` path in the deployment
provider and Twitch Developer Console. The local `.env` uses those variable
names and was checked against the supplied origin; its values are never
committed. This repository change does not deploy automatically.

The code runs behind an HTTPS-terminating reverse proxy with
`NODE_ENV=production` and the provider's `PORT`.

Multiple broadcaster sessions can coexist in one process. Each session owns its game, match, timer, EventSub socket, chat history, deduplicator, role link, and outgoing sender. Commands are rejected if the EventSub message broadcaster ID does not match the receiving session. Public APIs select a channel using `?channel=<broadcaster-id>`; authenticated host actions use the cookie-bound broadcaster session. The configured legacy token can still bootstrap one channel.

Connections, OAuth access tokens, host sessions, and game state are held in memory. Encrypted durable credential storage and process restart recovery are not implemented. Restarting loses games and requires broadcasters to connect again. A broadcaster can disconnect their own channel from the host page without affecting other sessions. These source changes need to be deployed before they appear on the public Render site.

Automated tests cover game geometry, line ownership, lifecycle, role allocation,
browser claim persistence, secret isolation, the role and dashboard pages,
chat reply payloads, direct HTTPS announcement URLs, duplicate announcement
suppression, disconnected chat, and missing public URL behavior. They do not
verify a live Twitch send, EventSub session, OAuth callback, two simultaneously
authorized broadcasters, or rendered production appearance.
