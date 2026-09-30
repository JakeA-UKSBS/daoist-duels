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
  if (room.players[0]?.id === myId) startBtn.style.display = 'block';
  log(`Joined room "${r.id}" — share this code with friends!`);
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

socket.on('player_aimed', ({ id, angle, power }) => {
  const p = room?.players.find(p => p.id === id);
  if (p) { p.angle = angle; p.power = power; }
  render();
});

socket.on('projectile_result', ({ path, landX, landY, spell, radius, terrain, players }) => {
  if (room) {
    room.terrain = terrain;
    players.forEach(({ id, hp }) => {
      const p = room.players.find(p => p.id === id);
      if (p) p.hp = hp;
    });
    // After explosion, snap all players to new terrain surface
    room.players.forEach(p => {
      p.y = terrainYAt(p.x) - 1;
    });
  }
  projAnim = { path, idx: 0, landX, landY, spell, radius, onDone: () => { projAnim = null; renderHpBars(); render(); } };
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
  const dy = mouseWorld.y - (me.y - 20); // aim from centre of player
  aimAngle = Math.atan2(dy, dx) * 180 / Math.PI;

  // Clamp: can't aim straight down or behind — keep to front hemisphere
  // (server will use facing to determine actual vx direction)
  // Power: distance mapped 50–400px → 10–100
  const dist = Math.sqrt(dx * dx + dy * dy);
  aimPower = Math.round(Math.max(10, Math.min(100, (dist / 400) * 100)));

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
  cam.x = Math.max(0, Math.min(Math.max(0, worldW - vw), cam.x));
  cam.y = Math.max(0, Math.min(Math.max(0, worldH - vh), cam.y));
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

  drawTerrain(worldW, worldH, heights, segments);

  room.players.forEach(p => drawPlayer(p));

  // Aim indicator — dotted arc from current player outward to mouse
  if (isMyTurn() && !projAnim) {
    const me = myPlayer();
    if (me) drawAimIndicator(me);
  }

  // Projectile
  if (projAnim) {
    const pt = projAnim.path[Math.min(projAnim.idx, projAnim.path.length - 1)];
    if (pt) drawProjectile(pt.x, pt.y, projAnim.spell);
  }

  // Explosion flash
  if (projAnim && projAnim.showBlast) {
    const g = ctx.createRadialGradient(projAnim.landX, projAnim.landY, 0, projAnim.landX, projAnim.landY, projAnim.radius * 1.5);
    g.addColorStop(0, 'rgba(255,220,80,0.9)');
    g.addColorStop(0.4, 'rgba(255,100,20,0.6)');
    g.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.beginPath();
    ctx.arc(projAnim.landX, projAnim.landY, projAnim.radius * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }

  ctx.restore();

  // HUD overlay: controls hint
  if (isMyTurn() && !projAnim) {
    ctx.fillStyle = 'rgba(240,208,128,0.7)';
    ctx.font = '13px Georgia';
    ctx.textAlign = 'left';
    ctx.fillText('A/D or ←/→ to walk  ·  Move mouse to aim  ·  Click to fire', 12, canvas.height - 12);
  }
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

  // Body (centred at y-20 above feet)
  const cy = y - 22;

  // Shadow ellipse on ground
  ctx.beginPath();
  ctx.ellipse(x, y - 2, 16, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();

  // Body circle
  ctx.beginPath();
  ctx.arc(x, cy, 18, 0, Math.PI * 2);
  ctx.fillStyle = p.color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Initial
  ctx.fillStyle = '#fff';
  ctx.font = `bold 15px Georgia`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((p.name[0] || '?').toUpperCase(), x, cy);

  // Current turn ring + arrow
  if (isCurrent && alive) {
    ctx.beginPath();
    ctx.arc(x, cy, 24, 0, Math.PI * 2);
    ctx.strokeStyle = '#f0d080';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Bobbing arrow above
    const bob = Math.sin(Date.now() / 300) * 3;
    ctx.beginPath();
    ctx.moveTo(x, cy - 38 - bob);
    ctx.lineTo(x - 7, cy - 28 - bob);
    ctx.lineTo(x + 7, cy - 28 - bob);
    ctx.closePath();
    ctx.fillStyle = '#f0d080';
    ctx.fill();
  }

  // Name
  ctx.font = '11px Georgia';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = isCurrent ? '#f0d080' : '#b0a060';
  ctx.fillText(p.name, x, cy - 26);

  // HP bar
  ctx.fillStyle = '#222';
  ctx.fillRect(x - 20, cy - 38, 40, 5);
  ctx.fillStyle = hpColor(p.hp);
  ctx.fillRect(x - 20, cy - 38, 40 * p.hp / 100, 5);

  ctx.globalAlpha = 1;
}

function drawAimIndicator(me) {
  // Draw a dotted trajectory arc from player centre toward mouse
  const startX = me.x;
  const startY = me.y - 22;

  // Arrow from player to mouse showing direction
  const dx = mouseWorld.x - startX;
  const dy = mouseWorld.y - startY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 5) return;

  const angleRad = aimAngle * Math.PI / 180;

  // Simulated arc (dotted) using same physics as server
  const speed = aimPower * 12;
  const GRAVITY = 600;
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

function drawProjectile(x, y, spell) {
  const colours = {
    dragon_blast:   '#ff6020',
    tidal_wave:     '#40a0ff',
    thunder_strike: '#ffe040',
    wind_slash:     '#80ffa0',
  };
  const col = colours[spell] || '#ffffff';

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
