// UNO Friends — real multiplayer UNO over WebSocket.
// Server is the single source of truth: deck, hands, turn order, color,
// UNO penalty. Clients only send actions; server validates + broadcasts.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(PUBLIC, urlPath);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_NAMES = { red: 'Laal', yellow: 'Peela', green: 'Hara', blue: 'Neela' };
const VALUE_LABEL = { skip: 'Skip', reverse: 'Reverse', draw2: '+2', wild: 'Wild', wild4: 'Wild +4' };
const ACTION_VALUES = ['skip', 'reverse', 'draw2', 'wild', 'wild4'];

function makeCode() {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}
function makeToken() { return crypto.randomBytes(16).toString('hex'); }
function makeId() { return crypto.randomBytes(8).toString('hex'); }

function cardLabel(card) {
  if (card.color === 'wild') return card.value === 'wild' ? 'Wild' : 'Wild +4';
  return COLOR_NAMES[card.color] + ' ' + (VALUE_LABEL[card.value] || card.value);
}

function buildDeck() {
  const deck = [];
  let n = 0;
  const push = (color, value) => deck.push({ id: 'c' + (n++), color, value });
  for (const c of COLORS) {
    push(c, '0');
    for (const v of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2']) {
      push(c, v);
      push(c, v);
    }
  }
  for (let i = 0; i < 4; i++) {
    push('wild', 'wild');
    push('wild', 'wild4');
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    hostId: null,
    players: [],
    status: 'lobby', // lobby | playing | finished
    drawPile: [],
    discard: [],
    currentColor: null,
    turnIndex: 0,
    direction: 1,
    phase: 'normal', // normal | drawnChoice
    drawnCardId: null,
    unoCalled: false,
    winnerId: null,
    winnerName: null,
    log: [],
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, name) {
  const p = {
    id: makeId(),
    name: String(name).trim().slice(0, 20),
    token: makeToken(),
    ws: null,
    connected: false,
    hand: [],
  };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

function log(room, msg) {
  room.log.push(msg);
  if (room.log.length > 30) room.log.shift();
}

function currentPlayer(room) { return room.players[room.turnIndex]; }
function topCard(room) { return room.discard[room.discard.length - 1]; }
function nextIndex(room, steps) {
  const n = room.players.length;
  return (((room.turnIndex + room.direction * steps) % n) + n) % n;
}

function reshuffleIfNeeded(room) {
  if (room.drawPile.length === 0 && room.discard.length > 1) {
    const top = room.discard.pop();
    const rest = room.discard.splice(0);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    room.drawPile = rest;
    room.discard = [top];
    log(room, 'Draw pile khatam — discard pile se naye cards banaye gaye.');
  }
}

function drawCards(room, player, n) {
  for (let i = 0; i < n; i++) {
    reshuffleIfNeeded(room);
    if (room.drawPile.length === 0) break;
    player.hand.push(room.drawPile.pop());
  }
}

function advance(room, steps) {
  room.turnIndex = nextIndex(room, steps);
  room.phase = 'normal';
  room.drawnCardId = null;
  room.unoCalled = false;
}

function isPlayable(room, card) {
  if (card.color === 'wild') return true;
  const top = topCard(room);
  return card.color === room.currentColor || card.value === top.value;
}

function startGame(room) {
  const deck = buildDeck();
  room.drawPile = deck;
  room.discard = [];
  room.direction = 1;
  room.phase = 'normal';
  room.drawnCardId = null;
  room.unoCalled = false;
  room.winnerId = null;
  room.winnerName = null;
  for (const p of room.players) p.hand = [];
  for (let i = 0; i < 7; i++) {
    for (const p of room.players) p.hand.push(room.drawPile.pop());
  }
  // Starter must be a number card; action cards go back to the pile.
  const held = [];
  let starter = null;
  while (room.drawPile.length) {
    const c = room.drawPile.pop();
    if (ACTION_VALUES.includes(c.value)) held.push(c);
    else { starter = c; break; }
  }
  room.drawPile.push(...held);
  for (let i = room.drawPile.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.drawPile[i], room.drawPile[j]] = [room.drawPile[j], room.drawPile[i]];
  }
  room.discard.push(starter);
  room.currentColor = starter.color;
  room.turnIndex = Math.floor(Math.random() * room.players.length);
  room.status = 'playing';
  log(room, 'Game shuru! ' + currentPlayer(room).name + ' ki baari.');
}

function playCard(room, player, cardId, color) {
  if (room.status !== 'playing') return 'Game chal nahi raha.';
  if (currentPlayer(room).id !== player.id) return 'Teri baari nahi hai.';
  if (room.phase === 'drawnChoice' && cardId !== room.drawnCardId) {
    return 'Sirf khecha hua card khel sakte ho ya Pass karo.';
  }
  const idx = player.hand.findIndex((c) => c.id === cardId);
  if (idx === -1) return 'Ye card tumhare paas nahi hai.';
  const card = player.hand[idx];
  if (!isPlayable(room, card)) return 'Ye card nahi chalega — rang ya number milna chahiye.';
  if (card.color === 'wild' && !COLORS.includes(color)) return 'Wild ke liye rang chuno.';

  player.hand.splice(idx, 1);
  room.discard.push(card);
  // Normal (non-Wild) card khelne pe current color us card ke rang pe set hota hai.
  // Iske bina rang starter/Wild wale pe atka rehta aur rang-match galat ho jata.
  if (card.color !== 'wild') room.currentColor = card.color;
  log(room, player.name + ' ne ' + cardLabel(card) + ' khela.');

  // UNO rule: played to 1 card without calling UNO -> +2 penalty.
  if (player.hand.length === 1 && !room.unoCalled) {
    drawCards(room, player, 2);
    log(room, player.name + ' UNO bolna bhool gaya! +2 penalty cards.');
  }
  room.unoCalled = false;

  if (player.hand.length === 0) {
    room.status = 'finished';
    room.winnerId = player.id;
    room.winnerName = player.name;
    log(room, '🏆 ' + player.name + ' jeet gaya!');
    return null;
  }

  if (card.value === 'skip') {
    advance(room, 2);
    log(room, 'Skip! Agle player ki baari gayi.');
  } else if (card.value === 'reverse') {
    if (room.players.length === 2) {
      advance(room, 2);
      log(room, 'Reverse (2 players) — baari wapas!');
    } else {
      room.direction *= -1;
      advance(room, 1);
      log(room, 'Direction badal gayi!');
    }
  } else if (card.value === 'draw2') {
    const next = room.players[nextIndex(room, 1)];
    drawCards(room, next, 2);
    advance(room, 2);
    log(room, next.name + ' ne 2 cards uthaye (+2).');
  } else if (card.value === 'wild') {
    room.currentColor = color;
    advance(room, 1);
    log(room, 'Rang badal kar ' + COLOR_NAMES[color] + ' hua.');
  } else if (card.value === 'wild4') {
    room.currentColor = color;
    const next = room.players[nextIndex(room, 1)];
    drawCards(room, next, 4);
    advance(room, 2);
    log(room, next.name + ' ne 4 cards uthaye (Wild +4). Rang: ' + COLOR_NAMES[color] + '.');
  } else {
    advance(room, 1);
  }
  return null;
}

function drawOne(room, player) {
  if (room.status !== 'playing') return 'Game chal nahi raha.';
  if (currentPlayer(room).id !== player.id) return 'Teri baari nahi hai.';
  if (room.phase !== 'normal') return 'Pehle kheche hue card ka faisla karo (khelo ya Pass).';
  const before = player.hand.length;
  drawCards(room, player, 1);
  if (player.hand.length === before) return 'Pile me card nahi bacha.';
  const drawn = player.hand[player.hand.length - 1];
  log(room, player.name + ' ne card uthaya.');
  if (isPlayable(room, drawn)) {
    room.phase = 'drawnChoice';
    room.drawnCardId = drawn.id;
  } else {
    advance(room, 1);
  }
  return null;
}

function removePlayer(room, player) {
  const idx = room.players.indexOf(player);
  if (idx === -1) return;
  const wasCurrent = room.status === 'playing' && room.turnIndex === idx;
  room.players.splice(idx, 1);
  log(room, player.name + ' game chhod kar chala gaya.');
  if (room.hostId === player.id) room.hostId = room.players.length ? room.players[0].id : null;
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.status === 'playing') {
    if (room.players.length < 2) {
      room.status = 'finished';
      room.winnerId = room.players[0].id;
      room.winnerName = room.players[0].name;
      log(room, 'Sirf 1 player bacha — ' + room.players[0].name + ' jeet gaya.');
    } else if (wasCurrent) {
      room.turnIndex = room.turnIndex % room.players.length;
      room.phase = 'normal';
      room.drawnCardId = null;
      room.unoCalled = false;
    } else if (room.turnIndex > idx) {
      room.turnIndex -= 1;
    }
  } else if (room.turnIndex >= room.players.length) {
    room.turnIndex = 0;
  }
}

function publicState(room, me) {
  return {
    type: 'state',
    code: room.code,
    status: room.status,
    isHost: room.hostId === me.id,
    youId: me.id,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      cards: p.hand.length,
      connected: p.connected,
      isHost: p.id === room.hostId,
    })),
    hand: me.hand,
    topCard: topCard(room) || null,
    currentColor: room.currentColor,
    drawPileCount: room.drawPile.length,
    turnId: room.status === 'playing' ? currentPlayer(room).id : null,
    direction: room.direction,
    phase: room.phase,
    drawnCardId: room.drawnCardId,
    winnerId: room.winnerId,
    winnerName: room.winnerName,
    log: room.log.slice(-15),
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(publicState(room, p)));
    }
  }
}

function sendError(ws, message) {
  try {
    ws.send(JSON.stringify({ type: 'error', message }));
  } catch { /* ignore */ }
}

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) {
    try { player.ws.close(); } catch { /* ignore */ }
  }
  player.ws = ws;
  player.connected = true;
  ws.player = player;
  ws.room = room;
}

wss.on('connection', (ws) => {
  ws.player = null;
  ws.room = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendError(ws, 'Galat message.');
    }
    const player = ws.player;
    const room = ws.room;

    if (msg.type === 'create') {
      const name = String(msg.name || '').trim();
      if (!name) return sendError(ws, 'Naam likho.');
      const newRoom = createRoom();
      const p = addPlayer(newRoom, name);
      attach(ws, newRoom, p);
      ws.send(JSON.stringify({ type: 'joined', code: newRoom.code, token: p.token, playerId: p.id, name: p.name }));
      log(newRoom, p.name + ' ne room banaya.');
      broadcast(newRoom);
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').trim().toUpperCase();
      const target = rooms.get(code);
      if (!target) return sendError(ws, 'Room nahi mila. Code check karo.');
      if (msg.token) {
        const existing = target.players.find((p) => p.token === msg.token);
        if (existing) {
          attach(ws, target, existing);
          ws.send(JSON.stringify({ type: 'joined', code, token: existing.token, playerId: existing.id, name: existing.name }));
          broadcast(target);
          return;
        }
      }
      if (target.status !== 'lobby') {
        return sendError(ws, 'Game shuru ho chuka hai. Sirf purane players wapas jud sakte hain.');
      }
      const name = String(msg.name || '').trim();
      if (!name) return sendError(ws, 'Naam likho.');
      if (target.players.length >= 5) return sendError(ws, 'Room full hai (max 5).');
      if (target.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return sendError(ws, 'Ye naam pehle se hai, koi aur naam rakho.');
      }
      const p = addPlayer(target, name);
      attach(ws, target, p);
      ws.send(JSON.stringify({ type: 'joined', code, token: p.token, playerId: p.id, name: p.name }));
      log(target, p.name + ' room me jud gaya.');
      broadcast(target);
      return;
    }

    // All actions below need an attached player + room.
    if (!player || !room) return sendError(ws, 'Pehle room banao ya join karo.');

    if (msg.type === 'start') {
      if (room.hostId !== player.id) return sendError(ws, 'Sirf host game start kar sakta hai.');
      if (room.status !== 'lobby') return sendError(ws, 'Game pehle se chal raha hai.');
      if (room.players.length < 2) return sendError(ws, 'Start ke liye kam se kam 2 players chahiye.');
      startGame(room);
      broadcast(room);
      return;
    }

    if (msg.type === 'play') {
      const err = playCard(room, player, msg.cardId, msg.color);
      if (err) return sendError(ws, err);
      broadcast(room);
      return;
    }

    if (msg.type === 'draw') {
      const err = drawOne(room, player);
      if (err) return sendError(ws, err);
      broadcast(room);
      return;
    }

    if (msg.type === 'pass') {
      if (room.status !== 'playing') return sendError(ws, 'Game chal nahi raha.');
      if (currentPlayer(room).id !== player.id) return sendError(ws, 'Teri baari nahi hai.');
      if (room.phase !== 'drawnChoice') return sendError(ws, 'Pass karne ke liye pehle card uthao.');
      log(room, player.name + ' ne Pass kiya.');
      advance(room, 1);
      broadcast(room);
      return;
    }

    if (msg.type === 'uno') {
      if (room.status !== 'playing') return sendError(ws, 'Game chal nahi raha.');
      if (currentPlayer(room).id !== player.id) return sendError(ws, 'Teri baari nahi hai.');
      if (player.hand.length !== 2) return sendError(ws, 'UNO tabhi bolo jab 2 cards hon.');
      room.unoCalled = true;
      log(room, player.name + ' ne UNO bola! 🗣️');
      broadcast(room);
      return;
    }

    if (msg.type === 'rematch') {
      if (room.hostId !== player.id) return sendError(ws, 'Sirf host dobara shuru kar sakta hai.');
      if (room.status !== 'finished') return sendError(ws, 'Game khatam hone ke baad hi dobara khel sakte ho.');
      // Drop disconnected seats for the new round.
      room.players = room.players.filter((p) => p.connected);
      if (room.players.length < 2) return sendError(ws, 'Dobara khelne ke liye kam se kam 2 players chahiye.');
      if (!room.players.some((p) => p.id === room.hostId)) room.hostId = room.players[0].id;
      startGame(room);
      broadcast(room);
      return;
    }

    if (msg.type === 'leave') {
      const r = room;
      ws.player = null;
      ws.room = null;
      removePlayer(r, player);
      if (rooms.has(r.code)) broadcast(r);
      return;
    }

    sendError(ws, 'Pata nahi ye action kya hai.');
  });

  ws.on('close', () => {
    if (ws.player) {
      ws.player.connected = false;
      ws.player.ws = null;
      if (ws.room && rooms.has(ws.room.code)) broadcast(ws.room);
    }
  });
});

server.listen(PORT, () => {
  console.log('UNO Friends chal raha hai: http://localhost:' + PORT);
});
