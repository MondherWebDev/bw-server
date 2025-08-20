// server.js  — Node 18+, ensure "type":"module" in package.json
import http from 'http';
import { WebSocketServer } from 'ws';

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3000;

const DEFAULT_MAX = Number(process.env.MAX_PLAYERS || 4);
const MIN_TO_START = 2;
const DEFAULT_CATS = 8;

const rooms = new Map();

const now = () => Date.now();
const normCode = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
const clampName = s => (s || '').toString().slice(0, 32);

function makeLimiter() {
  let tokens = 10, last = now();
  return () => {
    const t = now();
    tokens = Math.min(10, tokens + (t - last) * (5 / 1000));
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function roomFor(code){
  let r = rooms.get(code);
  if (!r) {
    r = {
      clients: new Set(),
      host: null,
      maxPlayers: DEFAULT_MAX,
      round: 1, letter: null, total: 60,
      lang: 'ar',
      rules: { requireLetter: true, dupZero: true },
      answers: { host: null, guest: null },
      perRound: { host: [], guest: [] },
      running: { host: 0, guest: 0 },
      lastScoredRound: 0,
    };
    rooms.set(code, r);
  }
  return r;
}

function pickHost(room){
  if (!room.host || !room.clients.has(room.host)) {
    room.host = [...room.clients][0] || null;
    if (room.host) room.host.role = 'host';
  }
}

const roster = room => [...room.clients].map(ws => ({ role: ws.role, name: ws.name }));

function broadcast(room, obj) {
  const m = JSON.stringify(obj);
  for (const ws of room.clients) {
    try { ws.send(m); } catch {}
  }
}

// ----- Arabic normalize / validation -----
const normalizeArabic = s => String(s || '').replace(/[إأآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه');
const onlyLetters = s => String(s || '').replace(/[^A-Za-z\u0621-\u064A]/g,'');
const hasMinLetters = s => onlyLetters(s).length >= 2;

function startsWithLetter(ans, letter) {
  const a = normalizeArabic(ans).trim();
  const L = normalizeArabic(letter || '').trim();
  return a.startsWith(L);
}

function isValid(ans, letter, requireLetter) {
  if (!ans) return false;
  if (!hasMinLetters(ans)) return false;
  return requireLetter ? startsWithLetter(ans, letter) : true;
}

const normWord = s => normalizeArabic(String(s || '').trim().toLowerCase());

// ----- scoring -----
function scoreRound(room){
  // avoid double-scoring the same round
  if (room.lastScoredRound === room.round) return;

  const hostAns  = Array.isArray(room.answers.host)  ? room.answers.host  : [];
  const guestAns = Array.isArray(room.answers.guest) ? room.answers.guest : [];
  const n = Math.max(hostAns.length, guestAns.length, DEFAULT_CATS);

  let rH = 0, rG = 0;
  for (let i = 0; i < n; i++) {
    const ha = hostAns[i]  || '';
    const ga = guestAns[i] || '';
    const hv = isValid(ha, room.letter, room.rules.requireLetter);
    const gv = isValid(ga, room.letter, room.rules.requireLetter);
    const dup = hv && gv && normWord(ha) === normWord(ga);
    const sH = hv ? (dup && room.rules.dupZero ? 0 : 1) : 0;
    const sG = gv ? (dup && room.rules.dupZero ? 0 : 1) : 0;
    rH += sH; rG += sG;
  }

  room.perRound.host.push(rH);
  room.perRound.guest.push(rG);
  room.running.host += rH;
  room.running.guest += rG;
  room.lastScoredRound = room.round;

  broadcast(room, {
    t: 'scores',
    perRound: { host: rH, guest: rG },
    running: room.running,
    // backwards compatibility
    scores: { totals: { host: rH, guest: rG } },
  });

  // clear stored answers for next round
  room.answers.host = null;
  room.answers.guest = null;
}

// ----- HTTP + WS -----
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OK');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('WS server is running');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.limiter = makeLimiter();
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (buf) => {
    if (!ws.limiter()) return;
    let m; try { m = JSON.parse(buf); } catch { return; }

    // join
    if (m.t === 'join') {
      const code = normCode(m.code); if (!code) return;
      ws.code = code; ws.name = clampName(m.name || '');
      const room = roomFor(code);

      if (room.clients.size === 0 && Number(m.maxPlayers) >= 2 && Number(m.maxPlayers) <= 8) {
        room.maxPlayers = Number(m.maxPlayers);
      }
      if (room.clients.size >= room.maxPlayers) {
        try { ws.send(JSON.stringify({ t: 'room-full', max: room.maxPlayers })); } catch {}
        try { ws.close(1000); } catch {}
        return;
      }

      if (!room.host) { ws.role = 'host'; room.host = ws; } else { ws.role = 'guest'; }
      room.clients.add(ws);
      pickHost(room);

      const list = roster(room);
      broadcast(room, { t: 'roster', list });
      broadcast(room, { t: 'peer-count', n: room.clients.size, max: room.maxPlayers });
      try {
        ws.send(JSON.stringify({
          t: 'joined', code, role: ws.role, max: room.maxPlayers, list, lang: room.lang
        }));
      } catch {}
      return;
    }

    if (m.t === 'askRoster') {
      const room = rooms.get(ws.code); if (!room) return;
      try { ws.send(JSON.stringify({ t: 'roster', list: roster(room) })); } catch {}
      return;
    }

    if (m.t === 'chat') {
      const room = rooms.get(ws.code); if (!room) return;
      const text = String(m.text || '').slice(0, 240);
      broadcast(room, { t: 'chat', from: ws.role, name: ws.name, text });
      return;
    }

    if (m.t === 'lang') {
      const room = rooms.get(ws.code); if (!room || ws !== room.host) return;
      room.lang = (m.lang === 'en' ? 'en' : 'ar');
      broadcast(room, { t: 'lang', lang: room.lang });
      return;
    }

    if (m.t === 'rules') {
      const room = rooms.get(ws.code); if (!room || ws !== room.host) return;
      room.rules = { ...room.rules, ...(m.rules || {}) };
      broadcast(room, { t: 'rules', rules: room.rules });
      return;
    }

    if (m.t === 'start') {
      const room = rooms.get(ws.code); if (!room || ws !== room.host) return;
      if (room.clients.size < MIN_TO_START) {
        try { ws.send(JSON.stringify({ t: 'need-more', n: MIN_TO_START })); } catch {}
        return;
      }
      room.round  = Number(m.round) || 1;
      room.total  = Number(m.total) || 60;
      room.letter = (m.letter || '').toString().slice(0, 2); // (client already picks)
      room.answers.host = null;
      room.answers.guest = null;
      const deadline = now() + room.total * 1000;
      broadcast(room, { t: 'start', round: room.round, letter: room.letter, total: room.total, deadline });
      return;
    }

    if (m.t === 'finish') {
      const room = rooms.get(ws.code); if (!room) return;
      // ensure both are arrays so we can score even if one didn’t submit
      room.answers.host  ??= [];
      room.answers.guest ??= [];
      broadcast(room, { t: 'finish' });
      scoreRound(room);
      return;
    }

    if (m.t === 'answers') {
      const room = rooms.get(ws.code); if (!room) return;
      const ans = Array.isArray(m.answers) ? m.answers.map(x => String(x || '').slice(0, 64)) : [];
      if (ws === room.host) room.answers.host = ans; else room.answers.guest = ans;
      if (room.answers.host && room.answers.guest) scoreRound(room);
      return;
    }

    // optional: host rebroadcasts scores (not usually needed)
    if (m.t === 'scores') {
      const room = rooms.get(ws.code); if (!room || ws !== room.host) return;
      broadcast(room, m);
      return;
    }
  });

  ws.on('close', () => {
    const code = ws.code; if (!code) return;
    const room = rooms.get(code); if (!room) return;
    room.clients.delete(ws); pickHost(room);

    if (room.clients.size === 0) {
      rooms.delete(code);
    } else {
      broadcast(room, { t: 'roster', list: roster(room) });
      broadcast(room, { t: 'peer-count', n: room.clients.size, max: room.maxPlayers });
      if (ws === room.host) broadcast(room, { t: 'host-changed' });
    }
  });
});

// keep-alive pings (helps free-tier stability)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} ; continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 30000);

// ---- listen on 0.0.0.0 + PORT so Render detects the open port ----
httpServer.listen(PORT, HOST, () => {
  console.log(`WS server listening on http://${HOST}:${PORT}`);
});

// helpful logs for Render
process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));
