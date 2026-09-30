// ─── Wuxia Warriors — client ──────────────────────────────────────────────────
const socket = io();

// ── State ─────────────────────────────────────────────────────────────────────
let myId = null;
let room = null;
let selectedSpell = 'dragon_blast';
let angle = -45;
let power = 50;

// Camera
const cam = { x: 0, y: 0, zoom: 1 };
let dragging = false;
let dragStart = { x: 0, y: 0, camX: 0, camY: 0 };

// Keys held
const keys = {};

// Projectile animation
let projAnim = null;   // { path, idx, landX, landY, spell, radius, onDone }

// ── DOM refs ──────────────────────────────────────────────────────────────────
const lobbyEl    = document.getElementById('lobby');
const gameEl     = document.getElementById('game');
const canvas     = document.getElementById('gameCanvas');
const ctx        = canvas.getContext('2d');
const hudEl      = document.getElementById('hud');
const hpBarsEl   = document.getElementById('hp-bars');
const logEl      = document.getElementById('log');
const aimCtrl    = document.getElementById('aim-controls');
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
document.getElementById('join-btn').addEventListener('click', () => {
  const name = document.getElementById('name-input').value.trim() || 'Warrior';
  const roomId = document.getElementById('room-input').value.trim() || 'default';
  socket.emit('join_room', { roomId, name });
});

startBtn.addEventListener('click', () => socket.emit('start_game'));

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('joined', ({ playerId, room: r }) => {
  myId = playerId;
  room = r;
  updateLobbyList();
  // Show start button only for the room host (first player)
  if (room.players[0]?.id === myId) startBtn.style.display = 'block';
  log(`Joined room "${r.id}" — share the room code with friends!`);
});

socket.on('player_joined', ({ player }) => {
  if (!room) return;
  room.players.push(player);
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

socket.on('player_moved', ({ id, x, y, facing }) => {
  const p = room?.players.find(p => p.id === id);
  if (p) { p.x = x; p.y = y; p.facing = facing; }
  render();
});

socket.on('player_aimed', ({ id, angle: a, power: pw }) => {
  const p = room?.players.find(p => p.id === id);
  if (p) { p.angle = a; p.power = pw; }
  render();
});

socket.on('projectile_result', ({ path, landX, landY, spell, radius, terrain, players }) => {
  // Update terrain & HP
  if (room) {
    room.terrain = terrain;
    players.forEach(({ id, hp }) => {
      const p = room.players.find(p => p.id === id);
      if (p) p.hp = hp;
    });
  }
  // Animate projectile
  projAnim = { path, idx: 0, landX, landY, spell, radius, onDone: () => { projAnim = null; renderHpBars(); } };
  animateProjectile();
});

socket.on('turn_changed', ({ currentPlayerId }) => {
  if (room) room.currentPlayerId = currentPlayerId;
  updateTurnInfo();
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
  aimCtrl.style.display = room.players.some(p => p.id === myId) ? 'flex' : 'none';

  // Centre camera on current player
  centreOnMe();
  updateTurnInfo();
  renderHpBars();
  render();
  requestAnimationFrame(gameLoop);
}

// ── Game loop ─────────────────────────────────────────────────────────────────
let lastTime = 0;
function gameLoop(ts) {
  const dt = Math.min((ts - lastTime) / 1000, 0.05);
  lastTime = ts;
  handleKeys(dt);
  render();
  requestAnimationFrame(gameLoop);
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  keys[e.key] = true;
  // Aim shortcuts
  if (isMyTurn()) {
    if (e.key === 'ArrowLeft' || e.key === 'a') socket.emit('move', { direction: -1 });
    if (e.key === 'ArrowRight' || e.key === 'd') socket.emit('move', { direction: 1 });
    if (e.key === ' ') { e.preventDefault(); fireSpell(); }
  }
});
window.addEventListener('keyup', e => { keys[e.key] = false; });

function handleKeys(dt) {
  // nothing extra needed — moves are event-driven
}

// ── Aim controls ──────────────────────────────────────────────────────────────
const angleRange = document.getElementById('angle-range');
const powerRange = document.getElementById('power-range');

angleRange.addEventListener('input', () => {
  angle = parseInt(angleRange.value);
  syncAim();
});
powerRange.addEventListener('input', () => {
  power = parseInt(powerRange.value);
  syncAim();
});

function syncAim() {
  powerDisp.textContent = `Power: ${power} | Angle: ${angle}°`;
  if (isMyTurn()) socket.emit('aim', { angle, power });
  render();
}

document.getElementById('fire-btn').addEventListener('click', fireSpell);

// Spell bar
document.querySelectorAll('.spell-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.spell-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedSpell = btn.dataset.spell;
  });
});

function fireSpell() {
  if (!isMyTurn() || projAnim) return;
  socket.emit('fire', { spell: selectedSpell });
}

function isMyTurn() {
  return room?.phase === 'playing' && room?.currentPlayerId === myId;
}

// ── Camera ────────────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
  dragging = true;
  dragStart = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y };
});
canvas.addEventListener('mousemove', e => {
  if (!dragging) return;
  cam.x = dragStart.camX - (e.clientX - dragStart.x) / cam.zoom;
  cam.y = dragStart.camY - (e.clientY - dragStart.y) / cam.zoom;
  clampCamera();
  render();
});
canvas.addEventListener('mouseup', () => { dragging = false; });
canvas.addEventListener('wheel', e => {
  const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
  cam.zoom = Math.max(0.3, Math.min(2, cam.zoom * zoomFactor));
  clampCamera();
  render();
}, { passive: true });

function clampCamera() {
  if (!room) return;
  const { worldW, worldH } = room.terrain;
  const vw = canvas.width / cam.zoom;
  const vh = canvas.height / cam.zoom;
  cam.x = Math.max(0, Math.min(worldW - vw, cam.x));
  cam.y = Math.max(0, Math.min(worldH - vh, cam.y));
}

function centreOnMe() {
  const me = room?.players.find(p => p.id === myId);
  if (!me) return;
  cam.x = me.x - canvas.width / cam.zoom / 2;
  cam.y = me.y - canvas.height / cam.zoom / 2;
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
  sky.addColorStop(0, '#1a0a2e');
  sky.addColorStop(1, '#3a1060');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Transform: world → screen
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  // Terrain
  drawTerrain(ctx, worldW, worldH, heights, segments);

  // Players
  room.players.forEach((p, i) => drawPlayer(ctx, p, i));

  // Aim line for current player (only if it's you)
  if (isMyTurn() && !projAnim) {
    const me = room.players.find(p => p.id === myId);
    if (me) drawAimLine(ctx, me);
  }

  // Projectile animation dot
  if (projAnim) {
    const pt = projAnim.path[projAnim.idx] || { x: projAnim.landX, y: projAnim.landY };
    drawProjectile(ctx, pt.x, pt.y, projAnim.spell);
  }

  // Explosion flash
  if (projAnim && projAnim.idx >= projAnim.path.length) {
    ctx.beginPath();
    ctx.arc(projAnim.landX, projAnim.landY, projAnim.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,160,40,0.35)';
    ctx.fill();
  }

  ctx.restore();
}

function drawTerrain(ctx, worldW, worldH, heights, segments) {
  // Terrain fill
  ctx.beginPath();
  ctx.moveTo(0, heights[0]);
  for (let i = 1; i <= segments; i++) {
    ctx.lineTo((i / segments) * worldW, heights[i]);
  }
  ctx.lineTo(worldW, worldH);
  ctx.lineTo(0, worldH);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, worldH);
  grad.addColorStop(0, '#4a7a30');
  grad.addColorStop(0.2, '#3a5a20');
  grad.addColorStop(1, '#2a3a15');
  ctx.fillStyle = grad;
  ctx.fill();

  // Terrain top edge
  ctx.beginPath();
  ctx.moveTo(0, heights[0]);
  for (let i = 1; i <= segments; i++) {
    ctx.lineTo((i / segments) * worldW, heights[i]);
  }
  ctx.strokeStyle = '#80c840';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Lava at bottom
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(0, worldH - 40, worldW, 40);
  ctx.fillStyle = '#e74c3c';
  ctx.fillRect(0, worldH - 20, worldW, 20);
}

function drawPlayer(ctx, p, idx) {
  const x = p.x, y = p.y;
  const isMe = p.id === myId;
  const isCurrent = p.id === room.currentPlayerId;
  const alive = p.hp > 0;

  ctx.globalAlpha = alive ? 1 : 0.4;

  // Shadow
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 18, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();

  // Body circle
  ctx.beginPath();
  ctx.arc(x, y - 20, 18, 0, Math.PI * 2);
  ctx.fillStyle = p.color;
  ctx.fill();
  ctx.strokeStyle = '#ffffff44';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Character initial
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px Georgia';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.name[0]?.toUpperCase() || '?', x, y - 20);

  // Current turn indicator
  if (isCurrent) {
    ctx.beginPath();
    ctx.arc(x, y - 20, 24, 0, Math.PI * 2);
    ctx.strokeStyle = '#f0d080';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrow above
    ctx.beginPath();
    ctx.moveTo(x, y - 54);
    ctx.lineTo(x - 6, y - 44);
    ctx.lineTo(x + 6, y - 44);
    ctx.closePath();
    ctx.fillStyle = '#f0d080';
    ctx.fill();
  }

  // Name tag
  ctx.font = '11px Georgia';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = isCurrent ? '#f0d080' : '#c0b080';
  ctx.fillText(p.name, x, y - 46);

  // Mini HP bar
  ctx.fillStyle = '#333';
  ctx.fillRect(x - 20, y - 38, 40, 4);
  ctx.fillStyle = hpColor(p.hp);
  ctx.fillRect(x - 20, y - 38, 40 * p.hp / 100, 4);

  ctx.globalAlpha = 1;
}

function drawAimLine(ctx, p) {
  const angleRad = (angle * Math.PI) / 180;
  const speed = power * 12;
  const GRAVITY = 600;
  const dt = 1 / 60;
  let x = p.x, y = p.y - 30;
  let vx = Math.cos(angleRad) * speed * p.facing;
  let vy = Math.sin(angleRad) * speed;

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(255,220,100,0.5)';
  ctx.lineWidth = 1.5;

  for (let i = 0; i < 120; i++) {
    vy += GRAVITY * dt;
    x += vx * dt;
    y += vy * dt;
    if (i % 3 === 0) ctx.lineTo(x, y);
    const { worldW, worldH, heights, segments } = room.terrain;
    const t = Math.max(0, Math.min(1, x / worldW));
    const fi = t * segments;
    const si = Math.floor(fi);
    const frac = fi - si;
    const terrainY = heights[Math.min(si, segments)] + (heights[Math.min(si + 1, segments)] - heights[Math.min(si, segments)]) * frac;
    if (y >= terrainY || x < 0 || x > worldW || y > worldH) break;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawProjectile(ctx, x, y, spell) {
  const colours = {
    dragon_blast:   '#ff6020',
    tidal_wave:     '#2080ff',
    thunder_strike: '#ffe040',
    wind_slash:     '#80ffa0',
  };
  const col = colours[spell] || '#ffffff';

  // Glow
  const g = ctx.createRadialGradient(x, y, 0, x, y, 16);
  g.addColorStop(0, col);
  g.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(x, y, 16, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  // Core
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
}

// ── Projectile animation ──────────────────────────────────────────────────────
function animateProjectile() {
  if (!projAnim) return;
  projAnim.idx++;
  render();
  if (projAnim.idx < projAnim.path.length) {
    requestAnimationFrame(animateProjectile);
  } else {
    // Show explosion for a moment then finish
    render();
    setTimeout(() => { projAnim?.onDone?.(); projAnim = null; render(); }, 600);
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
  // Show/hide aim controls
  if (aimCtrl.style.display !== 'none') {
    aimCtrl.style.opacity = isYou ? '1' : '0.4';
    aimCtrl.style.pointerEvents = isYou ? 'auto' : 'none';
  }
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
