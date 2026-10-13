/* global authStatus, onAuth, signIn, cancelSignIn, signOut, pending, checkLive, lastRoster, chat,
   prefs, savePrefs, isFav, setFav, hist, setWatched, recordVod, resumeAt, touchVod, noteLive, forget, continueList,
   clearHistory, addWatchTime, weekStats, loadVods, vodList, vodsAt, broadcastFor, lastLive, loadSchedule, sched,
   clearFetched, isHeart, setHeart, reloadAuth, helix, isExtra */
'use strict';
// The screens: sign in, the five tabs (Live, Continue, VODs, Schedule, Channels), Settings, and what sits under
// the video while watching (stream details and chat, or where you are in a past broadcast). The video itself is a
// separate web view the app puts above this page (Native.play / Native.stop).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const N = window.Native || null;
const SAMPLE_EVERY = 10; // seconds between position readings from the player

const ICONS = {
  live: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>',
  history: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/><polyline points="12 7 12 12 15 14"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/>',
  more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  rewind: '<polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

const TABS = [['live', 'Live', 'live'], ['continue', 'Continue', 'history'], ['vods', 'VODs', 'film'], ['schedule', 'Schedule', 'calendar'], ['channels', 'Channels', 'users']];

// ---------- state ----------
const S = {
  channels: lastRoster(),
  tab: 'live',
  settingsOpen: false,
  watching: null,    // { kind: 'live' | 'vod', login, display, avatar, cid, title, ... } (vod: id, dur, createdAt, url)
  checking: false, error: null, checkedAt: 0,
  vodsLoading: false, vodsError: null, vodFilter: { channel: '', unwatched: false }, vodShow: 40,
  schedLoading: false, schedError: null,
  chanFilter: '',
  background: false, // the app is out of sight (not counting picture-in-picture)
  sleep: null,       // sleep timer: { at } (a time) or { end: true } (the end of this past broadcast)
  searchOpen: false, searchState: '',
  openWanted: '',    // a tapped notification asked for this channel
};

// ---------- formatting ----------
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));
function fmtSpan(ms) {
  const m = Math.max(0, Math.floor(ms / 60e3));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const hm = (sec) => fmtSpan(sec * 1000);
function ago(t) {
  const m = Math.floor((Date.now() - t) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} days ago`;
}
function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400e3);
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  if (days === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const setAv = (el, url) => { el.style.backgroundImage = url ? `url("${String(url).replace(/["\\]/g, '')}")` : ''; };
const avHtml = (c) => `<span class="av"${c.avatar ? ` style="background-image:url('${esc(c.avatar)}')"` : ''}></span>`;
const liveChannels = () => S.channels.filter((c) => c.live);
const chan = (login) => S.channels.find((c) => c.login === login) || null;

// ---------- small pieces: toast, bottom sheet ----------
let snackTimer = null;
function snack(text, bad = false) {
  const el = $('snack');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { el.hidden = true; }, bad ? 4500 : 2600);
}

// A menu from the bottom of the screen. items: [{ label, fn, danger }]. `text` is an optional line under the title.
function sheet(title, items, text) {
  $('sheet-box').innerHTML = `<div class="sheet-title">${esc(title)}</div>${text ? `<div class="sheet-text">${esc(text)}</div>` : ''}
    ${items.map((it, i) => `<button class="sheet-item ${it.danger ? 'danger' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('')}
    <button class="sheet-item cancel" data-i="-1">Cancel</button>`;
  $('sheet').hidden = false;
  $('sheet-box').onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    closeSheet();
    const it = items[+b.dataset.i];
    if (it) it.fn();
  };
}
function closeSheet() { $('sheet').hidden = true; }
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

// ---------- which screen ----------
function show() {
  const signedIn = authStatus().signedIn;
  $('signin').hidden = signedIn;
  $('main').hidden = !signedIn || !!S.watching || S.settingsOpen || S.searchOpen;
  $('search').hidden = !signedIn || !!S.watching || !S.searchOpen;
  $('watch').hidden = !signedIn || !S.watching;
  $('settings').hidden = !signedIn || !!S.watching || !S.settingsOpen;
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
$('b-reopen').addEventListener('click', () => { if (pending && N) N.signInPage(pending.uri, pending.code); });

onAuth((st) => {
  renderSignIn(st);
  if (!st.signedIn) { closeWatch(); S.channels = []; S.error = null; S.settingsOpen = false; S.searchOpen = false; clearFetched(); }
  show();
  if (st.signedIn) { renderMe(); S.tab = 'live'; render(); check({ fresh: true }); }
});

// ---------- tabs ----------
function renderTabs() {
  const nLive = liveChannels().length;
  const nCont = continueList().length;
  $('tabs').innerHTML = TABS.map(([id, label, ic]) => {
    const n = id === 'live' ? nLive : id === 'continue' ? nCont : 0;
    return `<button class="tab ${S.tab === id ? 'on' : ''}" data-tab="${id}">${icon(ic)}<span>${label}</span>${n ? `<i class="${id === 'live' ? 'live' : ''}">${n}</i>` : ''}</button>`;
  }).join('');
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

function setTab(tab) {
  const same = S.tab === tab;
  S.tab = tab;
  render();
  $('view').scrollTop = 0;
  if (same) return;
  if (tab === 'vods' || tab === 'continue') ensureVods();
  if (tab === 'schedule') ensureSchedule();
}

function render() {
  if (!authStatus().signedIn) return;
  renderTabs();
  const view = $('view');
  const top = view.scrollTop;
  const t = TABS.find((x) => x[0] === S.tab);
  $('t-title').textContent = t[1];
  const busy = S.tab === 'live' || S.tab === 'channels' ? S.checking : S.tab === 'schedule' ? S.schedLoading : S.vodsLoading;
  const err = S.tab === 'live' || S.tab === 'channels' ? S.error : S.tab === 'schedule' ? S.schedError : S.vodsError;
  $('b-refresh').classList.toggle('spin', busy);
  $('t-note').textContent = err || '';
  $('t-note').classList.toggle('bad', !!err);
  const pill = $('t-pill');
  pill.className = 'pill';
  pill.textContent = '';
  ({ live: renderLive, continue: renderContinue, vods: renderVods, schedule: renderSchedule, channels: renderChannels })[S.tab](view);
  view.scrollTop = top;
}

$('b-refresh').innerHTML = icon('refresh');
$('b-refresh').addEventListener('click', () => {
  if (S.tab === 'live' || S.tab === 'channels') check({ fresh: true });
  else if (S.tab === 'schedule') ensureSchedule(true);
  else ensureVods(true);
});

// ---------- Live ----------
function thumbBox(inner) { return `<div class="tw-thumb">${inner}</div>`; }

function liveRowHtml(c) {
  const since = Date.parse(c.startedAt) || Date.now();
  return `<div class="tw" data-live="${esc(c.login)}" role="button">
    ${thumbBox(`${c.thumb ? `<img src="${esc(c.thumb)}" alt="" loading="lazy">` : ''}<span class="tw-badge">LIVE</span><span class="tw-viewers">${fmtNum(c.viewers)}</span><span class="tw-up" data-since="${since}">${fmtSpan(Date.now() - since)}</span>`)}
    <div class="tw-info">
      <div class="tw-head">${avHtml(c)}<span class="tw-name">${esc(c.display)}</span>${isHeart(c.login) ? `<span class="fav-mark heart">${icon('heart')}</span>` : ''}${isFav(c.login) ? `<span class="fav-mark">${icon('bell')}</span>` : ''}</div>
      <div class="tw-title">${esc(c.title || '(no title)')}</div>
      <div class="tw-game">${esc(c.game || '')}</div>
    </div>
  </div>`;
}

function renderLive(view) {
  const fav = (a, b) => (isFav(b.login) ? 1 : 0) - (isFav(a.login) ? 1 : 0);
  const last = lastLive();
  const live = liveChannels().sort((a, b) => fav(a, b) || (b.viewers || 0) - (a.viewers || 0));
  const off = S.channels.filter((c) => !c.live).sort((a, b) => fav(a, b) || (last[b.login] || 0) - (last[a.login] || 0) || a.display.localeCompare(b.display));
  const pill = $('t-pill');
  if (S.channels.length) { pill.textContent = String(live.length); pill.classList.add('live'); }
  if (!S.channels.length) {
    view.innerHTML = `<div class="empty">${S.checking ? 'Checking who is live...' : S.error ? esc(S.error) : 'You do not follow anyone on Twitch yet.'}</div>`;
    return;
  }
  const offHtml = prefs.settings.showOffline && off.length
    ? `<div class="day">Offline (${off.length})</div>${off.map((c) => `<div class="off" data-chan="${esc(c.login)}">${avHtml(c)}<span class="off-name">${esc(c.display)}</span><span class="off-when">${last[c.login] ? `live ${esc(ago(last[c.login]))}` : ''}</span></div>`).join('')}`
    : '';
  view.innerHTML = `${live.map(liveRowHtml).join('') || '<div class="empty">Nobody you follow is live right now.</div>'}${offHtml}`;
}

async function check({ fresh = false } = {}) {
  if (S.checking || !authStatus().signedIn) return;
  S.checking = true;
  if (!S.watching) render();
  try {
    S.channels = await checkLive({ fresh });
    S.error = null;
    S.checkedAt = Date.now();
    noteWentLive();
    tryOpen();
    refreshGuest();
  } catch (e) {
    if (e.code !== 'SIGNED_OUT') S.error = e.message;
  }
  S.checking = false;
  render();
  renderWatch();
}

// ---------- Continue ----------
const sameBroadcast = (c, x) => c.login === x.login && c.live && (!x.startedAt || Math.abs(Date.parse(c.startedAt) - x.startedAt) < 15 * 60e3);
const progHtml = (pct) => (pct ? `<span class="vod-prog"><span style="width:${Math.min(100, pct).toFixed(1)}%"></span></span>` : '');

function contRowHtml(x, i) {
  const live = x.kind === 'live' && S.channels.find((c) => sameBroadcast(c, x));
  let thumb, state;
  if (x.kind === 'vod') {
    thumb = `${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : ''}<span class="vod-dur">${fmtDur(x.dur)}</span>${progHtml((x.pos / (x.dur || x.pos)) * 100)}`;
    state = `${fmtDur(x.pos)} of ${fmtDur(x.dur)}`;
  } else {
    const at = x.startedAt ? (x.at - x.startedAt) / 1000 : 0;
    const url = live ? live.thumb : x.thumb;
    thumb = `${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}${live ? '<span class="tw-badge">LIVE</span>' : '<span class="vod-dur">ended</span>'}`;
    state = `left${at ? ` at ${fmtDur(at)}` : ''}, ${live ? 'still live' : 'stream ended'}`;
  }
  return `<div class="tw vod" data-ci="${i}" role="button">
    ${thumbBox(thumb)}
    <div class="tw-info">
      <div class="tw-head">${avHtml(x)}<span class="tw-name">${esc(x.display || x.login)}</span><button class="rb" data-cmore="${i}" aria-label="More">${icon('more')}</button></div>
      <div class="tw-title">${esc(x.title || '(no title)')}</div>
      <div class="tw-game">${esc(state)} · ${esc(ago(x.at))}</div>
    </div>
  </div>`;
}

function renderContinue(view) {
  const list = continueList();
  S.cont = list;
  view.innerHTML = list.length ? list.map(contRowHtml).join('')
    : '<div class="empty"><strong>Nothing to continue yet.</strong><br>Past broadcasts you stop partway through, and live streams you watch for a minute or more and then leave, show up here.</div>';
}

function contGo(x) {
  if (x.kind === 'vod') { playVod({ id: x.id, dur: x.dur, login: x.login, display: x.display, avatar: x.avatar, title: x.title, thumb: x.thumb, url: x.url, createdAt: x.createdAt }); return; }
  const c = S.channels.find((ch) => sameBroadcast(ch, x));
  if (c) watchLive(c); else catchUp(x);
}

// The recording of a live stream you left, from a little before where you left it.
async function catchUp(x) {
  const c = chan(x.login);
  if (!c) { snack(`${x.display || x.login} is no longer in your channels`, true); return; }
  snack(`Finding ${x.display || x.login}'s recording...`);
  let v;
  try { v = await broadcastFor(c, x.startedAt); } catch (e) { snack(e.message, true); return; }
  if (!v) { snack('That stream has no recording (the channel does not keep them, or hides them)', true); return; }
  const from = x.startedAt ? Math.max(0, (x.leftAt - x.startedAt) / 1000 - 20) : 0;
  forget({ kind: 'live', login: x.login });
  playVod(v, { from: Math.max(from, resumeAt(v.id, false)) });
}

function contMenu(x) {
  const live = x.kind === 'live' && S.channels.find((c) => sameBroadcast(c, x));
  const items = [];
  if (x.kind === 'vod') {
    items.push({ label: `Resume at ${fmtDur(x.pos)}`, fn: () => contGo(x) });
    items.push({ label: 'Play from the beginning', fn: () => playVod({ ...x, id: x.id }, { restart: true }) });
    items.push({ label: 'Mark as watched', fn: () => { setWatched(x.id, true); render(); } });
  } else {
    if (live) items.push({ label: 'Rejoin live', fn: () => watchLive(live) });
    items.push({ label: live ? 'Catch up from where you left' : 'Resume the recording', fn: () => catchUp(x) });
  }
  items.push({ label: 'Remove from Continue', danger: true, fn: () => { forget({ kind: x.kind, id: x.id, login: x.login }); render(); } });
  sheet(x.display || x.login, items, x.title);
}

// ---------- VODs ----------
async function ensureVods(refresh = false) {
  if (S.vodsLoading || !authStatus().signedIn || !S.channels.length) return;
  if (!refresh && vodsAt() && Date.now() - vodsAt() < 10 * 60e3) return;
  S.vodsLoading = true;
  S.vodsError = null;
  render();
  try { await loadVods(S.channels, { refresh }); } catch (e) { if (e.code !== 'SIGNED_OUT') { S.vodsError = e.message; snack(e.message, true); } }
  S.vodsLoading = false;
  render();
}

function vodRowHtml(v, live) {
  const p = hist.vods[v.id];
  const done = !!(p && p.done);
  const pct = done ? 100 : p && p.pos ? (p.pos / (p.dur || v.dur)) * 100 : 0;
  const state = done ? 'watched' : pct ? `${fmtDur(p.pos)} in` : '';
  const img = v.thumb || (live && live.thumb);
  return `<div class="tw vod ${done ? 'done' : ''}" data-vod="${esc(v.id)}" role="button">
    ${thumbBox(`${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}${live ? '<span class="tw-badge">LIVE</span>' : ''}<span class="vod-dur">${fmtDur(v.dur)}${live ? '+' : ''}</span>${progHtml(pct)}`)}
    <div class="tw-info">
      <div class="tw-head">${avHtml(v)}<span class="tw-name">${esc(v.display)}</span><button class="rb" data-vmore="${esc(v.id)}" aria-label="More">${icon('more')}</button></div>
      <div class="tw-title">${esc(v.title || '(no title)')}</div>
      <div class="tw-game">${esc([clock(v.createdAt), state, v.sub ? 'subscribers only' : '', v.views ? `${fmtNum(v.views)} views` : ''].filter(Boolean).join(' · '))}</div>
    </div>
  </div>`;
}

function filteredVods() {
  const f = S.vodFilter;
  return vodList().filter((v) => (!f.channel || (f.channel === '*fav' ? isFav(v.login) : v.login === f.channel)) && (!f.unwatched || !(hist.vods[v.id] && hist.vods[v.id].done)));
}

// A channel's newest VOD while it is live is the stream still recording: no thumbnail yet, still growing.
function vodRowsHtml(list) {
  const live = new Map(liveChannels().map((c) => [c.login, c]));
  const seen = new Set();
  let html = '', last = '';
  for (const v of list) {
    const d = dayLabel(v.createdAt);
    if (d !== last) { html += `<div class="day">${esc(d)}</div>`; last = d; }
    const c = !seen.has(v.login) && live.get(v.login);
    seen.add(v.login);
    html += vodRowHtml(v, c && v.createdAt >= (Date.parse(c.startedAt) || 0) - 15 * 60e3 ? c : null);
  }
  return html;
}

function renderVods(view) {
  const f = S.vodFilter;
  const chans = S.channels.slice().sort((a, b) => a.display.localeCompare(b.display));
  const opts = [['', 'All channels'], ['*fav', 'Favourites'], ...chans.map((c) => [c.login, c.display])]
    .map(([v, l]) => `<option value="${esc(v)}" ${f.channel === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const controls = `<div class="vod-top"><select id="vod-chan" aria-label="Show past broadcasts from">${opts}</select>
    <label class="check"><input type="checkbox" id="vod-unw" ${f.unwatched ? 'checked' : ''}> Unwatched</label></div>`;
  let body;
  if (!vodsAt()) body = `<div class="empty">${S.vodsLoading ? `<strong>Loading past broadcasts...</strong><br>Checking ${S.channels.length} channels.` : S.vodsError ? `<strong>Could not load past broadcasts.</strong><br>${esc(S.vodsError)}` : 'Past broadcasts from the channels you follow show up here.'}</div>`;
  else {
    const list = filteredVods();
    if (!list.length) {
      const msg = f.unwatched ? 'You have watched everything here.' : f.channel === '*fav' ? (prefs.favourites.length ? 'Your favourites have no past broadcasts.' : 'You have no favourites yet. Ring the bell on a channel in Channels to make it one.') : f.channel ? 'This channel has no past broadcasts.' : 'No past broadcasts found.';
      body = `<div class="empty"><strong>${esc(msg)}</strong><br>Some channels turn off saving their broadcasts, and Twitch deletes them after a while.</div>`;
    } else {
      const shown = list.slice(0, S.vodShow);
      body = vodRowsHtml(shown) + (list.length > shown.length ? `<button class="btn ghost wide" id="vod-more">Show more (${list.length - shown.length})</button>` : '');
    }
  }
  view.innerHTML = controls + body;
  $('vod-chan').addEventListener('change', (e) => { f.channel = e.target.value; S.vodShow = 40; render(); $('view').scrollTop = 0; });
  $('vod-unw').addEventListener('change', (e) => { f.unwatched = e.target.checked; S.vodShow = 40; render(); });
  const more = $('vod-more');
  if (more) more.addEventListener('click', () => { S.vodShow += 40; render(); });
}

function vodMenu(v) {
  const p = hist.vods[v.id];
  const done = !!(p && p.done);
  const items = [];
  if (p && p.pos && !done) items.push({ label: `Resume at ${fmtDur(p.pos)}`, fn: () => playVod(v) });
  items.push({ label: 'Play from the beginning', fn: () => playVod(v, { restart: true }) });
  items.push({ label: done ? 'Mark as not watched' : 'Mark as watched', fn: () => { setWatched(v.id, !done); render(); renderWatch(); } });
  if (v.url) items.push({ label: 'Open on twitch.tv', fn: () => N && N.openExternal(v.url) });
  sheet(v.display, items, v.title);
}

// ---------- Schedule ----------
async function ensureSchedule(force = false) {
  if (S.schedLoading || !authStatus().signedIn || !S.channels.length) return;
  if (!force && sched.at && Date.now() - sched.at < 3 * 3600e3) return;
  S.schedLoading = true;
  S.schedError = null;
  render();
  try { await loadSchedule(S.channels, { force }); } catch (e) { if (e.code !== 'SIGNED_OUT') { S.schedError = e.message; snack(e.message, true); } }
  S.schedLoading = false;
  render();
}

function renderSchedule(view) {
  const top = `<div class="note">${sched.at ? `Next 7 days, from each channel's Twitch schedule. Checked ${esc(ago(sched.at))}.` : "Each channel's Twitch schedule for the next 7 days."}</div>`;
  if (!sched.at) { view.innerHTML = `${top}<div class="empty">${S.schedLoading ? '<strong>Loading schedules...</strong>' : S.schedError ? `<strong>Could not load schedules.</strong><br>${esc(S.schedError)}` : ''}</div>`; return; }
  const live = new Map(liveChannels().map((c) => [c.login, c]));
  const items = sched.items.filter((it) => (it.end || it.start + 3600e3) > Date.now());
  let html = '', last = '';
  for (const it of items) {
    const day = dayLabel(it.start);
    if (day !== last) { html += `<div class="day">${esc(day)}</div>`; last = day; }
    const now = live.get(it.login) && it.start <= Date.now() + 30 * 60e3;
    html += `<div class="sched ${isFav(it.login) ? 'fav' : ''}" ${now ? `data-live="${esc(it.login)}" role="button"` : ''}>
      <div class="sched-time"><strong>${esc(clock(it.start))}</strong>${it.end ? `<span>${esc(fmtSpan(it.end - it.start))}</span>` : ''}</div>
      ${avHtml(it)}
      <div class="sched-main"><div class="tw-head"><span class="tw-name">${esc(it.display)}</span>${now ? '<span class="pill live">live now</span>' : ''}</div>
        <div class="sched-title">${esc(it.title || 'Scheduled stream')}</div>${it.game ? `<div class="tw-game">${esc(it.game)}</div>` : ''}</div>
    </div>`;
  }
  view.innerHTML = top + (html || '<div class="empty"><strong>Nothing scheduled in the next 7 days.</strong><br>Only channels that fill in their schedule on Twitch show up here.</div>');
}

// ---------- Channels ----------
function statsHtml() {
  const w = weekStats();
  if (!w.total) return '<div class="panel stats"><div class="stats-head"><strong>Watch time</strong><span class="muted">Nothing watched in the last 7 days yet.</span></div></div>';
  const max = Math.max(...w.days.map((d) => d.sum), 1);
  const names = new Map(S.channels.map((c) => [c.login, c.display]));
  const top = Object.entries(w.per).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `<div class="panel stats">
    <div class="stats-head"><strong>Watch time</strong><span class="muted">last 7 days: <strong class="stats-total">${hm(w.total)}</strong></span></div>
    <div class="stats-body">
      <div class="bars">${w.days.map((d) => `<div class="bar-col"><i style="height:${Math.max(3, (d.sum / max) * 100)}%"></i><span>${esc(d.label)}</span></div>`).join('')}</div>
      <ol class="stats-top">${top.map(([l, s]) => `<li><span>${esc(names.get(l) || l)}</span><span class="muted">${hm(s)}</span></li>`).join('')}</ol>
    </div></div>`;
}

function chanRowsHtml() {
  const q = S.chanFilter.trim().toLowerCase();
  const last = lastLive();
  const rows = S.channels
    .filter((c) => !q || c.login.includes(q) || String(c.display).toLowerCase().includes(q))
    .sort((a, b) => (isFav(b.login) ? 1 : 0) - (isFav(a.login) ? 1 : 0) || String(a.display).localeCompare(String(b.display)));
  return rows.map((c) => `
    <div class="chan ${c.live ? 'is-live' : ''}" ${c.live ? `data-live="${esc(c.login)}" role="button"` : ''}>
      ${avHtml(c)}
      <div class="chan-main"><span class="tw-name">${esc(c.display)}</span><span class="chan-sub">${c.live ? `<span class="live-dot"></span>live${c.game ? ` - ${esc(c.game)}` : ''}` : last[c.login] ? `last live ${esc(ago(last[c.login]))}` : ''}</span></div>
      <button class="rb heart ${isHeart(c.login) ? 'on' : ''}" data-heart="${esc(c.login)}" aria-label="Heart" aria-pressed="${isHeart(c.login)}">${icon('heart')}</button>
      <button class="rb ${isFav(c.login) ? 'on' : ''}" data-fav="${esc(c.login)}" aria-label="Favourite" aria-pressed="${isFav(c.login)}">${icon('bell')}</button>
      <button class="rb" data-vods="${esc(c.login)}" aria-label="Past broadcasts">${icon('film')}</button>
      ${isExtra(c.login) ? `<button class="rb" data-rmx="${esc(c.login)}" aria-label="Remove">${icon('x')}</button>` : ''}
    </div>`).join('') || '<div class="empty">No channels match that filter.</div>';
}

function renderChannels(view) {
  if (!S.channels.length) { view.innerHTML = `<div class="empty">${S.checking ? 'Checking...' : 'You do not follow anyone on Twitch yet.'}</div>`; return; }
  view.innerHTML = `${statsHtml()}
    <div class="note">The channels you follow on Twitch, and any you added from search (the magnifying glass). Heart: offer to switch when they go live while you are watching something else. Bell: a favourite, listed first and announced when live if alerts are on. Film: its past broadcasts.</div>
    <div class="vod-top"><input type="search" id="chan-filter" aria-label="Filter channels" placeholder="Filter ${S.channels.length} channels" value="${esc(S.chanFilter)}" /></div>
    <div id="chan-list">${chanRowsHtml()}</div>`;
  // Typing redraws only the rows, so the keyboard stays up.
  $('chan-filter').addEventListener('input', (e) => { S.chanFilter = e.target.value; $('chan-list').innerHTML = chanRowsHtml(); });
}

// ---------- taps in the tab view ----------
$('view').addEventListener('click', (e) => {
  const t = e.target;
  const b = t.closest('button');
  if (b) {
    if (b.dataset.cmore) { contMenu(S.cont[+b.dataset.cmore]); return; }
    if (b.dataset.vmore) { const v = vodList().find((x) => x.id === b.dataset.vmore); if (v) vodMenu(v); return; }
    if (b.dataset.fav) {
      const login = b.dataset.fav, on = !isFav(login);
      setFav(login, on);
      snack(on ? `${(chan(login) || {}).display || login} is a favourite: listed first` : `${(chan(login) || {}).display || login} is no longer a favourite`);
      const top = $('view').scrollTop;
      $('chan-list').innerHTML = chanRowsHtml();
      $('view').scrollTop = top;
      return;
    }
    if (b.dataset.heart) {
      const login = b.dataset.heart, on = !isHeart(login);
      setHeart(login, on);
      const name = (chan(login) || {}).display || login;
      snack(on ? `${name} has a heart: you get the offer to switch when they go live` : `${name} no longer has a heart`);
      const top = $('view').scrollTop;
      $('chan-list').innerHTML = chanRowsHtml();
      $('view').scrollTop = top;
      return;
    }
    if (b.dataset.vods) { S.vodFilter.channel = b.dataset.vods; S.vodShow = 40; setTab('vods'); return; }
    if (b.dataset.rmx) {
      const c = chan(b.dataset.rmx) || { login: b.dataset.rmx, display: b.dataset.rmx };
      sheet(`Remove ${c.display}?`, [{ label: 'Remove from my channels', danger: true, fn: () => removeExtra(c.login) }], 'You added this channel from search. It is not followed on Twitch.');
      return;
    }
    return;
  }
  const row = t.closest('[data-live], [data-vod], [data-ci], [data-chan]');
  if (!row) return;
  if (row.dataset.live) { const c = chan(row.dataset.live); if (c && c.live) watchLive(c); }
  else if (row.dataset.vod) { const v = vodList().find((x) => x.id === row.dataset.vod); if (v) playVod(v); }
  else if (row.dataset.ci) contGo(S.cont[+row.dataset.ci]);
  else if (row.dataset.chan) { S.vodFilter.channel = row.dataset.chan; S.vodShow = 40; setTab('vods'); }
});

// ---------- watching ----------
const liveUrl = (login) => `https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=twitch.tv&autoplay=true&muted=false`;
function vodUrl(id, from) {
  from = Math.max(0, Math.floor(from || 0));
  const time = from ? `&time=${Math.floor(from / 3600)}h${Math.floor((from % 3600) / 60)}m${from % 60}s` : '';
  return `https://player.twitch.tv/?video=v${encodeURIComponent(id)}&parent=twitch.tv&autoplay=true&muted=false${time}`;
}

// The same thumbnail at a size that suits the player: it is what shows while the stream loads.
const bigThumb = (url) => (url ? String(url).replace(/-\d+x\d+(\.\w+)(\?.*)?$/, '-1280x720$1$2') : '');

// Leaving whatever is on: a live stream watched for a minute or more goes to Continue.
function leaveCurrent() {
  const w = S.watching;
  if (!w) return;
  if (w.kind === 'live' && w.secs >= 60) { const c = chan(w.login) || w.guest; if (c && c.live) noteLive(c, Date.now()); }
}

function watchLive(c) {
  // Going from one live stream to another, the one being left stays loaded for a minute in case you come back.
  const keep = !!(S.watching && S.watching.kind === 'live');
  leaveCurrent();
  S.watching = { kind: 'live', login: c.login, display: c.display, avatar: c.avatar, cid: c.id, secs: 0, guest: chan(c.login) ? null : c };
  if (N) { N.nowPlaying(c.display); N.play(`live:${c.login}`, liveUrl(c.login), keep, bigThumb(c.thumb)); }
  show();
  renderWatch();
  chat.open({ login: c.login, display: c.display, id: c.id });
  if (heartTestArmed) { heartTestArmed = false; setTimeout(heartTest, 5000); }
}

// A past broadcast, from where you left it (or opts.from seconds, or the beginning with opts.restart).
function playVod(v, opts = {}) {
  leaveCurrent();
  const from = opts.from != null ? opts.from : resumeAt(v.id, !!opts.restart);
  if (opts.restart && hist.vods[v.id]) { hist.vods[v.id].pos = 0; hist.vods[v.id].done = false; }
  touchVod(v);
  S.watching = { kind: 'vod', id: v.id, dur: v.dur, createdAt: v.createdAt || null, url: v.url, title: v.title, thumb: v.thumb, login: v.login, display: v.display, avatar: v.avatar, secs: 0 };
  chat.close();
  if (N) { N.nowPlaying([v.display, v.title].filter(Boolean).join(': ')); N.play(`vod:${v.id}`, vodUrl(v.id, from), false, bigThumb(v.thumb)); }
  show();
  renderWatch();
  $('vodpane').scrollTop = 0;
  if (from > 0) snack(`Resuming at ${fmtDur(from)}`);
}

// A live stream from its beginning: the VOD Twitch is recording of it, from 0:00.
async function fromStart(c) {
  snack(`Finding the start of ${c.display}'s stream...`);
  let v;
  try { v = await broadcastFor(c, Date.parse(c.startedAt) || 0); } catch (e) { snack(e.message, true); return; }
  if (!v) { snack('This stream is not being recorded (the channel does not keep past broadcasts, or hides them)', true); return; }
  playVod(v, { restart: true });
}

function closeWatch() {
  if (!S.watching) return;
  leaveCurrent();
  if (S.sleep) setSleep(null);
  S.watching = null;
  if (N) N.stop();
  chat.close();
  if (document.activeElement) document.activeElement.blur();
  show();
  render();
}
$('b-back').innerHTML = icon('back');
$('b-back').addEventListener('click', closeWatch);

// The details under the video. Live: they follow the latest check (title, category, viewers, or that the stream
// has ended). A past broadcast: where you are in it, and more from the channel.
function renderWatch() {
  const w = S.watching;
  if (!w) return;
  const c = chan(w.login) || w.guest || null;
  $('watch').classList.toggle('is-vod', w.kind === 'vod');
  setAv($('w-av'), (c && c.avatar) || w.avatar);
  $('w-name').textContent = (c && c.display) || w.display;
  const sub = $('w-sub'), up = $('w-up'), acts = [];
  if (w.kind === 'live') {
    const live = !!(c && c.live);
    sub.classList.toggle('bad', !live);
    sub.textContent = live ? [c.game, `${fmtNum(c.viewers)} watching`].filter(Boolean).join(' \u00b7 ') : 'Offline: the stream has ended';
    $('w-title').textContent = live ? c.title || '' : '';
    if (live && c.startedAt) { up.dataset.since = String(Date.parse(c.startedAt) || Date.now()); up.textContent = fmtSpan(Date.now() - Number(up.dataset.since)); }
    else { delete up.dataset.since; up.textContent = ''; }
    if (live) acts.push(['start', 'rewind', 'From the start']);
  } else {
    const p = hist.vods[w.id] || {};
    delete up.dataset.since;
    up.textContent = '';
    sub.classList.remove('bad');
    sub.textContent = [w.createdAt ? `${dayLabel(w.createdAt)} ${clock(w.createdAt)}` : 'Past broadcast', fmtDur(w.dur)].join(' \u00b7 ');
    $('w-title').textContent = w.title || '';
    acts.push(['restart', 'rewind', 'Restart']);
    acts.push(['mark', 'check', p.done ? 'Mark unwatched' : 'Mark watched']);
    if (c && c.live) acts.push(['golive', 'live', 'Go live']);
    if (w.url) acts.push(['ext', 'external', 'twitch.tv']);
    renderVodPane();
  }
  acts.push(['sleep', 'moon', sleepLabel()]);
  $('w-acts').innerHTML = acts.map(([id, ic, label]) => `<button class="chip ${id === 'sleep' && S.sleep ? 'on' : ''}" data-act="${id}">${icon(ic)}${esc(label)}</button>`).join('');
}

function renderVodPane() {
  const w = S.watching;
  if (!w || w.kind !== 'vod') return;
  const p = hist.vods[w.id] || {};
  const dur = Math.max(w.dur || 0, p.dur || 0);
  const pct = dur ? Math.min(100, ((p.pos || 0) / dur) * 100) : 0;
  const more = vodList().filter((v) => v.login === w.login && v.id !== w.id).slice(0, 12);
  const pane = $('vodpane');
  const top = pane.scrollTop;
  pane.innerHTML = `<div class="vp-prog"><div class="vp-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
      <div class="vp-text"><span id="vp-pos">${p.done ? 'Watched' : `${fmtDur(p.pos || 0)} of ${fmtDur(dur)}`}</span><span class="muted">${p.done ? '' : `${fmtDur(Math.max(0, dur - (p.pos || 0)))} left`}</span></div></div>
    ${more.length ? `<div class="day">More from ${esc(w.display)}</div>${vodRowsHtml(more).replace(/<div class="day">[^<]*<\/div>/g, '')}` : ''}`;
  pane.scrollTop = top;
}

$('w-acts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  const w = S.watching;
  if (!b || !w) return;
  const c = chan(w.login) || w.guest || null;
  const act = b.dataset.act;
  if (act === 'start' && c) fromStart(c);
  else if (act === 'restart') playVod(w, { restart: true });
  else if (act === 'mark') { setWatched(w.id, !(hist.vods[w.id] && hist.vods[w.id].done)); if (!hist.vods[w.id]) touchVod(w); renderWatch(); }
  else if (act === 'golive' && c && c.live) watchLive(c);
  else if (act === 'ext' && N) N.openExternal(w.url);
  else if (act === 'sleep') sleepMenu();
});
$('vodpane').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && b.dataset.vmore) { const v = vodList().find((x) => x.id === b.dataset.vmore); if (v) vodMenu(v); return; }
  const row = e.target.closest('[data-vod]');
  const v = row && vodList().find((x) => x.id === row.dataset.vod);
  if (v) playVod(v);
});

// Every few seconds while something is on, the app reads the video's position: it is how VOD progress, Continue
// and watch time are kept.
window.__native.sampled = (raw) => {
  const w = S.watching;
  let r = null;
  try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { r = null; }
  if (!w || !r) return;
  const playing = !r.paused && r.ready >= 3;
  if (playing) { w.secs += SAMPLE_EVERY; addWatchTime(w.login, SAMPLE_EVERY); }
  if (w.kind !== 'vod') return;
  // Pre-roll ads play in the same <video>; only a reading about as long as the VOD (or longer, if it is still
  // recording) is the VOD itself.
  if (!r.d || !isFinite(r.d) || r.d < w.dur - Math.max(60, w.dur * 0.05) || r.t < 5) return;
  recordVod(w.id, r.t, r.d);
  renderVodPane();
  if (S.sleep && S.sleep.end && r.d - r.t < 20) { S.sleep = null; if (N) N.sleepIn(1); }
};
// Not tied to this page being visible: in landscape and in picture-in-picture it is hidden while the video plays.
setInterval(() => { if (S.watching && N) N.sample(); }, SAMPLE_EVERY * 1000);

// ---------- Hearts ----------
// A channel with a heart going live shows a card over the video ("Switch now") while you are watching something
// else. The card is held back until the stream proper has probably started (settings.heartWaitMinutes after it
// went live), since most streams open on a "starting soon" screen. Ported from the desktop app's hearts.js; the
// card itself is drawn by the app so that it also shows in landscape.
const HEART_HOLD_MAX = 30 * 60e3; // a card that is due while the video is out of sight waits this long for it to come back
const heartsPending = new Map();  // login -> { since, heldAt }
const heartQueue = [];            // channels whose card is due, shown one at a time
let heartShowing = false;
const liveMem = new Map();        // login -> polls missed (0 = live at the last check), to tell "just went live"
let firstCheck = true;

// After each check: which channels have just gone live. The first check after the app starts announces nobody, and
// a channel missing from a single check (Twitch does that now and then) is not treated as having gone offline.
function noteWentLive() {
  const live = new Set(liveChannels().map((c) => c.login));
  const went = [];
  for (const login of live) { if (!liveMem.has(login) && !firstCheck) went.push(login); liveMem.set(login, 0); }
  for (const [login, missed] of liveMem) { if (live.has(login)) continue; if (missed === 0) liveMem.set(login, 1); else liveMem.delete(login); }
  firstCheck = false;
  announce(went);
  if (!prefs.settings.heartPopups) return;
  const now = Date.now();
  for (const login of went) {
    if (!isHeart(login)) continue;
    const c = chan(login);
    // The wait counts from when the stream started, which can be well before now if the app was in the background.
    heartsPending.set(login, { since: Math.min(now, Date.parse(c.startedAt) || now), heldAt: 0 });
  }
  heartsTick();
}

function heartsTick() {
  if (!prefs.settings.heartPopups) { heartsPending.clear(); return; }
  const wait = Math.max(0, Number(prefs.settings.heartWaitMinutes) || 0) * 60e3;
  const now = Date.now();
  for (const [login, p] of heartsPending) {
    const c = chan(login);
    if (!c || !c.live || !isHeart(login)) { heartsPending.delete(login); continue; } // went offline again, or the heart was removed
    if (now - p.since < wait) continue;
    const w = S.watching;
    if (!w || (w.kind === 'live' && w.login === login)) { heartsPending.delete(login); continue; } // nothing being watched, or already there
    if (!N || !N.playerInSight()) { // in the background or in the small window: hold it until the video is back
      if (!p.heldAt) p.heldAt = now;
      else if (now - p.heldAt > HEART_HOLD_MAX) heartsPending.delete(login);
      continue;
    }
    heartsPending.delete(login);
    offerHeart(c);
  }
}
setInterval(heartsTick, 15e3);

function offerHeart(c) {
  if (!heartQueue.some((x) => x.login === c.login)) heartQueue.push(c);
  heartNext();
}
function heartNext() {
  if (heartShowing || !N) return;
  let c = heartQueue.shift();
  while (c && S.watching && S.watching.kind === 'live' && S.watching.login === c.login) c = heartQueue.shift(); // already there
  if (!c) return;
  heartShowing = true;
  N.heart(JSON.stringify({ login: c.login, display: c.display, title: c.title || c.game || '', avatar: c.avatar || '' }));
}
window.__heartDone = () => { heartShowing = false; setTimeout(heartNext, 400); };
window.__heartSwitch = (login) => {
  heartShowing = false;
  heartQueue.length = 0;
  const c = chan(login);
  if (c && c.live) watchLive(c); else snack('That stream has ended', true);
};

// Settings > Hearts > "Show me one now": the card for a channel that is live (one with a heart if there is one).
let heartTestArmed = false;
function heartTest() {
  if (!S.watching) return;
  const live = liveChannels().filter((c) => !(S.watching.kind === 'live' && S.watching.login === c.login));
  const c = live.find((x) => isHeart(x.login)) || live[0];
  if (c) offerHeart(c);
}

// ---------- sleep timer ----------
// Stops the video after a while (the sound fades out first), or at the end of a past broadcast. The clock runs in
// the app, so it still fires in landscape and in picture-in-picture.
function sleepLabel() {
  if (!S.sleep) return 'Sleep';
  if (S.sleep.end) return 'Sleep: at the end';
  return `Sleep: ${Math.max(1, Math.round((S.sleep.at - Date.now()) / 60e3))}m`;
}
function setSleep(sl) {
  S.sleep = sl;
  if (N) N.sleepIn(sl && sl.at ? Math.max(1, sl.at - Date.now()) : 0);
  renderWatch();
}
function sleepMenu() {
  const items = [15, 30, 45, 60, 90, 120].map((m) => ({ label: m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`.replace('1.5 hours', '1 hour 30'), fn: () => { setSleep({ at: Date.now() + m * 60e3 }); snack(`Sleep timer: stops at ${clock(Date.now() + m * 60e3)}`); } }));
  if (S.watching && S.watching.kind === 'vod') items.push({ label: 'At the end of this broadcast', fn: () => { setSleep({ end: true }); snack('Sleep timer: stops when this broadcast ends'); } });
  if (S.sleep) items.push({ label: 'Turn the sleep timer off', danger: true, fn: () => { setSleep(null); snack('Sleep timer off'); } });
  sheet('Sleep timer', items, S.sleep ? (S.sleep.end ? 'On: stops at the end of this broadcast.' : `On: stops at ${clock(S.sleep.at)}.`) : 'Stops the video after a while. The sound fades out first.');
}
// The app has faded the sound out and paused: close the player so the screen can go off.
window.__slept = () => {
  S.sleep = null;
  if (S.watching) { closeWatch(); snack('Sleep timer: stopped'); }
};
setInterval(() => { if (S.sleep && S.sleep.at && S.watching) renderWatch(); }, 30e3);

// ---------- alerts ----------
// Notifications for who has just gone live (Settings > Alerts): favourites always, hearts when nothing is being
// watched (otherwise the card over the video does it). Then every live broadcast is marked as known, so the
// background check does not announce it again later.
function announce(went) {
  if (!N) return;
  if (prefs.settings.alerts) {
    for (const login of went) {
      const c = chan(login);
      if (c && (isFav(login) || (isHeart(login) && !S.watching))) {
        N.notifyLive(JSON.stringify({ login, display: c.display, title: [c.title, c.game].filter(Boolean).join(' - '), startedAt: c.startedAt || '' }));
      }
    }
  }
  N.seenLive(JSON.stringify(Object.fromEntries(liveChannels().map((c) => [c.login, c.startedAt || '']))));
}
// Android answered the request to show notifications.
window.__notifPerm = (ok) => {
  if (ok || !prefs.settings.alerts) return;
  prefs.settings.alerts = false;
  savePrefs();
  if (S.settingsOpen) renderSettings();
  snack('Notifications are blocked for this app in Android settings, so alerts stay off.', true);
};

// A tapped notification: open that stream, once this session has checked who is live.
function tryOpen() {
  if (!S.openWanted || !S.checkedAt) return;
  const c = chan(S.openWanted);
  S.openWanted = '';
  if (c && c.live) { if (!(S.watching && S.watching.kind === 'live' && S.watching.login === c.login)) watchLive(c); }
  else if (c) snack(`${c.display} is no longer live`, true);
}
window.__open = (login) => { S.openWanted = login; if (S.checking) return; check().then(tryOpen); };
// The Stop button on the "now playing" notification.
window.__stopAll = () => closeWatch();

// ---------- next and previous channel ----------
// The live channels in the Live list's order: favourites first, then by viewers.
function liveOrder() {
  const fav = (a, b) => (isFav(b.login) ? 1 : 0) - (isFav(a.login) ? 1 : 0);
  return liveChannels().sort((a, b) => fav(a, b) || (b.viewers || 0) - (a.viewers || 0));
}
const flash = (text) => { if (N) N.flash(text); else snack(text); };

// The next (dir 1) or previous (dir -1) live channel from the one playing, wrapping round at the ends.
function step(dir) {
  const w = S.watching;
  if (!w) return;
  const list = liveOrder();
  const at = w.kind === 'live' ? list.findIndex((c) => c.login === w.login) : -1;
  const next = list.length ? list[(((at < 0 && dir < 0 ? 0 : at) + dir) % list.length + list.length) % list.length] : null;
  if (!next || (w.kind === 'live' && next.login === w.login)) { flash('No other live channel'); return; }
  watchLive(next);
  flash(next.display);
  // Flicking through: the one after this, in the same direction, starts loading now so it is ready when you get there.
  const ahead = list[((list.indexOf(next) + dir) % list.length + list.length) % list.length];
  if (N && ahead && ahead.login !== next.login && ahead.login !== w.login) N.warm(`live:${ahead.login}`, liveUrl(ahead.login).replace('muted=false', 'muted=true'));
}
// A sideways swipe: over the video (the app sends it), or over what is under it (below). Not on a past broadcast,
// where sideways is for seeking.
window.__swipe = (dir) => { if (S.watching && S.watching.kind === 'live') step(dir); };
let swipeFrom = null;
$('watch').addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  swipeFrom = e.touches.length === 1 && !e.target.closest('input, .w-acts') ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
}, { passive: true });
$('watch').addEventListener('touchend', (e) => {
  if (!swipeFrom) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeFrom.x, dy = t.clientY - swipeFrom.y, quick = Date.now() - swipeFrom.at < 600;
  swipeFrom = null;
  if (quick && Math.abs(dx) > 80 && Math.abs(dx) > 2.2 * Math.abs(dy)) window.__swipe(dx < 0 ? 1 : -1);
}, { passive: true });

// ---------- Search ----------
// Any channel on Twitch, by name. A live one can be watched straight away; any of them can be added to your
// channels, which puts it in Live, VODs and the rest without following it on Twitch.
let searchSeq = 0;
let searchTimer = null;
let searchRows = [];

function openSearch() {
  S.searchOpen = true;
  show();
  renderResults();
  setTimeout(() => $('q').focus(), 60);
}
function closeSearch() {
  S.searchOpen = false;
  $('q').blur();
  show();
  render();
}
$('b-search').innerHTML = icon('search');
$('b-search').addEventListener('click', openSearch);
$('b-search-back').innerHTML = icon('back');
$('b-search-back').addEventListener('click', closeSearch);
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch($('q').value.trim()), 350);
});
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch($('q').value.trim()); $('q').blur(); } });

async function runSearch(q) {
  const seq = ++searchSeq;
  if (q.length < 2) { searchRows = []; S.searchState = ''; renderResults(); return; }
  S.searchState = 'loading';
  renderResults();
  try {
    const rows = await helix('/search/channels', [['query', q], ['first', '25']]);
    if (seq !== searchSeq) return; // a newer search has been typed since
    const exact = q.toLowerCase();
    searchRows = rows.map((r) => ({
      login: String(r.broadcaster_login).toLowerCase(), id: r.id, display: r.display_name, avatar: r.thumbnail_url,
      live: !!r.is_live, title: r.title || '', game: r.game_name || '', startedAt: r.started_at || null,
    })).sort((a, b) => (b.login === exact) - (a.login === exact) || b.live - a.live);
    S.searchState = searchRows.length ? '' : 'none';
  } catch (e) {
    if (seq !== searchSeq) return;
    searchRows = [];
    S.searchState = e.code === 'SIGNED_OUT' ? '' : e.message;
  }
  renderResults();
}

function renderResults() {
  const st = S.searchState;
  const el = $('results');
  if (st === 'loading' && !searchRows.length) { el.innerHTML = '<div class="empty">Searching...</div>'; return; }
  if (st === 'none') { el.innerHTML = '<div class="empty"><strong>No channel found by that name.</strong></div>'; return; }
  if (st && st !== 'loading') { el.innerHTML = `<div class="empty"><strong>Could not search.</strong><br>${esc(st)}</div>`; return; }
  if (!searchRows.length) { el.innerHTML = '<div class="empty">Type a channel name. A live channel can be watched straight away, and any channel can be added to yours without following it on Twitch.</div>'; return; }
  el.innerHTML = searchRows.map((r, i) => `
    <div class="chan ${r.live ? 'is-live' : ''}" data-ri="${i}" role="button">
      ${avHtml(r)}
      <div class="chan-main"><span class="tw-name">${esc(r.display)}${chan(r.login) ? '<span class="chan-tag">in your channels</span>' : ''}</span>
        <span class="chan-sub">${r.live ? `<span class="live-dot"></span>live${r.game ? ` - ${esc(r.game)}` : ''}` : 'offline'}</span></div>
      <span class="rb">${icon('more')}</span>
    </div>`).join('');
}
$('results').addEventListener('click', (e) => {
  const row = e.target.closest('[data-ri]');
  const r = row && searchRows[+row.dataset.ri];
  if (r) resultMenu(r);
});

function resultMenu(r) {
  const items = [];
  if (r.live) items.push({ label: 'Watch live', fn: () => watchFound(r) });
  if (!chan(r.login)) items.push({ label: 'Add to my channels', fn: () => addExtra(r) });
  else if (isExtra(r.login)) items.push({ label: 'Remove from my channels', danger: true, fn: () => removeExtra(r.login) });
  items.push({ label: 'Open on twitch.tv', fn: () => N && N.openExternal(`https://www.twitch.tv/${encodeURIComponent(r.login)}`) });
  sheet(r.display, items, r.live ? r.title || r.game : 'Offline');
}

// The live stream of a channel, as the Live list would describe it. null if it is not live.
async function streamOf(r) {
  const [s] = await helix('/streams', [['user_login', r.login]]);
  if (!s) return null;
  return {
    login: r.login, id: r.id || s.user_id, display: r.display || s.user_name, avatar: r.avatar || null, live: true,
    title: s.title, game: s.game_name, viewers: s.viewer_count, startedAt: s.started_at,
    thumb: s.thumbnail_url ? s.thumbnail_url.replace('{width}', '440').replace('{height}', '248') : null,
  };
}

async function watchFound(r) {
  const mine = chan(r.login);
  if (mine && mine.live) { watchLive(mine); return; }
  let c;
  try { c = await streamOf(r); } catch (e) { snack(e.message, true); return; }
  if (!c) { snack(`${r.display} is not live any more`, true); return; }
  watchLive(c);
}

// While a channel that is not in yours is being watched, each check also refreshes its details.
async function refreshGuest() {
  const w = S.watching;
  if (!w || w.kind !== 'live' || !w.guest) return;
  let c;
  try { c = await streamOf(w.guest); } catch { return; }
  if (S.watching !== w) return;
  w.guest = c || { ...w.guest, live: false };
  renderWatch();
}

function addExtra(r) {
  if (!isExtra(r.login)) { prefs.extra.push(r.login); savePrefs(); }
  snack(`Added ${r.display}: it is in Live, VODs and Channels from now on`);
  renderResults();
  check({ fresh: true }).then(renderResults);
}
function removeExtra(login) {
  prefs.extra = prefs.extra.filter((l) => l !== login);
  setFav(login, false);
  setHeart(login, false);
  snack('Removed from your channels');
  check({ fresh: true }).then(() => { if (S.searchOpen) renderResults(); });
}

// ---------- Settings ----------
function renderMe() {
  const u = authStatus().user;
  if (u) setAv($('me-av'), u.avatar);
}
$('b-me').addEventListener('click', () => { S.settingsOpen = true; renderSettings(); show(); });
$('b-settings-back').innerHTML = icon('back');
$('b-settings-back').addEventListener('click', () => { S.settingsOpen = false; show(); render(); });

function renderSettings() {
  const u = authStatus().user || {};
  const s = prefs.settings;
  $('settings-body').innerHTML = `
    <div class="panel"><h3>Twitch account</h3>
      <div class="acct">${avHtml(u)}<div><strong>${esc(u.display || '')}</strong><div class="muted small">Signed in: your follows come in, you can chat, and the player uses your account.</div></div></div>
      <button class="btn" id="set-signout">Sign out</button></div>
    <div class="panel"><h3>Live list</h3>
      <label class="setting"><input type="checkbox" data-set="showOffline" ${s.showOffline ? 'checked' : ''}> Show offline channels under the live ones</label>
      <label class="setting col">Check who is live every (seconds, at least 20)<input type="number" inputmode="numeric" min="20" max="600" id="set-poll" value="${esc(s.pollSeconds)}"></label></div>
    <div class="panel"><h3>Alerts</h3>
      <label class="setting"><input type="checkbox" data-set="alerts" ${s.alerts ? 'checked' : ''}> Tell me when a favourite or a channel with a heart goes live</label>
      <p class="muted small" style="margin:6px 0 0">A notification you can tap to open the stream, also with the app closed. Closed, it checks about every 15 minutes, and Android may stretch that while the phone is idle.</p>
      <button class="btn" id="set-alerttest" style="margin-top:10px">Send a test alert</button></div>
    <div class="panel"><h3>Hearts</h3>
      <p class="muted small">Give a channel a heart (in Channels) and, when it goes live while you are watching something else, a card slides in over the video for 10 seconds with a <strong>Switch now</strong> button.</p>
      <label class="setting"><input type="checkbox" data-set="heartPopups" ${s.heartPopups ? 'checked' : ''}> Offer to switch when a channel with a heart goes live</label>
      <label class="setting col">Minutes to wait after they go live, so the "starting soon" screen is over (0 = straight away)<input type="number" inputmode="numeric" min="0" max="30" id="set-heartwait" value="${esc(s.heartWaitMinutes)}"></label>
      <button class="btn" id="set-hearttest">Show me one now</button>
      <p class="muted small" style="margin:10px 0 0">Then open any live stream: the card for another live channel shows a few seconds in.</p></div>
    <div class="panel"><h3>Player</h3>
      <label class="setting"><input type="checkbox" data-set="pip" ${s.pip ? 'checked' : ''}> Keep playing in a small window when I leave the app</label>
      <label class="setting"><input type="checkbox" data-set="screenAudio" ${s.screenAudio ? 'checked' : ''}> Keep playing with the screen off</label>
      <label class="setting"><input type="checkbox" data-set="cleanPlayer" ${s.cleanPlayer ? 'checked' : ''}> Hide Twitch's title bar and content warning over the video</label></div>
    <div class="panel"><h3>History</h3>
      <p class="muted small">How far you got into each past broadcast, the Continue list and your watch time. Kept on this phone only.</p>
      <button class="btn" id="set-clear">Clear watch history</button></div>
    <div class="panel"><h3>About</h3>
      <p class="muted small">Lurk ${esc(N ? N.version() : '')}. Unofficial: not affiliated with or endorsed by Twitch.</p></div>`;
}
$('settings-body').addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.set) {
    prefs.settings[el.dataset.set] = el.checked;
    savePrefs();
    if (el.dataset.set === 'cleanPlayer' && N) N.setClean(el.checked);
    if (el.dataset.set === 'pip' && N) N.setPip(el.checked);
    if (el.dataset.set === 'alerts' && el.checked && N && !N.notificationsAllowed()) N.askNotifications();
    if (el.dataset.set === 'heartPopups' && !el.checked) heartsPending.clear();
  } else if (el.id === 'set-heartwait') {
    const v = Number(el.value);
    if (el.value.trim() === '' || !(v >= 0 && v <= 30)) { snack('Enter a number from 0 to 30.', true); el.value = prefs.settings.heartWaitMinutes; return; }
    prefs.settings.heartWaitMinutes = v;
    savePrefs();
    snack('Saved');
  } else if (el.id === 'set-poll') {
    const v = Number(el.value);
    if (el.value.trim() === '' || !(v >= 20 && v <= 600)) { snack('Enter a number from 20 to 600.', true); el.value = prefs.settings.pollSeconds; return; }
    prefs.settings.pollSeconds = Math.round(v);
    savePrefs();
    startPolling();
    snack('Saved');
  }
});
$('settings-body').addEventListener('click', (e) => {
  if (e.target.id === 'set-alerttest') {
    if (!N) return;
    if (!N.notificationsAllowed()) { snack('Turn alerts on first, and allow notifications when Android asks.', true); return; }
    const c = liveOrder()[0];
    if (!c) { snack('Nobody you follow is live right now to show it with.', true); return; }
    N.testNotify(JSON.stringify({ login: c.login, display: c.display, title: [c.title, c.game].filter(Boolean).join(' - ') }));
    snack('Sent: pull down the notification shade. Tapping it opens the stream.');
  } else if (e.target.id === 'set-hearttest') {
    // Settings is not on screen while a stream is: arm it, and the card shows a few seconds into the next stream opened.
    if (liveChannels().length < 2) { snack('It needs two live channels: one to watch and one to offer.', true); return; }
    heartTestArmed = true;
    snack('Now open any live stream: the card shows a few seconds in.');
  } else if (e.target.id === 'set-signout') sheet('Sign out of Twitch?', [{ label: 'Sign out', danger: true, fn: () => signOut() }], 'This removes the sign-in from this app and the player. Your favourites and watch history stay.');
  else if (e.target.id === 'set-clear') sheet('Clear watch history?', [{ label: 'Clear it', danger: true, fn: () => { clearHistory(); snack('Watch history cleared'); } }], 'Forgets your place in every past broadcast, the Continue list and your watch time.');
});

// ---------- hooks the app calls ----------
// Back button: true if this page used it.
window.__back = () => {
  if (!$('sheet').hidden) { closeSheet(); return true; }
  if (S.watching) { closeWatch(); return true; }
  if (S.searchOpen) { closeSearch(); return true; }
  if (S.settingsOpen) { S.settingsOpen = false; show(); render(); return true; }
  if (S.tab !== 'live') { setTab('live'); return true; }
  return false;
};
// The app came back to the front.
window.__resume = () => {
  S.background = false;
  reloadAuth();
  chat.resume();
  if (Date.now() - S.checkedAt > 30e3) check();
};
// The app left the front: into picture-in-picture (still watching), or out of sight.
window.__pause = (pip) => { S.background = !pip; };
window.__layout = () => {};

// ---------- clocks ----------
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtSpan(Date.now() - Number(el.dataset.since)); });
}, 30e3);
let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!S.background) check(); }, Math.max(20, Number(prefs.settings.pollSeconds) || 60) * 1000);
}

// ---------- start ----------
if (N) { N.setClean(!!prefs.settings.cleanPlayer); N.setPip(!!prefs.settings.pip); }
renderSignIn(authStatus());
show();
startPolling();
S.openWanted = N ? N.takeOpen() : '';
if (authStatus().signedIn) { renderMe(); render(); check({ fresh: true }); }
