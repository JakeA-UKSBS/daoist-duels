// ─── Daoist Duels — client ────────────────────────────────────────────────────
const socket = io();

// ── State ─────────────────────────────────────────────────────────────────────
let myId = null;
let room = null;
let selectedSpell = 'dragon_blast';

// Aiming — driven by mouse position relative to player
let aimAngle = -45;   // degrees, -180..180
let aimPower = 60;    // 10..100, driven by mouse distance from player

// Mouse world position
let mouseWorld = { x: 0, y: 0 };
let isAiming = false;  // true while right-button or holding to aim

// Camera
const cam = { x: 0, y: 0, zoom: 1 };
let panning = false;
let panStart = { x: 0, y: 0, camX: 0, camY: 0 };

// Keys held
const keys = {};
let moveInterval = null;

// Projectile animation
let projAnim = null;

// ── Art ───────────────────────────────────────────────────────────────────────
const PLAYER_H = 40;   // sprite height in world px; body centre is PLAYER_H/2 above feet
const CHAR_SPRITES = ['cultivator', 'sage', 'geisha', 'lucky_cat'].map(n => {
  const img = new Image();
  img.src = `/assets/characters/${n}.png`;
  img.onload = () => render();
  return img;
});
const bgCache = {};
function bgImage(src) {
  if (!src) return null;
  if (!bgCache[src]) {
    const img = new Image();
    img.src = src;
    img.onload = () => render();
    bgCache[src] = img;
  }
  return bgCache[src].complete && bgCache[src].naturalWidth ? bgCache[src] : null;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const lobbyEl    = document.getElementById('lobby');
const gameEl     = document.getElementById('game');
const canvas     = document.getElementById('gameCanvas');
const ctx        = canvas.getContext('2d');
const hudEl      = document.getElementById('hud');
const hpBarsEl   = document.getElementById('hp-bars');
const logEl      = document.getElementById('log');
const turnInfo   = document.getElementById('turn-info');
const powerDisp  = document.getElementById('power-display');
const playerList = document.getElementById('player-list');
const startBtn   = document.getElementById('start-btn');
const gameoverEl = document.getElementById('gameover');

// ── Resize canvas ─────────────────────────────────────────────────────────────
function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  render();
}
window.addEventListener('resize', resize);
resize();

// ── Lobby ─────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
let vsBots = false;
function joinRoom(roomId) {
  const name = $('name-input').value.trim() || 'Daoist';
  const charIndex = Number($('char-select').value);
  $('mode-row').style.display = 'none';
  $('room-row').style.display = 'none';
  socket.emit('join_room', { roomId, name, charIndex });
}
const randomCode = () => Math.random().toString(36).slice(2, 7);
$('bots-btn').addEventListener('click', () => { vsBots = true; joinRoom('solo-' + randomCode()); });
$('friends-btn').addEventListener('click', () => {
  $('mode-row').style.display = 'none';
  $('room-row').style.display = 'flex';
  if (!$('room-input').value) $('room-input').value = randomCode();
});
$('join-btn').addEventListener('click', () => joinRoom($('room-input').value.trim() || randomCode()));
const CHAR_FILES = ['cultivator', 'sage', 'geisha', 'lucky_cat'];
$('char-select').addEventListener('change', e => {
  $('char-preview').src = `/assets/characters/${CHAR_FILES[e.target.value]}.png`;
});
$('add-bot-btn').addEventListener('click', () => socket.emit('add_bot'));
// Invite links: ?room=abc drops you straight into the join step
const linkRoom = new URLSearchParams(location.search).get('room');
if (linkRoom) {
  $('mode-row').style.display = 'none';
  $('room-row').style.display = 'flex';
  $('room-input').value = linkRoom;
}
startBtn.addEventListener('click', () => {
  socket.emit('start_game', { map: document.getElementById('map-select').value });
});

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('joined', ({ playerId, room: r }) => {
  myId = playerId;
  room = r;
  updateLobbyList();
  const isHost = room.players[0]?.id === myId;
  if (isHost) {
    $('map-row').style.display = 'block';
    $('add-bot-btn').style.display = 'block';
    if (vsBots) socket.emit('add_bot');
  }
  if (!vsBots) {
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(r.id)}`;
    $('invite-info').style.display = 'block';
    const a = document.createElement('a');
    a.href = link; a.textContent = link; a.style.color = '#f0a040';
    $('invite-info').replaceChildren(`Room ${r.id} — send friends this link:`, document.createElement('br'), a);
  }
});

socket.on('player_joined', ({ player, players }) => {
  if (!room) return;
  room.players = players;
  updateLobbyList();
  log(`${player.name} joined the arena`);
});

socket.on('player_left', ({ id }) => {
  if (!room) return;
  const p = room.players.find(p => p.id === id);
  room.players = room.players.filter(p => p.id !== id);
  if (p) log(`${p.name} left`);
  updateLobbyList();
  renderHpBars();
});

socket.on('game_started', ({ room: r }) => {
  room = r;
  terrainDirty = true;
  enterGame();
});

socket.on('player_moved', ({ id, x, y, facing, hp }) => {
  const p = room?.players.find(p => p.id === id);
  if (p) {
    p.x = x; p.y = y; p.facing = facing;
    if (hp !== undefined && hp !== p.hp) {
      p.hp = hp;
      if (hp <= 0) log(`${p.name} fell into the abyss!`);
      renderHpBars();
    }
  }
  render();
});

socket.on('player_jumped', ({ id, path, x, y, facing, hp }) => {
  const p = room?.players.find(p => p.id === id);
  if (p) p.jump = { path, i: 0, end: { x, y, facing, hp } };
});

socket.on('player_aimed', ({ id, angle, power }) => {
  const p = room?.players.find(p => p.id === id);
  if (p) { p.angle = angle; p.power = power; }
  render();
});

// Wind-up before a spell launches
let castAnim = null;
socket.on('casting', ({ id, spell, facing }) => {
  const p = room?.players.find(p => p.id === id);
  if (p) p.facing = facing;
  stopMoving();
  const c = castAnim = { id, spell, t0: Date.now() };
  setTimeout(() => { if (castAnim === c) castAnim = null; }, 2000);   // safety if the cast is cancelled
});

socket.on('projectile_result', ({ path, landX, landY, spell, radius, hits, fallen, carve, players }) => {
  stopMoving();
  castAnim = null;
  // Apply the result only once the projectile lands, so the crater/knockback
  // appear with the explosion rather than before it
  const apply = () => {
    if (!room) return;
    Terrain.carve(room.terrain, landX, landY, carve);
    terrainDirty = true;
    players.forEach(u => {
      const p = room.players.find(p => p.id === u.id);
      if (p) Object.assign(p, u);
    });
    (hits || []).forEach(h => {
      const p = room.players.find(p => p.id === h.id);
      if (p) floaters.push({ x: p.x, y: p.y - PLAYER_H - 14, text: `-${h.dmg}`, t0: Date.now() });
    });
    (fallen || []).forEach(n => log(`${n} fell into the abyss!`));
    renderHpBars();
  };
  projAnim = { path, idx: 0, landX, landY, spell, radius, apply, onDone: () => {
    projAnim = null;
    if (pendingTurn) { const id = pendingTurn; pendingTurn = null; applyTurn(id); }
    else followPlayer(room?.currentPlayerId);
  } };
  camFollow = () => projAnim && projAnim.path[Math.min(projAnim.idx, projAnim.path.length - 1)];
  animateProjectile();
});

// The server hands over the turn as soon as a shot is fired — hold the switch
// (camera + "your turn") until the shot has landed so everyone sees it hit
let pendingTurn = null;
socket.on('turn_changed', ({ currentPlayerId }) => {
  if (projAnim) { pendingTurn = currentPlayerId; return; }
  applyTurn(currentPlayerId);
});
function applyTurn(id) {
  if (room) room.currentPlayerId = id;
  updateTurnInfo();
  followPlayer(id);
  render();
}

socket.on('game_over', ({ winner }) => {
  const msg = winner ? `${winner.name} wins the duel! 🏆` : 'The battle ends in a draw.';
  document.getElementById('gameover-msg').textContent = msg;
  gameoverEl.style.display = 'flex';
  log(msg);
});

socket.on('error', (msg) => alert(msg));

// ── Enter game ────────────────────────────────────────────────────────────────
function enterGame() {
  cam.zoom = 1.2;
  document.getElementById('controls').style.display = 'block';
  lobbyEl.style.display = 'none';
  gameEl.style.display = 'block';
  hudEl.style.display = 'flex';
  hpBarsEl.style.display = 'flex';
  logEl.style.display = 'block';
  centreOnMe();
  followPlayer(room.currentPlayerId);
  updateTurnInfo();
  renderHpBars();
  render();
  requestAnimationFrame(gameLoop);
}

// ── Game loop ─────────────────────────────────────────────────────────────────
let lastTime = 0;
function gameLoop(ts) {
  lastTime = ts;
  updateCamera();
  room?.players.forEach(p => {
    if (!p.jump) return;
    const pt = p.jump.path[Math.min(p.jump.i, p.jump.path.length - 1)];
    if (pt) { p.x = pt.x; p.y = pt.y; }
    p.jump.i += 1;
    if (p.jump.i >= p.jump.path.length) {
      Object.assign(p, p.jump.end);
      if (p.hp <= 0) log(`${p.name} fell to their doom!`);
      renderHpBars();
      p.jump = null;
    }
  });
  render();
  requestAnimationFrame(gameLoop);
}

// ── Keyboard movement ─────────────────────────────────────────────────────────
// Held keys send repeated move events — feels smooth like Worms
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;   // typing in the lobby
  if (keys[e.key]) return; // already held
  keys[e.key] = true;

  if (e.key === ' ') { e.preventDefault(); followPlayer(myId); return; }
  if (e.key === 'h') { const c = document.getElementById('controls'); c.classList.toggle('hidden'); return; }
  if (e.key >= '1' && e.key <= '4') { document.querySelectorAll('.spell-btn')[Number(e.key) - 1]?.click(); return; }
  if (!isMyTurn() || projAnim) return;

  if (e.key === 'ArrowLeft'  || e.key === 'a') { followPlayer(myId); startMoving(-1); }
  if (e.key === 'ArrowRight' || e.key === 'd') { followPlayer(myId); startMoving(1); }
  const jumpKind = (e.key === 'ArrowUp' || e.key === 'w') ? 'hop' : (e.key === 'q' || e.key === 'ArrowDown') ? 'leap' : null;
  if (jumpKind) {
    e.preventDefault();
    const me = myPlayer();
    if (me && !me.jump) { stopMoving(); followPlayer(myId); socket.emit('jump', { kind: jumpKind }); }
  }
});

window.addEventListener('keyup', e => {
  keys[e.key] = false;
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'ArrowRight' || e.key === 'd') {
    stopMoving();
  }
});

function startMoving(dir) {
  stopMoving();
  doMove(dir);
  moveInterval = setInterval(() => doMove(dir), 50); // 20fps movement ticks
}

function stopMoving() {
  clearInterval(moveInterval);
  moveInterval = null;
}

function doMove(dir) {
  if (!isMyTurn() || projAnim) { stopMoving(); return; }
  const me = myPlayer();
  if (!me) return;

  // Client-side prediction: move locally immediately
  if (me.jump) return;
  me.facing = dir;
  Terrain.walk(room.terrain, me, dir * 10);

  socket.emit('move', { direction: dir });
  render();
}

// ── Mouse aim ─────────────────────────────────────────────────────────────────
// Move mouse around your character to aim — angle tracks cursor, distance = power
canvas.addEventListener('mousemove', e => {
  mouseWorld = screenToWorld(e.clientX, e.clientY);

  if (!isMyTurn() || projAnim) return;

  const me = myPlayer();
  if (!me) return;

  // Angle from player to mouse
  const dx = mouseWorld.x - me.x;
  const dy = mouseWorld.y - (me.y - PLAYER_H / 2); // aim from centre of player
  aimAngle = Math.atan2(dy, dx) * 180 / Math.PI;

  // Clamp: can't aim straight down or behind — keep to front hemisphere
  // (server will use facing to determine actual vx direction)
  // Power: distance mapped 50–400px → 10–100
  const dist = Math.sqrt(dx * dx + dy * dy);
  aimPower = Math.round(Math.max(10, Math.min(100, (dist / 500) * 100)));
  me.facing = dx >= 0 ? 1 : -1;

  powerDisp.textContent = `Power: ${aimPower} | Angle: ${Math.round(aimAngle)}°`;

  socket.emit('aim', { angle: aimAngle, power: aimPower });
  render();
});

// Left click = fire
canvas.addEventListener('click', e => {
  // Ignore if we just finished a pan drag
  if (panning) return;
  if (!isMyTurn() || projAnim) return;
  fireSpell();
});

// Right-click / middle drag = pan camera
canvas.addEventListener('mousedown', e => {
  if (e.button === 1 || e.button === 2) {
    panning = true;
    camFollow = null;
    panStart = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y };
    e.preventDefault();
  }
});
canvas.addEventListener('mousemove', e => {
  if (!panning) return;
  cam.x = panStart.camX - (e.clientX - panStart.x) / cam.zoom;
  cam.y = panStart.camY - (e.clientY - panStart.y) / cam.zoom;
  clampCamera();
  render();
});
canvas.addEventListener('mouseup', e => {
  if (e.button === 1 || e.button === 2) panning = false;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('wheel', e => {
  camFollow = null;
  const before = screenToWorld(e.clientX, e.clientY);
  cam.zoom = Math.max(0.25, Math.min(2, cam.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
  // Keep the point under cursor fixed
  const after = screenToWorld(e.clientX, e.clientY);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
  clampCamera();
  render();
}, { passive: true });

// Spell bar
document.querySelectorAll('.spell-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.spell-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedSpell = btn.dataset.spell;
    render();
  });
});

function fireSpell() {
  if (!isMyTurn() || projAnim || myPlayer()?.jump) return;
  socket.emit('fire', { spell: selectedSpell, angle: aimAngle, power: aimPower });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isMyTurn() {
  return room?.phase === 'playing' && room?.currentPlayerId === myId && !castAnim;
}
function myPlayer() {
  return room?.players.find(p => p.id === myId);
}

function screenToWorld(sx, sy) {
  return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
}

// ── Camera ────────────────────────────────────────────────────────────────────
function clampCamera() {
  if (!room) return;
  const { worldW, worldH } = room.terrain;
  const vw = canvas.width / cam.zoom;
  const vh = canvas.height / cam.zoom;
  // Centre the world if it's smaller than the screen, otherwise keep it in view
  cam.x = worldW <= vw ? (worldW - vw) / 2 : Math.max(0, Math.min(worldW - vw, cam.x));
  cam.y = worldH <= vh ? (worldH - vh) / 2 : Math.max(0, Math.min(worldH - vh, cam.y));
}

// Floating damage numbers (screen-space size, world-space position)
const floaters = [];
function drawFloaters() {
  const now = Date.now();
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i], age = (now - f.t0) / 1400;
    if (age >= 1) { floaters.splice(i, 1); continue; }
    const sx = (f.x - cam.x) * cam.zoom, sy = (f.y - cam.y) * cam.zoom - age * 50;
    ctx.globalAlpha = 1 - age * age;
    ctx.font = 'bold 26px Georgia';
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#2a0000';
    ctx.strokeText(f.text, sx, sy);
    ctx.fillStyle = '#ff4a3a';
    ctx.fillText(f.text, sx, sy);
    ctx.globalAlpha = 1;
  }
}

// Camera smoothly tracks whatever camFollow returns; manual pan/zoom stops it
let camFollow = null;
function followPlayer(id) {
  camFollow = () => { const p = room?.players.find(p => p.id === id); return p && { x: p.x, y: p.y - PLAYER_H / 2 }; };
}
function updateCamera() {
  const t = camFollow && camFollow();
  if (!t) return;
  const tx = t.x - (canvas.width / cam.zoom) / 2, ty = t.y - (canvas.height / cam.zoom) / 2;
  cam.x += (tx - cam.x) * 0.12;
  cam.y += (ty - cam.y) * 0.12;
  clampCamera();
}

function centreOnMe() {
  const me = myPlayer();
  const target = me || room?.players[0];
  if (!target) return;
  cam.x = target.x - (canvas.width / cam.zoom) / 2;
  cam.y = target.y - (canvas.height / cam.zoom) / 2;
  clampCamera();
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  if (!room) return;
  const W = canvas.width, H = canvas.height;
  const { worldW, worldH } = room.terrain;

  ctx.save();
  ctx.clearRect(0, 0, W, H);

  // Sky gradient (outside the world)
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0d0520');
  sky.addColorStop(0.6, '#2a0d4a');
  sky.addColorStop(1, '#1a0828');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  drawScreenBackdrop(room.terrain, W, H);

  // World transform
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  drawBackground(room.terrain);
  if (terrainDirty) buildTerrainCache();
  ctx.drawImage(terrainCanvas, 0, 0);

  room.players.forEach(p => drawPlayer(p));
  if (castAnim) drawCasting(castAnim);
  drawLiquid(room.terrain);

  // Aim indicator — dotted arc from current player outward to mouse
  if (isMyTurn() && !projAnim) {
    const me = myPlayer();
    if (me) drawAimIndicator(me);
  }

  // Projectile + fading trail
  if (projAnim && !projAnim.showBlast) {
    const i = Math.min(projAnim.idx, projAnim.path.length - 1);
    const col = spellColor(projAnim.spell);
    for (let k = Math.max(0, i - 12); k < i; k++) {
      const q = projAnim.path[k];
      ctx.globalAlpha = (k - (i - 12)) / 16;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 3 + (k - (i - 12)) * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const pt = projAnim.path[i];
    if (pt) drawProjectile(pt.x, pt.y, projAnim.spell);
  }

  if (projAnim && projAnim.showBlast) drawBlast(projAnim);

  ctx.restore();

  drawFloaters();
}

// ── Terrain drawing ───────────────────────────────────────────────────────────
// Terrain only changes on explosions, so it's drawn once into an offscreen canvas
let terrainDirty = true;
const terrainCanvas = document.createElement('canvas');
const MAT_STYLE = [
  { body: ['#4b6e32', '#24361a'], top: '#9fd27c', top2: '#6a9a4a', edge: '#1d2c14' },   // earth + grass
  { body: ['#4d3f2f', '#2f261c'], top: '#7d6a52', top2: '#5e4e3b', edge: '#1e1812' },   // rock
  { body: ['#e9ddd1', '#cdbdae'], top: '#f8f1ea', top2: '#efe4d9', edge: '#a8968a' },   // bone (matches the spine art)
];

// Parts of [a,b] not covered by any span in a neighbouring column
function uncovered(a, b, spans) {
  const out = [];
  let y = a;
  for (const [s0, s1] of spans) {
    if (s1 < y || s0 > b) continue;
    if (s0 > y) out.push([y, s0]);
    y = Math.max(y, s1);
  }
  if (y < b) out.push([y, b]);
  return out;
}

const artCache = {};
function artImage(src) {
  if (!artCache[src]) {
    const img = new Image();
    img.onload = () => { terrainDirty = true; };
    img.src = src;
    artCache[src] = img;
  }
  return artCache[src].complete && artCache[src].naturalWidth ? artCache[src] : null;
}

function buildTerrainCache() {
  terrainDirty = false;
  const t = room.terrain, C = Terrain.COL;
  terrainCanvas.width = t.worldW;
  terrainCanvas.height = t.worldH;
  const g = terrainCanvas.getContext('2d');
  const grads = MAT_STYLE.map(st => {
    const gr = g.createLinearGradient(0, 300, 0, t.worldH);
    gr.addColorStop(0, st.body[0]);
    gr.addColorStop(1, st.body[1]);
    return gr;
  });

  t.cols.forEach((spans, c) => {
    const x = c * C;
    spans.forEach(([a, b, m]) => {
      if (m === Terrain.MAT.ART) return;
      const st = MAT_STYLE[m], h = b - a;
      g.fillStyle = grads[m];
      g.fillRect(x, a, C, h);
      // Lit top surface, dark underside
      g.fillStyle = st.top2; g.fillRect(x, a, C, Math.min(10, h));
      g.fillStyle = st.top;  g.fillRect(x, a, C, Math.min(4, h));
      if (m === 2) { g.fillStyle = st.edge; g.fillRect(x, a, C, Math.min(2, h)); }
      g.fillStyle = st.edge; g.fillRect(x, Math.max(a, b - 3), C, Math.min(3, h));
      // Outline exposed sides
      for (const [n, sx] of [[c - 1, x], [c + 1, x + C - 2]]) {
        uncovered(a, b, t.cols[n] || []).forEach(([y0, y1]) => {
          g.fillStyle = st.edge;
          g.fillRect(sx, y0, 2, y1 - y0);
        });
      }
    });
  });

  // Artwork terrain (e.g. the spine): paint the image, clipped to what's left of it
  (t.images || []).forEach(im => {
    const img = artImage(im.src);
    if (!img) return;
    g.save();
    g.beginPath();
    t.cols.forEach((spans, c) => spans.forEach(([a, b, m]) => { if (m === Terrain.MAT.ART) g.rect(c * C, a, C, b - a); }));
    g.clip();
    g.drawImage(img, im.x, im.y, im.w, im.h);
    g.restore();
  });

  // Decorations — only where the ground under them still exists
  t.decor.forEach(d => {
    const probe = d.type === 'teeth' ? d.y - 3 : (d.type === 'eye' || d.type === 'nostril') ? d.y : d.y + 3;
    if (Terrain.isSolid(t, d.x, probe)) drawDecor(g, d);
  });
}

function drawDecor(g, d) {
  const { x, y } = d;
  g.save();
  switch (d.type) {
    case 'bamboo': {
      [[-11, 120, '#5f8f3c'], [0, 155, '#6fa448'], [11, 105, '#56843a']].forEach(([ox, h, col]) => {
        g.fillStyle = col;
        g.fillRect(x + ox - 3, y - h, 6, h);
        g.fillStyle = '#3c5e26';
        for (let k = 22; k < h; k += 24) g.fillRect(x + ox - 4, y - k, 8, 2);
        g.fillStyle = '#7fb85a';
        for (let k = 0; k < 3; k++) {
          g.beginPath();
          g.ellipse(x + ox + (k % 2 ? 9 : -9), y - h + 10 + k * 14, 11, 3.5, k % 2 ? -0.5 : 0.5, 0, Math.PI * 2);
          g.fill();
        }
      });
      break;
    }
    case 'boulder':
      g.fillStyle = '#6f6b67'; g.beginPath(); g.arc(x - 8, y - 16, 20, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#8c8783'; g.beginPath(); g.arc(x + 8, y - 13, 15, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.arc(x - 13, y - 24, 7, 0, Math.PI * 2); g.fill();
      break;
    case 'cherry':
      g.fillStyle = '#5a3a28';
      g.beginPath(); g.moveTo(x - 5, y); g.lineTo(x - 2, y - 70); g.lineTo(x + 3, y - 70); g.lineTo(x + 6, y); g.fill();
      g.fillRect(x - 1, y - 70, 22, 4);
      [['#f4b6c8', -18, -82, 26], ['#f7c9d6', 12, -90, 28], ['#eda0b8', 28, -74, 20], ['#f9d6e0', -4, -104, 22]].forEach(([c, ox, oy, r]) => {
        g.fillStyle = c; g.beginPath(); g.arc(x + ox, y + oy, r, 0, Math.PI * 2); g.fill();
      });
      break;
    case 'pagoda': {
      const tiers = [[56, 30], [46, 26], [36, 22]];
      let yy = y;
      tiers.forEach(([w, h]) => {
        g.fillStyle = '#a03a22'; g.fillRect(x - w / 2 + 6, yy - h, w - 12, h);
        g.fillStyle = '#2f6b4a';
        g.beginPath(); g.moveTo(x - w / 2 - 10, yy - h + 4); g.lineTo(x + w / 2 + 10, yy - h + 4);
        g.lineTo(x + w / 2 - 4, yy - h - 10); g.lineTo(x - w / 2 + 4, yy - h - 10); g.fill();
        yy -= h + 10;
      });
      g.fillStyle = '#d4a93a'; g.fillRect(x - 2, yy - 18, 4, 18);
      break;
    }
    case 'torii':
      g.fillStyle = '#c2342a';
      g.fillRect(x - 46, y - 110, 9, 110); g.fillRect(x + 37, y - 110, 9, 110);
      g.fillRect(x - 54, y - 92, 108, 8);
      g.fillStyle = '#2a1a16';
      g.beginPath(); g.moveTo(x - 68, y - 118); g.lineTo(x + 68, y - 118); g.lineTo(x + 60, y - 106); g.lineTo(x - 60, y - 106); g.fill();
      break;
    case 'eye': {
      g.fillStyle = '#1a0f08'; g.beginPath(); g.ellipse(x, y, 34, 28, 0, 0, Math.PI * 2); g.fill();
      const eg = g.createRadialGradient(x, y, 0, x, y, 16);
      eg.addColorStop(0, 'rgba(255,90,20,0.9)'); eg.addColorStop(1, 'rgba(255,40,0,0)');
      g.fillStyle = eg; g.beginPath(); g.arc(x, y, 16, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'nostril':
      g.fillStyle = '#1a0f08'; g.beginPath(); g.ellipse(x, y, 9, 5, -0.3, 0, Math.PI * 2); g.fill();
      break;
    case 'teeth':
      g.fillStyle = '#efe6b8'; g.strokeStyle = '#6e6438'; g.lineWidth = 1.5;
      for (let tx = x; tx < x + d.w; tx += 18) {
        g.beginPath(); g.moveTo(tx, y); g.lineTo(tx + 12, y); g.lineTo(tx + 6, y + 22); g.closePath(); g.fill(); g.stroke();
      }
      break;
  }
  g.restore();
}

// Painted backdrops are drawn screen-sized with gentle parallax (like Worms),
// so they stay crisp and don't get mistaken for terrain
function drawScreenBackdrop(t, W, H) {
  const bg = bgImage(t.bg);
  if (!bg) return false;
  const sc = Math.max(W / bg.naturalWidth, H / bg.naturalHeight) * 1.15;
  const w = bg.naturalWidth * sc, h = bg.naturalHeight * sc;
  const px = Math.max(0, Math.min(1, cam.x / Math.max(1, t.worldW - W / cam.zoom)));
  const py = Math.max(0, Math.min(1, cam.y / Math.max(1, t.worldH - H / cam.zoom)));
  ctx.drawImage(bg, -(w - W) * px, -(h - H) * py, w, h);
  return true;
}

function drawBackground(t) {
  if (t.bg) return;   // drawn in screen space instead
  const g = ctx.createLinearGradient(0, 0, 0, t.worldH);
  g.addColorStop(0, '#120b09');
  g.addColorStop(0.6, '#1d100b');
  g.addColorStop(1, '#4a1606');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, t.worldW, t.worldH);
}

function drawLiquid(t) {
  if (!t.liquid) return;
  const ly = t.liquid.y, now = Date.now();
  const wave = (x, amp, sp) => ly + Math.sin(x * 0.02 + now / sp) * amp;
  ctx.beginPath();
  ctx.moveTo(0, t.worldH);
  for (let x = 0; x <= t.worldW; x += 16) ctx.lineTo(x, wave(x, 4, 400));
  ctx.lineTo(t.worldW, t.worldH);
  ctx.closePath();
  if (t.liquid.type === 'lava') {
    const g = ctx.createLinearGradient(0, ly, 0, t.worldH);
    g.addColorStop(0, '#ff6a10'); g.addColorStop(0.3, '#d2380a'); g.addColorStop(1, '#6e1200');
    ctx.fillStyle = g;
    ctx.fill();
    for (let i = 0; i < 10; i++) {
      const lx = ((i / 10 + now / 40000) % 1) * t.worldW;
      const lg = ctx.createRadialGradient(lx, ly + 15, 0, lx, ly + 15, 110);
      lg.addColorStop(0, 'rgba(255,200,60,0.45)'); lg.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(lx - 110, ly - 10, 220, 120);
    }
    ctx.strokeStyle = '#ffc050';
  } else {
    ctx.fillStyle = 'rgba(64,132,168,0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(220,245,255,0.8)';
  }
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = 0; x <= t.worldW; x += 16) ctx.lineTo(x, wave(x, 4, 400));
  ctx.stroke();
}

function drawPlayer(p) {
  const x = p.x;
  const y = p.y;    // y is the feet position (on terrain)
  const isCurrent = p.id === room.currentPlayerId;
  const alive = p.hp > 0;

  ctx.globalAlpha = alive ? 1 : 0.3;

  const cy = y - PLAYER_H / 2;

  // Shadow ellipse on ground
  ctx.beginPath();
  ctx.ellipse(x, y - 1, 18, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();

  // Team colour disc under the feet
  ctx.beginPath();
  ctx.ellipse(x, y, 14, 3.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = p.color;
  ctx.fill();

  const img = CHAR_SPRITES[p.charIndex] || CHAR_SPRITES[0];
  if (img.complete && img.naturalWidth) {
    const h = PLAYER_H;
    const w = h * img.naturalWidth / img.naturalHeight;
    ctx.save();
    ctx.translate(x, y);
    if ((p.facing || 1) < 0) ctx.scale(-1, 1);
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(x, cy, 18, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }

  // Current turn ring + arrow
  const top = y - PLAYER_H;
  if (isCurrent && alive) {
    // Bobbing arrow above
    const bob = Math.sin(Date.now() / 300) * 3;
    ctx.beginPath();
    ctx.moveTo(x, top - 26 - bob);
    ctx.lineTo(x - 7, top - 36 - bob);
    ctx.lineTo(x + 7, top - 36 - bob);
    ctx.closePath();
    ctx.fillStyle = '#f0d080';
    ctx.fill();
  }

  // Name
  ctx.font = 'bold 12px Georgia';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText(p.name, x, top - 10);
  ctx.fillStyle = p.color;
  ctx.fillText(p.name, x, top - 10);

  // HP bar — the lost chunk drains away after a hit
  if (p.hpShown === undefined || p.hpShown < p.hp) p.hpShown = p.hp;
  p.hpShown += (p.hp - p.hpShown) * 0.04;
  ctx.fillStyle = '#222';
  ctx.fillRect(x - 20, top - 8, 40, 5);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x - 20, top - 8, 40 * p.hpShown / 100, 5);
  ctx.fillStyle = hpColor(p.hp);
  ctx.fillRect(x - 20, top - 8, 40 * p.hp / 100, 5);

  ctx.globalAlpha = 1;
}

function drawAimIndicator(me) {
  // Draw a dotted trajectory arc from player centre toward mouse
  const startX = me.x;
  const startY = me.y - PLAYER_H / 2;

  // Arrow from player to mouse showing direction
  const dx = mouseWorld.x - startX;
  const dy = mouseWorld.y - startY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 5) return;

  const angleRad = aimAngle * Math.PI / 180;

  // Simulated arc (dotted) using same physics as server
  const sp = room.spells?.[selectedSpell] || { speed: 1, gravity: 1 };
  const phys = room.physics || { gravity: 900, speedPerPower: 12 };
  const speed = aimPower * phys.speedPerPower * sp.speed;
  const GRAVITY = phys.gravity * sp.gravity;
  const dt = 1 / 60;
  let px = startX, py = startY;
  let vx = Math.cos(angleRad) * speed;
  let vy = Math.sin(angleRad) * speed;
  const { worldW, worldH } = room.terrain;

  // Simulate the flight, collecting a dot every few frames
  const dots = [];
  let land = null;
  for (let i = 0; i < 360; i++) {
    vy += GRAVITY * dt;
    px += vx * dt;
    py += vy * dt;
    if (i % 4 === 3) dots.push([px, py]);
    if (Terrain.isSolid(room.terrain, px, py) || (room.terrain.liquid && py >= room.terrain.liquid.y) ||
        px < 0 || px > worldW || py > worldH) { land = [px, py]; break; }
  }

  // Dots: white with a dark rim so they show on any background, fading with distance
  dots.forEach(([x, y], k) => {
    ctx.globalAlpha = Math.max(0.35, 1 - k / dots.length * 0.6);
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff8e0';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(40,20,0,0.85)';
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  if (land) {
    const [lx, ly] = land;
    ctx.lineCap = 'round';
    for (const [w, c] of [[6, 'rgba(40,0,0,0.85)'], [3, '#ff4a3a']]) {
      ctx.beginPath();
      ctx.moveTo(lx - 8, ly - 8); ctx.lineTo(lx + 8, ly + 8);
      ctx.moveTo(lx + 8, ly - 8); ctx.lineTo(lx - 8, ly + 8);
      ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // Power ring around player — bigger ring = more power
  const ringR = 30 + aimPower * 0.6;
  ctx.beginPath();
  ctx.arc(startX, startY, ringR, angleRad - 0.3, angleRad + 0.3);
  ctx.strokeStyle = `rgba(255,180,40,${0.3 + aimPower / 200})`;
  ctx.lineWidth = 3;
  ctx.stroke();
}

// Energy gathering at the caster's hands: a tightening ring plus motes drawn inward
function drawCasting(c) {
  const p = room.players.find(p => p.id === c.id);
  if (!p) return;
  const k = Math.min(1, (Date.now() - c.t0) / 600);
  const col = spellColor(c.spell);
  const hx = p.x + (p.facing || 1) * 14, hy = p.y - PLAYER_H * 0.55;
  const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, 10 + 22 * k);
  glow.addColorStop(0, col);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.5 + 0.5 * k;
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(hx, hy, 10 + 22 * k, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(hx, hy, 40 * (1 - k) + 6, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2 + k * 3, r = 46 * (1 - k) + 4;
    ctx.beginPath(); ctx.arc(hx + Math.cos(a) * r, hy + Math.sin(a) * r, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function spellColor(spell) {
  return room?.spells?.[spell]?.color || '#ffffff';
}

function drawBlast(a) {
  const col = spellColor(a.spell);
  const t = Math.min(1, (Date.now() - a.blastStart) / 500);   // 0 → 1 over the blast
  const r = a.radius * (0.5 + 0.7 * t);

  if (a.spell === 'thunder_strike') {
    // Jagged bolt from the sky down to the impact point
    ctx.beginPath();
    let bx = a.landX, by = a.landY - 700;
    ctx.moveTo(bx, by);
    while (by < a.landY) {
      by = Math.min(a.landY, by + 40 + Math.random() * 30);
      bx = a.landX + (by < a.landY ? (Math.random() - 0.5) * 50 : 0);
      ctx.lineTo(bx, by);
    }
    ctx.strokeStyle = `rgba(255,250,200,${1 - t})`;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,224,64,${0.6 * (1 - t)})`;
    ctx.lineWidth = 14;
    ctx.stroke();
  }

  if (a.spell === 'tidal_wave' || a.spell === 'wind_slash') {
    // Expanding shockwave ring
    ctx.beginPath();
    ctx.ellipse(a.landX, a.landY, r, r * 0.45, 0, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.globalAlpha = 1 - t;
    ctx.lineWidth = 8 * (1 - t) + 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const g = ctx.createRadialGradient(a.landX, a.landY, 0, a.landX, a.landY, r);
  g.addColorStop(0, `rgba(255,255,230,${0.9 * (1 - t)})`);
  g.addColorStop(0.35, col);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 1 - t * 0.7;
  ctx.beginPath();
  ctx.arc(a.landX, a.landY, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawProjectile(x, y, spell) {
  const col = spellColor(spell);

  // Glow
  const g = ctx.createRadialGradient(x, y, 0, x, y, 20);
  g.addColorStop(0, col);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.arc(x, y, 20, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  // Core dot
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

// ── Projectile animation ──────────────────────────────────────────────────────
function animateProjectile() {
  if (!projAnim) return;
  projAnim.idx += 2; // step 2 path points per frame for speed
  render();
  if (projAnim.idx < projAnim.path.length) {
    requestAnimationFrame(animateProjectile);
  } else {
    projAnim.showBlast = true;
    projAnim.blastStart = Date.now();
    projAnim.apply();
    render();
    setTimeout(() => {
      if (projAnim) { projAnim.onDone(); }
    }, 500);
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function updateLobbyList() {
  if (!room) return;
  playerList.textContent = room.players.map(p => p.name).join(' · ');
  if (room.players[0]?.id === myId && room.players.length >= 2) {
    startBtn.style.display = 'block';
  }
}

function updateTurnInfo() {
  if (!room) return;
  const cp = room.players.find(p => p.id === room.currentPlayerId);
  const isYou = room.currentPlayerId === myId;
  turnInfo.textContent = cp
    ? (isYou ? `⚔ YOUR TURN — ${cp.name}` : `${cp.name}'s turn…`)
    : 'Waiting…';
}

function renderHpBars() {
  if (!room) return;
  hpBarsEl.innerHTML = room.players.map(p => `
    <div class="hp-entry">
      <span style="color:${p.color}">${p.name}</span>
      <div class="hp-bar-bg">
        <div class="hp-bar-fill" style="width:${p.hp}%;background:${hpColor(p.hp)}"></div>
      </div>
      <span style="color:#808080;font-size:0.75rem">${p.hp}hp</span>
    </div>
  `).join('');
}

function hpColor(hp) {
  if (hp > 60) return '#2ecc71';
  if (hp > 30) return '#f39c12';
  return '#e74c3c';
}

function log(msg) {
  const d = document.createElement('div');
  d.className = 'log-line';
  d.textContent = msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}
