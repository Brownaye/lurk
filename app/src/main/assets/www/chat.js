/* global http, parseJson, chatLogin, onAuth */
'use strict';
// Live chat under the player: a Twitch IRC connection, as you when signed in (then you can type), otherwise
// anonymous and read-only. Ported from the desktop app's chat panel, without the AI recap.

const chat = (() => {
  const MAX_MSGS = 200; // messages kept on screen
  const $ = (id) => document.getElementById(id);
  const msgsEl = $('msgs');
  let ws = null;
  let wanted = false;   // a channel is open: keep the connection up
  let channel = null;   // { login, display, id }
  let joined = null;    // login currently joined
  let retry = 0;
  let retryTimer = null;
  let stick = true;     // follow new messages unless the user scrolled up
  let rate = [];        // timestamps of recent messages, for msgs/min
  let me = null;        // { login, display, token } when signed in
  let myTags = {};      // our USERSTATE in the joined channel: colour, badges, display name
  let extra = {};       // 7TV / BTTV / FFZ emotes for this channel: { name: url }
  let anonymous = false; // the token was refused this session: stop offering it

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- IRC ----------
  async function connect() {
    if (!wanted || (ws && ws.readyState <= 1)) return;
    setState('connecting');
    me = anonymous ? null : await chatLogin();
    renderCompose();
    if (!wanted || (ws && ws.readyState <= 1)) return;
    const sock = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      sock.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      if (me) { sock.send(`PASS oauth:${me.token}`); sock.send(`NICK ${me.login}`); }
      else { sock.send('PASS SCHMOOPIIE'); sock.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`); }
      joined = null;
      if (channel) join(channel.login);
    };
    sock.onmessage = (e) => { if (ws === sock) String(e.data).split('\r\n').filter(Boolean).forEach(handle); };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      joined = null;
      if (!wanted) return;
      setState('reconnecting');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    const sock = ws;
    ws = null;
    joined = null;
    if (sock) { try { sock.close(); } catch { /* already closed */ } }
  }

  function join(login) {
    if (!ws || ws.readyState !== 1) return;
    if (joined && joined !== login) ws.send(`PART #${joined}`);
    if (joined !== login) ws.send(`JOIN #${login}`);
    joined = login;
  }

  function parse(line) {
    const tags = {};
    let rest = line;
    if (rest[0] === '@') {
      const sp = rest.indexOf(' ');
      for (const kv of rest.slice(1, sp).split(';')) {
        const i = kv.indexOf('=');
        tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
      }
      rest = rest.slice(sp + 1);
    }
    let prefix = '';
    if (rest[0] === ':') { const sp = rest.indexOf(' '); prefix = rest.slice(1, sp); rest = rest.slice(sp + 1); }
    const ti = rest.indexOf(' :');
    const trailing = ti >= 0 ? rest.slice(ti + 2) : '';
    const params = (ti >= 0 ? rest.slice(0, ti) : rest).split(' ');
    return { tags, prefix, command: params[0], params: params.slice(1), trailing };
  }

  function handle(line) {
    const m = parse(line);
    if (m.command === 'PING') { ws.send(`PONG :${m.trailing}`); return; }
    if (m.command === 'NOTICE' && /authentication failed|improperly formatted auth/i.test(m.trailing)) {
      // The token was refused: carry on anonymously rather than not at all.
      addNotice('Could not sign in to chat, reading anonymously', '');
      const sock = ws;
      ws = null;
      try { sock.close(); } catch { /* already closed */ }
      anonymous = true;
      connect();
      return;
    }
    const chan = (m.params[0] || '').replace('#', '');
    if (m.command === 'ROOMSTATE' || m.command === '366') { if (chan === joined) setState('live'); return; }
    if (chan && chan !== joined) return;
    if (m.command === 'USERSTATE') { myTags = m.tags; return; }
    if (m.command === 'NOTICE') { addNotice(m.trailing, ''); return; }
    if (m.command === 'PRIVMSG') {
      let text = m.trailing;
      const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
      if (action) text = action[1];
      const login = m.prefix.split('!')[0];
      addMessage({ id: m.tags.id, name: m.tags['display-name'] || login, login, color: m.tags.color, badges: m.tags.badges || '', emotes: m.tags.emotes || '', text, action: !!action });
    } else if (m.command === 'USERNOTICE') {
      addNotice(m.tags['system-msg'] || '', m.trailing);
    } else if (m.command === 'CLEARMSG') {
      const el = msgsEl.querySelector(`[data-id="${CSS.escape(m.tags['target-msg-id'] || '')}"]`);
      if (el) el.classList.add('deleted');
    } else if (m.command === 'CLEARCHAT' && m.trailing) {
      msgsEl.querySelectorAll(`[data-login="${CSS.escape(m.trailing)}"]`).forEach((el) => el.classList.add('deleted'));
    }
  }

  // ---------- rendering ----------
  const PALETTE = ['#ff7a7a', '#7ab8ff', '#7affa1', '#ffb86b', '#d58bff', '#6be4ff', '#ff8bd0', '#c8ff6b', '#ffd86b', '#9f9bff'];
  function nameColor(color, login) {
    if (color) {
      const n = parseInt(color.slice(1), 16);
      const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      if (lum > 0.35) return color;
    }
    let h = 0;
    for (const ch of login || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function badgeHtml(badges) {
    const out = [];
    if (/broadcaster\//.test(badges)) out.push('<span class="bd bc">B</span>');
    if (/moderator\//.test(badges)) out.push('<span class="bd mod">M</span>');
    if (/vip\//.test(badges)) out.push('<span class="bd vip">V</span>');
    if (/(subscriber|founder)\//.test(badges)) out.push('<span class="bd sub">S</span>');
    return out.join('');
  }

  // 7TV / BTTV / FFZ emotes are plain words in the message; swap the ones we know for their images.
  function wordsHtml(text) {
    return text.split(/(\s+)/).map((w) => (Object.prototype.hasOwnProperty.call(extra, w) ? `<img class="emote" src="${esc(extra[w])}" alt="${esc(w)}">` : esc(w))).join('');
  }

  // Twitch emote positions count Unicode code points, not UTF-16 units.
  function textHtml(text, emotes) {
    const chars = Array.from(text);
    const spans = [];
    for (const part of emotes.split('/').filter(Boolean)) {
      const [id, ranges] = part.split(':');
      for (const r of (ranges || '').split(',')) { const [a, b] = r.split('-').map(Number); spans.push({ a, b, id }); }
    }
    spans.sort((x, y) => x.a - y.a);
    let html = '';
    let i = 0;
    for (const s of spans) {
      if (s.a < i) continue;
      html += wordsHtml(chars.slice(i, s.a).join(''));
      const name = chars.slice(s.a, s.b + 1).join('');
      html += `<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(s.id)}/default/dark/1.0" alt="${esc(name)}">`;
      i = s.b + 1;
    }
    return html + wordsHtml(chars.slice(i).join(''));
  }

  function append(el) {
    msgsEl.appendChild(el);
    while (msgsEl.children.length > MAX_MSGS) msgsEl.firstChild.remove();
    if (stick) msgsEl.scrollTop = msgsEl.scrollHeight;
    else $('below').hidden = false;
  }

  function addMessage(m) {
    rate.push(Date.now());
    const el = document.createElement('div');
    el.className = `msg${m.action ? ' action' : ''}`;
    el.dataset.id = m.id || '';
    el.dataset.login = m.login;
    const c = nameColor(m.color, m.login);
    el.innerHTML = `${badgeHtml(m.badges)}<span class="who" style="color:${esc(c)}">${esc(m.name)}</span><span class="sep">${m.action ? ' ' : ': '}</span><span class="txt"${m.action ? ` style="color:${esc(c)}"` : ''}>${textHtml(m.text, m.emotes)}</span>`;
    append(el);
  }

  function addNotice(system, text) {
    if (!system) return;
    const el = document.createElement('div');
    el.className = 'msg notice';
    el.innerHTML = `<span class="txt">${esc(system)}</span>${text ? `<div class="sub">${esc(text)}</div>` : ''}`;
    append(el);
  }

  function addDivider(text) {
    const el = document.createElement('div');
    el.className = 'divider';
    el.textContent = text;
    append(el);
  }

  function setState(s) {
    $('c-state').textContent = s === 'connecting' ? 'connecting...' : s === 'reconnecting' ? 'reconnecting...' : '';
  }

  msgsEl.addEventListener('scroll', () => {
    stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;
    if (stick) $('below').hidden = true;
  });
  $('below').addEventListener('click', () => { stick = true; msgsEl.scrollTop = msgsEl.scrollHeight; $('below').hidden = true; });
  // The keyboard opening shrinks the list: stay at the newest message.
  window.addEventListener('resize', () => { if (stick) msgsEl.scrollTop = msgsEl.scrollHeight; });

  setInterval(() => {
    const now = Date.now();
    while (rate.length && now - rate[0] > 60e3) rate.shift();
    $('c-rate').textContent = joined ? `${rate.length}/min` : '';
  }, 1000);

  // ---------- emotes (7TV, BetterTTV, FrankerFaceZ) ----------
  const TTL = 30 * 60e3;
  const cache = new Map(); // key -> { at, map }
  const getJson = async (url) => { const r = await http('GET', url); return r.status === 200 ? parseJson(r.text) : null; };
  const seventv = (set) => {
    const out = {};
    for (const e of (set && set.emotes) || []) { const host = e.data && e.data.host; if (host && host.url) out[e.name] = `https:${host.url}/1x.webp`; }
    return out;
  };
  const bttv = (list) => Object.fromEntries((Array.isArray(list) ? list : []).map((e) => [e.code, `https://cdn.betterttv.net/emote/${e.id}/1x`]));
  const ffz = (sets) => {
    const out = {};
    for (const s of Object.values(sets || {})) for (const e of s.emoticons || []) { const u = e.urls && (e.urls['1'] || e.urls[1]); if (u) out[e.name] = u.startsWith('//') ? `https:${u}` : u; }
    return out;
  };
  async function load(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.map;
    const map = await fn().catch(() => ({}));
    cache.set(key, { at: Date.now(), map });
    return map;
  }
  const globals = () => load('global', async () => {
    const [s, b, f] = await Promise.all([getJson('https://7tv.io/v3/emote-sets/global'), getJson('https://api.betterttv.net/3/cached/emotes/global'), getJson('https://api.frankerfacez.com/v1/set/global')]);
    return { ...ffz(f && f.sets), ...bttv(b), ...seventv(s) };
  });
  const forChannel = (id) => load(`ch:${id}`, async () => {
    const [s, b, f] = await Promise.all([getJson(`https://7tv.io/v3/users/twitch/${id}`), getJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`), getJson(`https://api.frankerfacez.com/v1/room/id/${id}`)]);
    return { ...ffz(f && f.sets), ...bttv(b && [...(b.channelEmotes || []), ...(b.sharedEmotes || [])]), ...seventv(s && s.emote_set) };
  });

  // ---------- typing (signed in) ----------
  function renderCompose() {
    $('compose').hidden = !me;
    $('compose-off').hidden = !!me;
  }

  function say(text) {
    if (!me || !joined || !ws || ws.readyState !== 1) return false;
    ws.send(`PRIVMSG #${joined} :${text}`);
    // Twitch does not echo your own messages back, so show it straight away.
    addMessage({ id: '', name: myTags['display-name'] || me.display, login: me.login, color: myTags.color, badges: myTags.badges || '', emotes: '', text, action: false });
    return true;
  }

  $('compose').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('say');
    const text = input.value.replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (say(text)) { input.value = ''; stick = true; msgsEl.scrollTop = msgsEl.scrollHeight; }
  });

  onAuth(() => { anonymous = false; });

  // ---------- open / close ----------
  function open(c) {
    wanted = true;
    const same = channel && channel.login === c.login;
    channel = c;
    if (!same) {
      msgsEl.innerHTML = '';
      rate = [];
      stick = true;
      myTags = {};
      extra = {};
      $('below').hidden = true;
      addDivider(`Joined ${c.display}'s chat`);
      Promise.all([globals(), c.id ? forChannel(String(c.id)) : {}]).then(([g, ch]) => { if (channel && channel.login === c.login) extra = { ...g, ...ch }; });
    }
    if (ws && ws.readyState === 1) join(c.login); else connect();
  }

  function close() {
    wanted = false;
    channel = null;
    disconnect();
    msgsEl.innerHTML = '';
    $('c-rate').textContent = '';
    setState('');
  }

  // Back from the background: Android may have dropped the socket without telling the page.
  function resume() {
    if (wanted && (!ws || ws.readyState > 1)) { retry = 0; connect(); }
  }

  return { open, close, resume };
})();
