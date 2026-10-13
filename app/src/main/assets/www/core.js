'use strict';
// Storage, HTTP through the app (no CORS), signing in with Twitch (device code flow, public client id, as the
// desktop app does) and the Helix calls behind the Live list.

const CLIENT_ID = '2w915iqawzht7yok0cbsu6ecjlqaqk';
const SCOPES = 'user:read:follows chat:read chat:edit user:read:subscriptions user:read:emotes';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* unavailable */ } },
};

// ---------- http ----------
const waiting = new Map();
let seq = 0;
window.__native = {
  httpDone(id, status, text) {
    const done = waiting.get(id);
    if (done) { waiting.delete(id); done({ status, text }); }
  },
};

// { status, text }; status 0 = never reached the server. In a plain browser (no app around it) it falls back to fetch.
function http(method, url, headers = {}, body = '') {
  if (!window.Native) {
    return fetch(url, { method, headers, body: body || undefined })
      .then(async (r) => ({ status: r.status, text: await r.text() }))
      .catch((e) => ({ status: 0, text: e.message }));
  }
  return new Promise((resolve) => {
    const id = String(++seq);
    waiting.set(id, resolve);
    setTimeout(() => { if (waiting.delete(id)) resolve({ status: 0, text: 'timed out' }); }, 35000);
    window.Native.http(id, method, url, JSON.stringify(headers), body);
  });
}
const parseJson = (t) => { try { return JSON.parse(t) || {}; } catch { return {}; } };

// ---------- auth ----------
// { access, refresh, expiresAt, user: { id, login, display, avatar } }. Kept by the app rather than this page
// (window.Native), so the background check for who went live can use it, and refresh it, with the pages closed.
function readAuth() {
  let a = null;
  if (window.Native && window.Native.getAuth) { try { a = JSON.parse(window.Native.getAuth() || 'null'); } catch { a = null; } }
  if (!a) a = store.get('auth', null); // from before 1.3, or a plain browser
  return a && a.access && a.user && a.user.id ? a : null;
}
let auth = readAuth();
let pending = null;    // { code, cancel } while signing in
let refreshing = null;
const authListeners = [];
const onAuth = (fn) => authListeners.push(fn);
const authStatus = () => ({ signedIn: !!auth, user: auth ? auth.user : null, pending: pending ? { code: pending.code } : null });
const authChanged = (extra) => authListeners.forEach((fn) => fn({ ...authStatus(), ...(extra || {}) }));
function saveAuth() {
  if (window.Native && window.Native.setAuth) { window.Native.setAuth(auth ? JSON.stringify(auth) : ''); store.del('auth'); }
  else if (auth) store.set('auth', auth);
  else store.del('auth');
}
if (auth) saveAuth(); // moves a sign-in from before 1.3 across
// Back from the background: the background check may have refreshed the token meanwhile (refresh tokens are
// single use, so the newer pair is the only one that still works).
function reloadAuth() {
  const a = readAuth();
  if (a && auth && a.access !== auth.access) Object.assign(auth, { access: a.access, refresh: a.refresh, expiresAt: a.expiresAt });
}

function signedOutError() {
  const e = new Error('Sign in with Twitch first');
  e.code = 'SIGNED_OUT';
  return e;
}

async function tokenRequest(params) {
  const r = await http('POST', 'https://id.twitch.tv/oauth2/token', FORM, new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString());
  return { status: r.status, json: parseJson(r.text) };
}

function signOutLocal() {
  auth = null;
  saveAuth();
  authChanged();
}

// A valid access token, refreshed when it is close to expiring. null when signed out (or Twitch refused the
// refresh, which signs out). Throws only on a temporary failure (offline), keeping the sign-in.
async function token() {
  if (!auth) return null;
  if (auth.expiresAt - Date.now() > 5 * 60e3) return auth.access;
  if (!auth.refresh) { signOutLocal(); return null; }
  if (!refreshing) {
    const was = auth;
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh }).then(({ status, json }) => {
      if (auth !== was) return auth ? auth.access : null; // signed out (or in again) meanwhile
      if (status === 200 && json.access_token) {
        Object.assign(auth, { access: json.access_token, refresh: json.refresh_token || auth.refresh, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 });
        saveAuth();
        return auth.access;
      }
      if (status === 400 || status === 401 || status === 403) { signOutLocal(); return null; }
      throw new Error(status ? `Twitch could not refresh the sign-in right now (${status})` : 'Could not reach Twitch (offline?)');
    }).finally(() => { refreshing = null; });
  }
  return refreshing;
}

// Helix as the signed-in user (the whole response body).
async function helixRaw(path, params = [], retry = true) {
  const t = await token();
  if (!t) throw signedOutError();
  const qs = new URLSearchParams(params).toString();
  const r = await http('GET', `https://api.twitch.tv/helix${path}${qs ? `?${qs}` : ''}`, { 'Client-Id': CLIENT_ID, Authorization: `Bearer ${t}` });
  if (r.status === 401 && retry) { if (auth) auth.expiresAt = 0; return helixRaw(path, params, false); }
  if (r.status === 0) throw new Error('Could not reach Twitch (offline?)');
  if (r.status < 200 || r.status >= 300) throw new Error(`Twitch API ${r.status}: ${String(r.text).slice(0, 200)}`);
  return parseJson(r.text);
}
async function helix(path, params) {
  const data = await helixRaw(path, params);
  return Array.isArray(data.data) ? data.data : [];
}

// Start signing in: get a code, open Twitch's activation page inside the app (log in there, then Activate), and
// wait for Twitch to hand over the token.
async function signIn() {
  if (pending) return authStatus();
  const r = await http('POST', 'https://id.twitch.tv/oauth2/device', FORM, new URLSearchParams({ client_id: CLIENT_ID, scopes: SCOPES }).toString());
  const dev = parseJson(r.text);
  if (r.status === 0) return { ...authStatus(), error: 'Could not reach Twitch. Check your connection and try again.' };
  if (r.status !== 200 || !dev.device_code) return { ...authStatus(), error: `Twitch would not start a sign-in (${r.status})${dev.message ? `: ${dev.message}` : ''}` };

  let stopped = false;
  const finish = (err) => {
    if (stopped) return;
    stopped = true;
    pending = null;
    if (window.Native) window.Native.closeSignIn();
    authChanged({ error: err || null });
  };
  pending = { code: dev.user_code, uri: dev.verification_uri, cancel: () => finish('Sign-in cancelled') };
  if (window.Native) window.Native.signInPage(dev.verification_uri, dev.user_code);
  authChanged();

  const deadline = Date.now() + (dev.expires_in || 1800) * 1000;
  let wait = (dev.interval || 5) * 1000;
  (async () => {
    while (!stopped && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, wait));
      if (stopped) return;
      const { status, json } = await tokenRequest({ device_code: dev.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', scopes: SCOPES });
      if (stopped) return;
      if (status === 200 && json.access_token) {
        auth = { access: json.access_token, refresh: json.refresh_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000, scopes: json.scope || [] };
        try {
          const me = (await helix('/users'))[0];
          auth.user = { id: me.id, login: me.login, display: me.display_name, avatar: me.profile_image_url };
        } catch (e) { auth = null; finish(`Signed in, but could not read your account: ${e.message}`); return; }
        saveAuth();
        finish(null);
        return;
      }
      if (status === 0) continue; // offline for a moment: keep waiting
      const msg = String(json.message || '');
      if (/slow_down/.test(msg)) wait += 2000;
      else if (!/authorization_pending/.test(msg)) { finish(`Sign-in failed: ${msg || status}`); return; }
    }
    finish('Sign-in timed out');
  })().catch((e) => finish(`Sign-in failed: ${e.message}`));
  return authStatus();
}

// The sign-in page was closed by hand. The code stays valid, so keep waiting unless the user cancels on the
// sign-in screen: they may be finishing in their browser.
window.__signInClosed = () => authChanged();

function cancelSignIn() {
  if (pending) pending.cancel();
}

function signOut() {
  const t = auth && auth.access;
  auth = null;
  saveAuth();
  store.del('tw');
  if (t) http('POST', 'https://id.twitch.tv/oauth2/revoke', FORM, new URLSearchParams({ client_id: CLIENT_ID, token: t }).toString());
  if (window.Native) window.Native.clearCookies();
  authChanged();
}

// For chat: log in as you. null when signed out or offline.
async function chatLogin() {
  try {
    const t = await token();
    return t && auth ? { login: auth.user.login, display: auth.user.display, token: t } : null;
  } catch { return null; }
}

// ---------- who is live ----------
const FOLLOWS_EVERY = 10 * 60e3;
const USER_REFRESH = 24 * 3600e3;

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const thumb = (url) => (url ? `${url.replace('{width}', '440').replace('{height}', '248')}?t=${Math.floor(Date.now() / 300000)}` : null);

// Every channel you follow on Twitch (logins), in Twitch's order (most recently followed first).
async function followed() {
  const out = [];
  let after = null;
  do {
    const j = await helixRaw('/channels/followed', [['user_id', auth.user.id], ['first', '100'], ...(after ? [['after', after]] : [])]);
    out.push(...(j.data || []).map((f) => String(f.broadcaster_login).toLowerCase()));
    after = j.pagination && j.pagination.cursor;
  } while (after && out.length < 2000);
  return out;
}

// One check of every followed channel: the roster the Live list draws. Names and avatars are cached for a day and
// the follow list for ten minutes, so a normal check is one request per hundred channels.
async function checkLive({ fresh = false } = {}) {
  if (!auth) throw signedOutError();
  const st = store.get('tw', {});
  st.users = st.users || {};
  st.follows = st.follows || [];
  const now = Date.now();
  if (fresh || !st.follows.length || now - (st.followsAt || 0) > FOLLOWS_EVERY) {
    st.follows = await followed();
    st.followsAt = now;
  }
  // Channels added from search are checked along with the ones you follow on Twitch.
  const extra = typeof prefs !== 'undefined' && Array.isArray(prefs.extra) ? prefs.extra : [];
  const logins = [...new Set([...st.follows, ...extra])];
  const stale = logins.filter((l) => !st.users[l] || now - (st.users[l].at || 0) > USER_REFRESH);
  for (const group of chunk(stale, 100)) {
    const users = await helix('/users', group.map((l) => ['login', l]));
    for (const u of users) st.users[u.login.toLowerCase()] = { id: u.id, display: u.display_name, avatar: u.profile_image_url, at: now };
    for (const l of group) if (!st.users[l]) st.users[l] = { display: l, at: now };
  }
  const nowLive = new Map();
  for (const group of chunk(logins, 100)) {
    const streams = await helix('/streams', [['first', '100'], ...group.map((l) => ['user_login', l])]);
    for (const s of streams) nowLive.set(String(s.user_login).toLowerCase(), s);
  }
  for (const l of Object.keys(st.users)) if (!logins.includes(l)) delete st.users[l]; // unfollowed
  const channels = logins.map((l) => {
    const u = st.users[l] || {};
    const s = nowLive.get(l);
    const base = { login: l, id: u.id || null, display: u.display || l, avatar: u.avatar || null };
    return s
      ? { ...base, live: true, title: s.title, game: s.game_name, viewers: s.viewer_count, startedAt: s.started_at, thumb: thumb(s.thumbnail_url), mature: !!s.is_mature }
      : { ...base, live: false };
  });
  st.channels = channels;
  st.checkedAt = now;
  store.set('tw', st);
  return channels;
}

// What the last check found, for drawing something at once on opening the app.
const lastRoster = () => store.get('tw', {}).channels || [];
