// UNO Friends client — talks to the server over WebSocket.
// The server is the boss: this file only renders state and sends actions.
const $ = (id) => document.getElementById(id);

let ws = null;
let myId = null;
let myToken = null;
let myName = '';
let roomCode = '';
let state = null;
let prevHandIds = new Set();
let prevTopId = null;
let pendingWildCard = null;
let toastTimer = null;

const VALUE_LABEL = { skip: 'SKIP', reverse: 'REV', draw2: '+2', wild: 'WILD', wild4: '+4 WILD' };
const COLOR_NAMES = { red: 'Laal', yellow: 'Peela', green: 'Hara', blue: 'Neela' };

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function showScreen(which) {
  for (const id of ['screen-home', 'screen-lobby', 'screen-game']) {
    $(id).classList.toggle('hidden', id !== 'screen-' + which);
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host);
  ws.onopen = () => {
    const saved = sessionStorage.getItem('uno_session');
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.code && s.token) {
          myName = s.name || '';
          ws.send(JSON.stringify({ type: 'join', code: s.code, token: s.token, name: s.name || '' }));
          return;
        }
      } catch { /* fall through */ }
    }
    showScreen('home');
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'joined') {
      myId = msg.playerId;
      myToken = msg.token;
      myName = msg.name;
      roomCode = msg.code;
      sessionStorage.setItem('uno_session', JSON.stringify({ code: roomCode, token: myToken, name: myName }));
    } else if (msg.type === 'state') {
      state = msg;
      render();
    } else if (msg.type === 'error') {
      toast(msg.message);
    }
  };
  ws.onclose = () => {
    toast('Connection toot gaya, dobara jud rahe hain…');
    setTimeout(connect, 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function isPlayable(card) {
  if (!state || state.status !== 'playing') return false;
  if (state.turnId !== myId) return false;
  if (state.phase === 'drawnChoice' && card.id !== state.drawnCardId) return false;
  if (card.color === 'wild') return true;
  return card.color === state.currentColor || card.value === state.topCard.value;
}

function cardEl(card, opts) {
  const div = document.createElement('div');
  div.className = 'card ' + card.color + (opts.big ? ' big' : '');
  if (opts.playable) div.classList.add('playable');
  if (opts.dealt) div.classList.add('dealt');
  if (opts.pop) div.classList.add('pop');
  const big = document.createElement('div');
  big.className = 'big-val';
  big.textContent = card.color === 'wild' ? (VALUE_LABEL[card.value] || card.value) : (VALUE_LABEL[card.value] || card.value);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = card.color === 'wild' ? 'WILD' : COLOR_NAMES[card.color].toUpperCase();
  div.appendChild(big);
  div.appendChild(sub);
  if (opts.onClick) div.addEventListener('click', opts.onClick);
  return div;
}

function render() {
  if (!state) return;
  if (state.status === 'lobby') {
    showScreen('lobby');
    $('roomCode').textContent = state.code;
    $('gameCode').textContent = state.code;
    const list = $('lobbyPlayers');
    list.innerHTML = '';
    for (const p of state.players) {
      const li = document.createElement('li');
      if (p.id === myId) li.classList.add('me');
      li.textContent = p.name + (p.isHost ? ' 👑 (host)' : '') + (p.id === myId ? ' (tum)' : '');
      list.appendChild(li);
    }
    const iAmHost = state.isHost;
    $('btnStart').classList.toggle('hidden', !iAmHost);
    $('btnStart').disabled = state.players.length < 2;
    $('btnStart').textContent = state.players.length < 2
      ? 'Start (kam se kam 2 players chahiye)'
      : 'Start ▶ Cards Baanto';
    $('lobbyNote').textContent = iAmHost
      ? 'Tum host ho — sab jud jayein toh Start dabao.'
      : 'Host ke Start dabane ka intezaar karo…';
    return;
  }

  // playing / finished
  showScreen('game');
  $('gameCode').textContent = state.code;
  $('roomCode').textContent = state.code;

  // Winner banner
  const finished = state.status === 'finished';
  $('winnerBanner').classList.toggle('hidden', !finished);
  if (finished) {
    $('winnerName').textContent = state.winnerName || 'Koi';
    $('btnRematch').classList.toggle('hidden', !state.isHost);
    $('rematchNote').classList.toggle('hidden', state.isHost);
  }

  // Opponents
  const opp = $('opponents');
  opp.innerHTML = '';
  for (const p of state.players) {
    if (p.id === myId) continue;
    const div = document.createElement('div');
    div.className = 'opp' + (state.turnId === p.id && state.status === 'playing' ? ' turn' : '');
    const name = document.createElement('div');
    name.className = 'opp-name';
    name.textContent = p.name + (p.isHost ? ' 👑' : '');
    const cards = document.createElement('div');
    cards.className = 'opp-cards';
    cards.textContent = '🃏 ' + p.cards + ' cards';
    div.appendChild(name);
    div.appendChild(cards);
    if (!p.connected) {
      const off = document.createElement('div');
      off.className = 'off';
      off.textContent = 'offline';
      div.appendChild(off);
    }
    opp.appendChild(div);
  }

  // Discard + color + turn
  const discard = $('discardCard');
  discard.innerHTML = '';
  if (state.topCard) {
    const el = cardEl(state.topCard, { big: true, pop: state.topCard.id !== prevTopId });
    discard.appendChild(el);
    prevTopId = state.topCard.id;
  }
  $('colorOrb').className = 'orb ' + (state.currentColor || '');
  $('drawCount').textContent = state.drawPileCount;
  const turnPlayer = state.players.find((p) => p.id === state.turnId);
  $('turnLabel').textContent = state.status === 'playing'
    ? ('Baari: ' + (turnPlayer ? (turnPlayer.id === myId ? 'TUMHARI' : turnPlayer.name) : '—'))
    : 'Game khatam';

  // Phase hint
  const myTurn = state.status === 'playing' && state.turnId === myId;
  let hint = '';
  if (state.status === 'playing') {
    if (myTurn) {
      hint = state.phase === 'drawnChoice'
        ? 'Khecha hua card chal raha hai — use khelo ya Pass karo.'
        : 'Teri baari hai — koi card khelo ya draw pile se card uthao.';
    } else {
      hint = (turnPlayer ? turnPlayer.name : 'Koi') + ' ki baari hai…';
    }
  }
  $('phaseHint').textContent = hint;

  // UNO + Pass buttons
  const myCards = state.hand ? state.hand.length : 0;
  $('btnUno').classList.toggle('hidden', !(myTurn && myCards === 2 && state.phase === 'normal'));
  $('btnPass').classList.toggle('hidden', !(myTurn && state.phase === 'drawnChoice'));

  // My hand
  const handEl = $('myHand');
  const newIds = new Set();
  handEl.innerHTML = '';
  for (const card of state.hand || []) {
    newIds.add(card.id);
    const playable = isPlayable(card);
    const el = cardEl(card, {
      playable,
      dealt: !prevHandIds.has(card.id),
      onClick: () => onCardClick(card),
    });
    handEl.appendChild(el);
  }
  prevHandIds = newIds;
  $('myCount').textContent = myCards;

  // Log
  const logList = $('logList');
  logList.innerHTML = '';
  for (const line of (state.log || []).slice().reverse()) {
    const li = document.createElement('li');
    li.textContent = line;
    logList.appendChild(li);
  }
}

function onCardClick(card) {
  if (!state || state.status !== 'playing') return;
  if (state.turnId !== myId) { toast('Abhi teri baari nahi hai.'); return; }
  if (state.phase === 'drawnChoice' && card.id !== state.drawnCardId) {
    toast('Sirf khecha hua card khel sakte ho ya Pass karo.');
    return;
  }
  if (!isPlayable(card)) { toast('Ye card nahi chalega — rang ya number milna chahiye.'); return; }
  if (card.color === 'wild') {
    pendingWildCard = card;
    $('colorModal').classList.remove('hidden');
    return;
  }
  send({ type: 'play', cardId: card.id });
}

// ---- UI events ----
$('btnCreate').addEventListener('click', () => {
  const name = $('nameInput').value.trim();
  if (!name) return toast('Pehle apna naam likho.');
  myName = name;
  if (!ws || ws.readyState !== WebSocket.OPEN) return toast('Server se jud rahe hain, 1 sec ruk jao…');
  send({ type: 'create', name });
});

$('btnJoin').addEventListener('click', () => {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return toast('Pehle apna naam likho.');
  if (!code) return toast('Room code daalo.');
  myName = name;
  if (!ws || ws.readyState !== WebSocket.OPEN) return toast('Server se jud rahe hain, 1 sec ruk jao…');
  send({ type: 'join', name, code });
});

$('btnStart').addEventListener('click', () => send({ type: 'start' }));
$('btnRematch').addEventListener('click', () => send({ type: 'rematch' }));

$('btnCopy').addEventListener('click', async () => {
  const code = $('roomCode').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('Code copy ho gaya: ' + code);
  } catch {
    toast('Code: ' + code + ' — ise manually copy kar lo.');
  }
});

function leaveRoom() {
  send({ type: 'leave' });
  sessionStorage.removeItem('uno_session');
  myId = null;
  myToken = null;
  roomCode = '';
  state = null;
  prevHandIds = new Set();
  prevTopId = null;
  showScreen('home');
}
$('btnLeaveLobby').addEventListener('click', leaveRoom);
$('btnLeaveGame').addEventListener('click', leaveRoom);

$('drawPile').addEventListener('click', () => {
  if (!state || state.status !== 'playing') return;
  if (state.turnId !== myId) { toast('Abhi teri baari nahi hai.'); return; }
  if (state.phase !== 'normal') { toast('Pehle kheche hue card ka faisla karo (khelo ya Pass).'); return; }
  send({ type: 'draw' });
});

$('btnPass').addEventListener('click', () => send({ type: 'pass' }));
$('btnUno').addEventListener('click', () => send({ type: 'uno' }));

document.querySelectorAll('.color-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const color = btn.getAttribute('data-color');
    if (pendingWildCard) {
      send({ type: 'play', cardId: pendingWildCard.id, color });
      pendingWildCard = null;
    }
    $('colorModal').classList.add('hidden');
  });
});
$('btnCancelColor').addEventListener('click', () => {
  pendingWildCard = null;
  $('colorModal').classList.add('hidden');
});

connect();
