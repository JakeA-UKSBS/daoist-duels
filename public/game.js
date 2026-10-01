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
const PLAYER_H = 64;   // sprite height in world px; body centre is PLAYER_H/2 above feet
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

socket.on('player_aimed', ({ id, angle, power }) => {
  const p = room?.players.find(p => p.id === id);
  if (p) { p.angle = angle; p.power = power; }
  render();
});

socket.on('projectile_result', ({ path, landX, landY, spell, radius, hits, fallen, terrain, players }) => {
  stopMoving();
  // Apply the result only once the projectile lands, so the crater/knockback
  // appear with the explosion rather than before it
  const apply = () => {
    if (!room) return;
    room.terrain = terrain;
    players.forEach(u => {
      const p = room.players.find(p => p.id === u.id);
      if (p) Object.assign(p, u);
    });
    const label = room.spells?.[spell]?.label || spell;
    if (hits?.length) hits.forEach(h => log(`${label} hits ${h.name} for ${h.dmg}`));
    else log(`${label} misses`);
    (fallen || []).forEach(n => log(`${n} fell into the abyss!`));
    renderHpBars();
  };
  projAnim = { path, idx: 0, landX, landY, spell, radius, apply, onDone: () => { projAnim = null; render(); } };
  animateProjectile();
});

socket.on('turn_changed', ({ currentPlayerId }) => {
  if (room) room.currentPlayerId = currentPlayerId;
  updateTurnInfo();
  centreOnMe();
  render();
});

socket.on('game_over', ({ winner }) => {
  const msg = winner ? `${winner.name} wins the duel! 🏆` : 'The battle ends in a draw.';
  document.getElementById('gameover-msg').textContent = msg;
  gameoverEl.style.display = 'flex';
  log(msg);
});

socket.on('error', (msg) => alert(msg));

// ── Enter game ────────────────────────────────────────────────────────────────
function enterGame() {
  lobbyEl.style.display = 'none';
  gameEl.style.display = 'block';
  hudEl.style.display = 'flex';
  hpBarsEl.style.display = 'flex';
  logEl.style.display = 'block';
  centreOnMe();
  updateTurnInfo();
  renderHpBars();
  render();
  requestAnimationFrame(gameLoop);
}

// ── Game loop ─────────────────────────────────────────────────────────────────
let lastTime = 0;
function gameLoop(ts) {
  lastTime = ts;
  render();
  requestAnimationFrame(gameLoop);
}

// ── Keyboard movement ─────────────────────────────────────────────────────────
// Held keys send repeated move events — feels smooth like Worms
window.addEventListener('keydown', e => {
  if (keys[e.key]) return; // already held
  keys[e.key] = true;

  if (!isMyTurn() || projAnim) return;

  if (e.key === 'ArrowLeft'  || e.key === 'a') startMoving(-1);
  if (e.key === 'ArrowRight' || e.key === 'd') startMoving(1);
  if (e.key === ' ') { e.preventDefault(); fireSpell(); }
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
  const speed = 10;
  me.x = Math.max(20, Math.min(room.terrain.worldW - 20, me.x + dir * speed));
  me.y = terrainYAt(me.x) - 1;
  me.facing = dir;

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
  aimPower = Math.round(Math.max(10, Math.min(100, (dist / 400) * 100)));
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
  if (!isMyTurn() || projAnim) return;
  socket.emit('fire', { spell: selectedSpell, angle: aimAngle, power: aimPower });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isMyTurn() {
  return room?.phase === 'playing' && room?.currentPlayerId === myId;
}
function myPlayer() {
  return room?.players.find(p => p.id === myId);
}

function terrainYAt(x) {
  if (!room) return 0;
  const { heights, segments, worldW } = room.terrain;
  const t = Math.max(0, Math.min(1, x / worldW));
  const fi = t * segments;
  const i = Math.floor(fi);
  const frac = fi - i;
  const h0 = heights[Math.min(i, segments)];
  const h1 = heights[Math.min(i + 1, segments)];
  return h0 + (h1 - h0) * frac;
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
  const { worldW, worldH, heights, segments } = room.terrain;

  ctx.save();
  ctx.clearRect(0, 0, W, H);

  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0d0520');
  sky.addColorStop(0.6, '#2a0d4a');
  sky.addColorStop(1, '#1a0828');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // World transform
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  const bg = bgImage(room.terrain.bg);
  if (bg) {
    ctx.drawImage(bg, 0, 0, worldW, worldH);
    drawCraters(worldW, worldH, heights, segments, room.terrain.base);
  } else {
    drawTerrain(worldW, worldH, heights, segments);
  }

  room.players.forEach(p => drawPlayer(p));

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

  // HUD overlay: controls hint
  if (isMyTurn() && !projAnim) {
    ctx.fillStyle = 'rgba(240,208,128,0.7)';
    ctx.font = '13px Georgia';
    ctx.textAlign = 'left';
    ctx.fillText('A/D or ←/→ to walk  ·  Move mouse to aim  ·  Click to fire  ·  Right-drag to pan  ·  Wheel to zoom', 12, canvas.height - 12);
  }
}

// Image maps: the painted ground stays as-is; blasted-out areas are drawn as dark earth
function drawCraters(worldW, worldH, heights, segments, base) {
  if (!base) return;
  const step = worldW / segments;
  ctx.beginPath();
  for (let i = 0; i <= segments; i++) ctx.lineTo(i * step, base[i]);
  for (let i = segments; i >= 0; i--) ctx.lineTo(i * step, heights[i]);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 850, 0, worldH);
  g.addColorStop(0, '#6b5238');
  g.addColorStop(1, '#2a1c10');
  ctx.fillStyle = g;
  ctx.fill();

  // Abyss where the ground has been blasted right through
  for (let i = 0; i < segments; i++) {
    if (heights[i] >= worldH - 4 && heights[i + 1] >= worldH - 4) {
      ctx.fillStyle = '#0a0612';
      ctx.fillRect(i * step, worldH - 30, step + 1, 30);
    }
  }

  // Dark rim along the carved surface
  ctx.beginPath();
  for (let i = 0; i <= segments; i++) {
    const y = heights[i];
    if (y > base[i] + 1) ctx.lineTo(i * step, y); else ctx.moveTo(i * step, y);
  }
  ctx.strokeStyle = '#3d2a18';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawTerrain(worldW, worldH, heights, segments) {
  // Main terrain body
  ctx.beginPath();
  ctx.moveTo(0, heights[0]);
  for (let i = 1; i <= segments; i++) {
    ctx.lineTo((i / segments) * worldW, heights[i]);
  }
  ctx.lineTo(worldW, worldH);
  ctx.lineTo(0, worldH);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, worldH);
  grad.addColorStop(0, '#5a8a38');
  grad.addColorStop(0.15, '#3d6022');
  grad.addColorStop(0.5, '#2a4018');
  grad.addColorStop(1, '#1a2810');
  ctx.fillStyle = grad;
  ctx.fill();

  // Grass edge
  ctx.beginPath();
  ctx.moveTo(0, heights[0]);
  for (let i = 1; i <= segments; i++) {
    ctx.lineTo((i / segments) * worldW, heights[i]);
  }
  ctx.strokeStyle = '#7ec840';
  ctx.lineWidth = 4 / cam.zoom;
  ctx.stroke();

  // Lava
  const lavaY = worldH - 50;
  ctx.fillStyle = '#8b1a00';
  ctx.fillRect(0, lavaY, worldW, 50);
  // Animated lava glow strips
  const t = Date.now() / 800;
  for (let i = 0; i < 8; i++) {
    const lx = ((i / 8 + t * 0.05) % 1) * worldW;
    const lg = ctx.createRadialGradient(lx, lavaY + 10, 0, lx, lavaY + 10, 120);
    lg.addColorStop(0, 'rgba(255,120,0,0.5)');
    lg.addColorStop(1, 'rgba(255,0,0,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(lx - 120, lavaY, 240, 50);
  }
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(0, lavaY, worldW, 8);
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

  // HP bar
  ctx.fillStyle = '#222';
  ctx.fillRect(x - 20, top - 8, 40, 5);
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
  const speed = aimPower * 12 * sp.speed;
  const GRAVITY = 600 * sp.gravity;
  const dt = 1 / 60;
  let px = startX, py = startY;
  let vx = Math.cos(angleRad) * speed;
  let vy = Math.sin(angleRad) * speed;
  const { worldW, worldH } = room.terrain;

  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(255,220,80,0.55)';
  ctx.lineWidth = 1.5;

  for (let i = 0; i < 180; i++) {
    vy += GRAVITY * dt;
    px += vx * dt;
    py += vy * dt;
    if (i % 2 === 0) ctx.lineTo(px, py);
    const ty = terrainYAt(px);
    if (py >= ty || px < 0 || px > worldW || py > worldH) {
      // Draw landing X
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,80,80,0.8)';
      ctx.lineWidth = 2;
      ctx.moveTo(px - 6, py - 6); ctx.lineTo(px + 6, py + 6);
      ctx.moveTo(px + 6, py - 6); ctx.lineTo(px - 6, py + 6);
      ctx.stroke();
      return;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Power ring around player — bigger ring = more power
  const ringR = 30 + aimPower * 0.6;
  ctx.beginPath();
  ctx.arc(startX, startY, ringR, angleRad - 0.3, angleRad + 0.3);
  ctx.strokeStyle = `rgba(255,180,40,${0.3 + aimPower / 200})`;
  ctx.lineWidth = 3;
  ctx.stroke();
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
