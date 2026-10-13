/* global store, helix, helixRaw, auth, signedOutError */
'use strict';
// What the app remembers and looks up beyond the Live list: preferences (favourites, settings), watch history (how
// far into each VOD you got, live streams you left, watch time), past broadcasts, and schedules. Ported from the
// desktop app's config.js, vods.js and schedule.js. Everything stays on the phone.

// ---------- preferences ----------
const prefs = store.get('prefs', {});
prefs.favourites = Array.isArray(prefs.favourites) ? prefs.favourites : [];
prefs.settings = {
  showOffline: true,   // offline channels listed under the live ones
  pollSeconds: 60,     // how often the Live list is checked while the app is open
  cleanPlayer: true,   // hide Twitch's title bar and content warning over the video
  pip: true,           // keep playing in a small window when leaving the app while watching
  heartPopups: true,   // a card over the video when a channel with a heart goes live
  heartWaitMinutes: 5, // how long after going live the card shows, to let a "starting soon" screen pass (0 = at once)
  alerts: false,       // notifications when a favourite or a heart goes live, also with the app closed
  screenAudio: true,   // keep playing with the screen off
  ...(prefs.settings && typeof prefs.settings === 'object' ? prefs.settings : {}),
};
// Channels added from search: checked along with the ones followed on Twitch, without following them there.
prefs.extra = Array.isArray(prefs.extra) ? prefs.extra : [];
const isExtra = (login) => prefs.extra.includes(login);
// The app itself needs a few of these with the pages closed (the background check, playing with the screen off).
function syncNative() {
  if (window.Native && window.Native.setPrefs) {
    window.Native.setPrefs(JSON.stringify({ favourites: prefs.favourites, hearts: prefs.hearts || [], extra: prefs.extra || [], alerts: !!prefs.settings.alerts, screenAudio: !!prefs.settings.screenAudio }));
  }
}
const savePrefs = () => { store.set('prefs', prefs); syncNative(); };
// Hearts: channels whose going live shows a card over whatever else you are watching ("Switch now").
prefs.hearts = Array.isArray(prefs.hearts) ? prefs.hearts : [];
const isHeart = (login) => prefs.hearts.includes(login);
function setHeart(login, on) {
  const set = new Set(prefs.hearts);
  if (on) set.add(login); else set.delete(login);
  prefs.hearts = [...set];
  savePrefs();
}
syncNative();
const isFav = (login) => prefs.favourites.includes(login);
function setFav(login, on) {
  const set = new Set(prefs.favourites);
  if (on) set.add(login); else set.delete(login);
  prefs.favourites = [...set];
  savePrefs();
}

// ---------- watch history ----------
// hist.vods: { [videoId]: { pos, dur, at, done, hidden, meta } }. hist.watching: live streams watched for a while
// and then left ({ [login]: { login, ..., startedAt, leftAt } }). hist.stats.days[YYYY-MM-DD][login]: seconds watched.
const hist = store.get('hist', {});
for (const k of ['vods', 'watching']) if (!hist[k] || typeof hist[k] !== 'object') hist[k] = {};
if (!hist.stats || typeof hist.stats.days !== 'object' || !hist.stats.days) hist.stats = { days: {} };
const saveHist = () => store.set('hist', hist);

const DONE_AT = 0.95; // counts as watched past 95%

// Drop progress for VODs Twitch has deleted (it keeps them 60 days at most).
(function prune() {
  const cutoff = Date.now() - 60 * 24 * 3600e3;
  for (const [id, v] of Object.entries(hist.vods)) if ((v.at || 0) < cutoff) delete hist.vods[id];
})();

function setWatched(id, done) {
  if (done) hist.vods[id] = { ...(hist.vods[id] || {}), done: true, at: Date.now() };
  else delete hist.vods[id];
  saveHist();
  return hist.vods[id] || null;
}

// Record a position reading from the player.
function recordVod(id, pos, dur) {
  const prev = hist.vods[id] || {};
  hist.vods[id] = { ...prev, pos: Math.round(pos), dur: Math.round(dur), at: Date.now(), done: !!prev.done || pos / dur >= DONE_AT, hidden: false };
  saveHist();
  return hist.vods[id];
}

// Where to start a VOD: a few seconds before where it was left, unless finished or restarting.
function resumeAt(id, restart) {
  const p = hist.vods[id];
  return !restart && p && p.pos && !p.done ? Math.max(0, p.pos - 5) : 0;
}

// Mark a VOD as started the moment it is opened. `meta` (title, channel, thumbnail) is kept so Continue can show
// it after it drops out of the VOD list.
function touchVod(v) {
  const info = { title: v.title, login: v.login, display: v.display, avatar: v.avatar, thumb: v.thumb, url: v.url };
  if (hist.vods[v.id]) hist.vods[v.id].meta = { ...(hist.vods[v.id].meta || {}), ...info };
  else hist.vods[v.id] = { pos: 0, dur: v.dur, at: Date.now(), done: false, meta: info };
  saveHist();
}

const KEEP_LIVE = 3 * 24 * 3600e3; // how long a left live stream stays in Continue

// A live stream you watched for a while and then left.
function noteLive(c, leftAt) {
  hist.watching[c.login] = {
    login: c.login, display: c.display, avatar: c.avatar, title: c.title, thumb: c.thumb,
    startedAt: Date.parse(c.startedAt) || null, leftAt,
  };
  saveHist();
}

function forget({ kind, id, login }) {
  if (kind === 'live') delete hist.watching[login];
  else if (hist.vods[id]) hist.vods[id].hidden = true;
  saveHist();
}

// Unfinished VODs (at least a minute in) and recently left live streams, newest first.
function continueList() {
  const byId = new Map(vodList().map((v) => [v.id, v]));
  const out = [];
  for (const [id, e] of Object.entries(hist.vods)) {
    if (e.done || e.hidden || !(e.pos >= 60)) continue;
    const v = byId.get(id) || {};
    const m = e.meta || {};
    const item = {
      kind: 'vod', id, pos: e.pos, dur: Math.max(e.dur || 0, v.dur || 0), at: e.at, createdAt: v.createdAt || null,
      title: m.title || v.title, login: m.login || v.login, display: m.display || v.display, avatar: m.avatar || v.avatar,
      thumb: m.thumb || v.thumb || null, url: m.url || v.url,
    };
    if (item.login) out.push(item);
  }
  const cutoff = Date.now() - KEEP_LIVE;
  let dropped = false;
  for (const [login, w] of Object.entries(hist.watching)) {
    if (w.leftAt < cutoff) { delete hist.watching[login]; dropped = true; continue; }
    out.push({ kind: 'live', ...w, at: w.leftAt });
  }
  if (dropped) saveHist();
  return out.sort((a, b) => b.at - a.at).slice(0, 40);
}

function clearHistory() {
  hist.vods = {};
  hist.watching = {};
  hist.stats = { days: {} };
  saveHist();
}

// ---------- watch time ----------
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function addWatchTime(login, secs) {
  const key = dayKey(new Date());
  const day = (hist.stats.days[key] = hist.stats.days[key] || {});
  day[login] = (day[login] || 0) + secs;
  const keys = Object.keys(hist.stats.days).sort();
  while (keys.length > 120) delete hist.stats.days[keys.shift()]; // four months is plenty
  saveHist();
}
function weekStats() {
  const out = { days: [], total: 0, per: {} };
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const row = hist.stats.days[dayKey(d)] || {};
    const sum = Object.values(row).reduce((a, b) => a + b, 0);
    out.days.push({ label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), sum });
    out.total += sum;
    for (const [l, s] of Object.entries(row)) out.per[l] = (out.per[l] || 0) + s;
  }
  return out;
}

// ---------- past broadcasts ----------
const VODS_FOR = 10 * 60e3;
const PER_CHANNEL = 20; // Helix max is 100; 20 covers a couple of weeks for daily streamers
const PARALLEL = 6;
let vodCache = store.get('vods', null); // { at, count, list }
if (!(vodCache && Array.isArray(vodCache.list))) vodCache = null;
const vodList = () => (vodCache ? vodCache.list : []);
const vodsAt = () => (vodCache ? vodCache.at : 0);

// Helix VOD durations look like "3h2m1s". Seconds.
function parseVodDuration(d) {
  const m = String(d || '').match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return m ? (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0) : 0;
}
// Helix gives "%{width}x%{height}"; a VOD still recording has a placeholder thumb.
const vodThumb = (url) => (url && !/_404\//.test(url) ? url.replace('%{width}', '320').replace('%{height}', '180') : null);
const vodRow = (v, c) => ({
  id: v.id, login: c.login, display: c.display, avatar: c.avatar,
  title: v.title, createdAt: Date.parse(v.created_at), dur: parseVodDuration(v.duration),
  thumb: vodThumb(v.thumbnail_url), views: v.view_count, url: v.url, sub: !!v.viewable && v.viewable !== 'public',
});

// Runs fn over items, a few at a time. Returns the errors as "login: message".
async function eachChannel(chans, fn) {
  const queue = [...chans];
  const errors = [];
  async function worker() {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try { await fn(c); } catch (e) {
        if (e.code === 'SIGNED_OUT') { queue.length = 0; throw e; }
        errors.push(`${c.login}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return errors;
}

// Past broadcasts for every followed channel, newest first. `chans` is the Live list's roster (it has the ids).
async function loadVods(chans, { refresh = false } = {}) {
  if (!auth) throw signedOutError();
  chans = chans.filter((c) => c.id);
  if (!refresh && vodCache && Date.now() - vodCache.at < VODS_FOR && vodCache.count === chans.length) return vodCache;
  const all = [];
  const errors = await eachChannel(chans, async (c) => {
    const rows = await helix('/videos', [['user_id', c.id], ['type', 'archive'], ['first', String(PER_CHANNEL)]]);
    for (const v of rows) all.push(vodRow(v, c));
  });
  // Every channel failed (offline, Twitch down): say so, and keep the list we had.
  if (chans.length && errors.length >= chans.length) throw new Error(`Could not load past broadcasts (${errors[0].replace(/^[^:]+: /, '')})`);
  all.sort((a, b) => b.createdAt - a.createdAt);
  vodCache = { at: Date.now(), count: chans.length, list: all };
  store.set('vods', vodCache);
  return vodCache;
}

// The VOD of a particular broadcast (started at startedAt, ms): the one Twitch is recording of a stream that is
// live now, or of a live stream you left. null if the channel keeps no VODs, or hides them.
async function broadcastFor(c, startedAt) {
  if (!c.id) throw new Error(`${c.display || c.login} is not in your channels`);
  const rows = await helix('/videos', [['user_id', c.id], ['type', 'archive'], ['first', '10']]);
  const v = startedAt ? rows.find((r) => Math.abs(Date.parse(r.created_at) - startedAt) < 15 * 60e3) : rows[0];
  return v ? vodRow(v, c) : null;
}

// When each channel was last live, as far as its newest past broadcast says: { [login]: endedAt }.
function lastLive() {
  const out = {};
  for (const v of vodList()) { const end = v.createdAt + v.dur * 1000; if (!(out[v.login] >= end)) out[v.login] = end; }
  return out;
}

// ---------- schedules ----------
const SCHED_FOR = 3 * 3600e3;
const AHEAD = 7 * 86400e3;
let sched = store.get('sched', null); // { at, items }
if (!(sched && Array.isArray(sched.items))) sched = { at: 0, items: [] };
let schedRunning = null;

// Each followed channel's Twitch schedule for the next 7 days, soonest first.
async function loadSchedule(chans, { force = false } = {}) {
  if (!auth) throw signedOutError();
  if (!force && Date.now() - sched.at < SCHED_FOR) return sched;
  if (schedRunning) return schedRunning;
  schedRunning = (async () => {
    chans = chans.filter((c) => c.id);
    const now = Date.now();
    const items = [];
    const errors = await eachChannel(chans, async (c) => {
      let rows;
      try { rows = await helixRaw('/schedule', [['broadcaster_id', c.id], ['first', '12']]); } catch (e) {
        if (e.code === 'SIGNED_OUT' || !/ 404/.test(e.message)) throw e; // 404: this channel has no schedule
        return;
      }
      for (const seg of (rows && rows.data && rows.data.segments) || []) {
        const start = Date.parse(seg.start_time);
        if (!Number.isFinite(start) || start < now - 3600e3 || start > now + AHEAD || seg.canceled_until) continue;
        items.push({
          id: seg.id, login: c.login, display: c.display, avatar: c.avatar, start, end: Date.parse(seg.end_time) || null,
          title: seg.title || '', game: (seg.category && seg.category.name) || '',
        });
      }
    });
    // Offline or Twitch down: keep the schedule we had rather than replace it with nothing.
    if (chans.length && errors.length >= chans.length) throw new Error(`Could not load schedules (${errors[0].replace(/^[^:]+: /, '')})`);
    items.sort((a, b) => a.start - b.start);
    sched = { at: now, items };
    store.set('sched', sched);
    return sched;
  })().finally(() => { schedRunning = null; });
  return schedRunning;
}

// Signing out: forget what was fetched for the account. Watch history and favourites stay.
function clearFetched() {
  vodCache = null;
  sched = { at: 0, items: [] };
  store.del('vods');
  store.del('sched');
}
