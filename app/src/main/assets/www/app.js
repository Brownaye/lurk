/* global auth, authStatus, onAuth, signIn, cancelSignIn, signOut, pending, checkLive, lastRoster, chat */
'use strict';
// The screens: sign in, who is live, and what sits under the video while watching (stream details and chat).
// The video itself is a separate web view the app puts above this page (Native.play / Native.stop).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POLL_EVERY = 60e3;

const S = {
  channels: lastRoster(),
  watching: null,   // the channel being watched
  checking: false,
  error: null,
  checkedAt: 0,
};

const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));
function fmtSpan(ms) {
  const m = Math.max(0, Math.floor(ms / 60e3));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
const setAv = (el, url) => { el.style.backgroundImage = url ? `url("${String(url).replace(/["\\]/g, '')}")` : ''; };
const avHtml = (c) => `<span class="av"${c.avatar ? ` style="background-image:url('${esc(c.avatar)}')"` : ''}></span>`;

// ---------- which screen ----------
function show() {
  const signedIn = authStatus().signedIn;
  $('signin').hidden = signedIn;
  $('list').hidden = !signedIn || !!S.watching;
  $('watch').hidden = !signedIn || !S.watching;
}

// ---------- sign in ----------
function renderSignIn(st) {
  $('b-signin').hidden = !!st.pending;
  $('pending').hidden = !st.pending;
  if (st.pending) $('pending-code').textContent = st.pending.code;
  if ('error' in st) { $('signin-error').textContent = st.error || ''; $('signin-error').hidden = !st.error; }
}

$('b-signin').addEventListener('click', async () => {
  $('b-signin').disabled = true;
  const st = await signIn();
  $('b-signin').disabled = false;
  renderSignIn({ error: null, ...st });
});
$('b-cancel').addEventListener('click', () => cancelSignIn());
$('b-reopen').addEventListener('click', () => { if (pending && window.Native) window.Native.signInPage(pending.uri, pending.code); });

onAuth((st) => {
  renderSignIn(st);
  if (!st.signedIn) { closeWatch(); S.channels = []; S.error = null; }
  show();
  if (st.signedIn) { renderMe(); renderList(); check({ fresh: true }); }
});

// ---------- who is live ----------
function liveRowHtml(c) {
  const since = Date.parse(c.startedAt) || Date.now();
  return `<div class="tw" data-live="${esc(c.login)}" role="button">
    <div class="tw-thumb">${c.thumb ? `<img src="${esc(c.thumb)}" alt="" loading="lazy">` : ''}<span class="tw-badge">LIVE</span><span class="tw-viewers">${fmtNum(c.viewers)}</span><span class="tw-up" data-since="${since}">${fmtSpan(Date.now() - since)}</span></div>
    <div class="tw-info">
      <div class="tw-head">${avHtml(c)}<span class="tw-name">${esc(c.display)}</span></div>
      <div class="tw-title">${esc(c.title || '(no title)')}</div>
      <div class="tw-game">${esc(c.game || '')}</div>
    </div>
  </div>`;
}
const offRowHtml = (c) => `<div class="off">${avHtml(c)}<span class="off-name">${esc(c.display)}</span></div>`;

function renderList() {
  const live = S.channels.filter((c) => c.live).sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
  const off = S.channels.filter((c) => !c.live).sort((a, b) => a.display.localeCompare(b.display));
  $('n-live').textContent = S.channels.length ? String(live.length) : '';
  const note = $('list-note');
  note.textContent = S.error || (S.checking && !S.channels.length ? 'Checking...' : '');
  note.classList.toggle('bad', !!S.error);
  $('b-refresh').classList.toggle('spin', S.checking);
  const rows = $('rows');
  const top = rows.scrollTop;
  rows.innerHTML = !S.channels.length
    ? `<div class="empty">${S.checking ? 'Checking who is live...' : S.error ? esc(S.error) : 'You do not follow anyone on Twitch yet.'}</div>`
    : `${live.map(liveRowHtml).join('') || '<div class="empty">Nobody you follow is live right now.</div>'}
       ${off.length ? `<div class="day">Offline (${off.length})</div>${off.map(offRowHtml).join('')}` : ''}`;
  rows.scrollTop = top;
}

$('rows').addEventListener('click', (e) => {
  const row = e.target.closest('[data-live]');
  if (!row) return;
  const c = S.channels.find((x) => x.login === row.dataset.live);
  if (c) watch(c);
});

async function check({ fresh = false } = {}) {
  if (S.checking || !authStatus().signedIn) return;
  S.checking = true;
  renderList();
  try {
    S.channels = await checkLive({ fresh });
    S.error = null;
    S.checkedAt = Date.now();
  } catch (e) {
    if (e.code !== 'SIGNED_OUT') S.error = e.message;
  }
  S.checking = false;
  renderList();
  renderWatch();
}
$('b-refresh').addEventListener('click', () => check({ fresh: true }));

function renderMe() {
  const u = authStatus().user;
  if (!u) return;
  setAv($('me-av'), u.avatar);
  $('menu-who').textContent = `Signed in as ${u.display}`;
}
$('b-me').addEventListener('click', (e) => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('menu').hidden = true; });
$('b-signout').addEventListener('click', () => { $('menu').hidden = true; signOut(); });

// ---------- watching ----------
const liveUrl = (login) => `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=twitch.tv&autoplay=true&muted=false`;

function watch(c) {
  S.watching = c;
  if (window.Native) window.Native.play(liveUrl(c.login));
  show();
  renderWatch();
  chat.open({ login: c.login, display: c.display, id: c.id });
}

function closeWatch() {
  if (!S.watching) return;
  S.watching = null;
  if (window.Native) window.Native.stop();
  chat.close();
  if (document.activeElement) document.activeElement.blur();
  show();
  renderList();
}
$('b-back').addEventListener('click', closeWatch);

// The details under the video follow the latest check (title, category, viewers, or that the stream has ended).
function renderWatch() {
  if (!S.watching) return;
  const c = S.channels.find((x) => x.login === S.watching.login) || S.watching;
  if (c.live) S.watching = c;
  setAv($('w-av'), c.avatar);
  $('w-name').textContent = c.display;
  const sub = $('w-sub');
  sub.classList.toggle('off', !c.live);
  sub.textContent = c.live ? [c.game, `${fmtNum(c.viewers)} watching`].filter(Boolean).join(' \u00b7 ') : 'Offline: the stream has ended';
  $('w-title').textContent = c.live ? c.title || '' : '';
  const up = $('w-up');
  if (c.live && c.startedAt) { up.dataset.since = String(Date.parse(c.startedAt) || Date.now()); up.textContent = fmtSpan(Date.now() - Number(up.dataset.since)); }
  else { delete up.dataset.since; up.textContent = ''; }
}

// ---------- hooks the app calls ----------
// Back button: true if this page used it.
window.__back = () => {
  if (!$('menu').hidden) { $('menu').hidden = true; return true; }
  if (S.watching) { closeWatch(); return true; }
  return false;
};
// The app came back to the front.
window.__resume = () => {
  chat.resume();
  if (Date.now() - S.checkedAt > 30e3) check();
};
window.__layout = () => {};

// ---------- clocks ----------
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtSpan(Date.now() - Number(el.dataset.since)); });
}, 30e3);
setInterval(() => { if (!document.hidden) check(); }, POLL_EVERY);

// ---------- start ----------
renderSignIn(authStatus());
show();
if (authStatus().signedIn) { renderMe(); renderList(); check({ fresh: true }); }
