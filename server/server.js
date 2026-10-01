const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// ─── Game constants ───────────────────────────────────────────────────────────
const GRAVITY  = 600;   // px / s²
const MAX_PLAYERS = 6;
const SEGMENTS = 192;   // terrain resolution
const PLAYER_H = 64;    // sprite height; body centre is PLAYER_H/2 above feet

// ─── Maps ─────────────────────────────────────────────────────────────────────
// profile = ground line sampled from the background art (65 evenly spaced points)
const MAPS = {
  jade_mountain: {
    name: 'Jade Mountain',
    bg: '/assets/maps/jade_mountain.jpg',
    worldW: 1920, worldH: 1060,
    profile: [876,876,876,876,876,876,876,876,877,876,877,876,899,910,923,933,941,943,947,949,952,959,966,968,968,967,966,964,962,958,954,949,940,934,932,939,941,940,934,942,942,942,942,942,942,942,942,942,942,942,941,941,942,942,942,942,942,940,940,942,942,942,942,941,942],
  },
  crimson_peaks: {
    name: 'Crimson Peaks',
    bg: null,
    worldW: 2560, worldH: 1440,
    profile: Array.from({ length: 65 }, (_, i) => {
      const t = i / 64;
      return Math.floor((0.55 + 0.12 * Math.sin(t * Math.PI * 3) + 0.05 * Math.sin(t * Math.PI * 7)) * 1440);
    }),
  },
};

// ─── Spells ───────────────────────────────────────────────────────────────────
// gravity/speed are multipliers; carve = how deep the crater is; knockback in px
const SPELLS = {
  dragon_blast:   { label: 'Dragon Blast',   color: '#ff6020', radius: 90,  damage: 40, gravity: 1.0,  speed: 1.0, carve: 0.8, knockback: 40 },
  tidal_wave:     { label: 'Tidal Wave',     color: '#40a0ff', radius: 130, damage: 25, gravity: 1.5,  speed: 1.15, carve: 0.3, knockback: 140 },
  thunder_strike: { label: 'Thunder Strike', color: '#ffe040', radius: 45,  damage: 35, gravity: 0.15, speed: 1.4, carve: 0.4, knockback: 0 },
  wind_slash:     { label: 'Wind Slash',     color: '#80ffa0', radius: 60,  damage: 20, gravity: 0.45, speed: 0.9, carve: 0.2, knockback: 220 },
};

// ─── Game state ───────────────────────────────────────────────────────────────
const rooms = {};   // roomId → GameRoom

class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = [];   // [{ id, name, x, y, hp, facing, color, charIndex }]
    this.currentTurn = 0;
    this.phase = 'lobby';   // lobby | playing | over
    this.setMap('jade_mountain');
  }

  setMap(key) {
    const map = MAPS[key] || MAPS.jade_mountain;
    this.mapKey = MAPS[key] ? key : 'jade_mountain';
    const { profile, worldW, worldH } = map;
    const heights = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const f = (i / SEGMENTS) * (profile.length - 1);
      const j = Math.floor(f), fr = f - j;
      const a = profile[j], b = profile[Math.min(j + 1, profile.length - 1)];
      heights.push(a + (b - a) * fr);
    }
    this.terrain = {
      type: 'heightmap', map: this.mapKey, name: map.name, bg: map.bg,
      heights, base: heights.slice(), segments: SEGMENTS, worldW, worldH,
    };
    this.spreadPlayers();
  }

  spreadPlayers() {
    const { worldW } = this.terrain;
    const n = this.players.length;
    this.players.forEach((p, i) => {
      p.x = n <= 1 ? worldW / 2 : 150 + (worldW - 300) * i / (n - 1);
      p.y = this.terrainYAt(p.x) - 1;
      p.facing = p.x < worldW / 2 ? 1 : -1;
    });
  }

  addPlayer(socketId, name, charIndex) {
    if (this.players.length >= MAX_PLAYERS) return null;
    const idx = this.players.length;
    const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];
    const player = {
      id: socketId,
      name,
      x: 0, y: 0,
      hp: 100,
      facing: 1,
      color: colors[idx],
      charIndex: Number.isInteger(charIndex) && charIndex >= 0 && charIndex < 4 ? charIndex : idx % 4,
      angle: -45,
      power: 50,
    };
    this.players.push(player);
    this.spreadPlayers();
    return player;
  }

  terrainYAt(x) {
    const { heights, segments, worldW } = this.terrain;
    const t = Math.max(0, Math.min(1, x / worldW));
    const fi = t * segments;
    const i = Math.floor(fi);
    const frac = fi - i;
    const h0 = heights[Math.min(i, segments)];
    const h1 = heights[Math.min(i + 1, segments)];
    return h0 + (h1 - h0) * frac;
  }

  // Players standing over a hole dug to the bottom of the world fall into the abyss
  checkFalls() {
    const fallen = [];
    this.players.forEach(p => {
      if (p.hp <= 0) return;
      p.y = this.terrainYAt(p.x) - 1;
      if (p.y >= this.terrain.worldH - 4) { p.hp = 0; fallen.push(p.name); }
    });
    return fallen;
  }

  currentPlayer() {
    const alive = this.players.filter(p => p.hp > 0);
    if (!alive.length) return null;
    return alive[this.currentTurn % alive.length];
  }

  advanceTurn() {
    const alive = this.players.filter(p => p.hp > 0);
    if (alive.length <= 1) {
      this.phase = 'over';
      return;
    }
    this.currentTurn = (this.currentTurn + 1) % alive.length;
  }

  applyExplosion(x, y, spell) {
    const { radius, damage, carve, knockback } = spell;
    const { heights, segments, worldW, worldH } = this.terrain;

    // Carve terrain heightmap
    for (let i = 0; i <= segments; i++) {
      const dx = (i / segments) * worldW - x;
      if (Math.abs(dx) < radius) {
        const depth = Math.sqrt(radius * radius - dx * dx) * carve;
        // only carve if the blast actually reaches the surface here
        if (y + depth > heights[i]) heights[i] = Math.min(worldH, Math.max(heights[i], y + depth));
      }
    }

    // Damage + knockback, measured from each player's body centre
    const hits = [];
    this.players.forEach(p => {
      if (p.hp <= 0) return;
      const dx = p.x - x;
      const dy = (p.y - PLAYER_H / 2) - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < radius) {
        const falloff = 1 - dist / radius;
        const dmg = Math.round(damage * (0.4 + 0.6 * falloff));
        p.hp = Math.max(0, p.hp - dmg);
        if (knockback) {
          const dir = dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dx);
          p.x = Math.max(20, Math.min(worldW - 20, p.x + dir * knockback * (0.3 + 0.7 * falloff)));
        }
        hits.push({ name: p.name, dmg });
      }
    });
    return hits;
  }
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('join_room', ({ roomId, name, charIndex }) => {
    if (!rooms[roomId]) rooms[roomId] = new GameRoom(roomId);
    const room = rooms[roomId];
    if (room.phase !== 'lobby') {
      socket.emit('error', 'That battle has already started');
      return;
    }

    const player = room.addPlayer(socket.id, String(name).slice(0, 20), Number(charIndex));
    if (!player) {
      socket.emit('error', 'Room is full');
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;

    // Send full state to the joiner
    socket.emit('joined', {
      playerId: socket.id,
      room: roomStateFor(room),
    });

    // Tell everyone else
    socket.to(roomId).emit('player_joined', { player, players: room.players });
  });

  socket.on('add_bot', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'lobby' || room.players[0]?.id !== socket.id) return;
    const n = room.players.filter(p => p.isBot).length + 1;
    const names = ['Master Lin', 'Elder Zhao', 'Abbot Wu', 'Hermit Qing', 'Sister Mei'];
    const bot = room.addPlayer(`bot-${room.id}-${n}`, names[(n - 1) % names.length], Math.floor(Math.random() * 4));
    if (!bot) return socket.emit('error', 'Room is full');
    bot.isBot = true;
    io.to(room.id).emit('player_joined', { player: bot, players: room.players });
  });

  socket.on('start_game', ({ map } = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.players[0]?.id !== socket.id) return;
    if (room.players.length < 2) {
      socket.emit('error', 'Need at least 2 players');
      return;
    }
    room.setMap(map);
    room.phase = 'playing';
    io.to(room.id).emit('game_started', { room: roomStateFor(room) });
  });

  socket.on('aim', ({ angle, power }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const cp = room.currentPlayer();
    if (!cp || cp.id !== socket.id) return;
    cp.angle = angle;
    cp.power = power;
    socket.to(room.id).emit('player_aimed', { id: socket.id, angle, power });
  });

  socket.on('fire', ({ spell, angle, power }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'playing') return;
    const cp = room.currentPlayer();
    if (!cp || cp.id !== socket.id) return;

    doFire(room, cp, spell, angle, power);
  });

  socket.on('move', ({ direction }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'playing') return;
    const cp = room.currentPlayer();
    if (!cp || cp.id !== socket.id) return;

    const speed = 10;
    cp.x = Math.max(20, Math.min(room.terrain.worldW - 20, cp.x + direction * speed));
    cp.facing = direction;
    const fell = room.checkFalls().length > 0;

    io.to(room.id).emit('player_moved', { id: socket.id, x: cp.x, y: cp.y, facing: cp.facing, hp: cp.hp });
    if (fell) endTurn(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(room.id).emit('player_left', { id: socket.id });
    if (!room.players.some(p => !p.isBot)) delete rooms[socket.data.roomId];
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function doFire(room, cp, spell, angle, power) {
  // Use angle/power sent with fire event (from mouse aim), fall back to stored
  if (angle !== undefined) cp.angle = angle;
  if (power !== undefined) cp.power = power;

  const sp = SPELLS[spell] || SPELLS.dragon_blast;
  const angleRad = (cp.angle * Math.PI) / 180;
  const speed = cp.power * 12 * sp.speed;
  cp.facing = Math.cos(angleRad) >= 0 ? 1 : -1;
  const proj = {
    x: cp.x,
    y: cp.y - PLAYER_H / 2,
    vx: Math.cos(angleRad) * speed,
    vy: Math.sin(angleRad) * speed,
    gravity: GRAVITY * sp.gravity,
  };

  // Simulate projectile server-side (deterministic)
  const result = simulateProjectile(proj, room, cp.id);
  const hits = room.applyExplosion(result.x, result.y, sp);
  const fallen = room.checkFalls();

  io.to(room.id).emit('projectile_result', {
    path: result.path,
    landX: result.x,
    landY: result.y,
    spell,
    radius: sp.radius,
    hits,
    fallen,
    terrain: room.terrain,
    players: room.players.map(p => ({ id: p.id, hp: p.hp, x: p.x, y: p.y, facing: p.facing })),
  });

  // Wait for clients to finish the projectile animation before the next turn
  endTurn(room, result.path.length / 60 * 1000 + 1200);
}

// Simple NPC: face the nearest enemy and lob a spell roughly at them
function botTurn(room) {
  const cp = room.currentPlayer();
  if (room.phase !== 'playing' || !cp || !cp.isBot) return;
  const foes = room.players.filter(p => p.hp > 0 && p.id !== cp.id);
  const target = foes.sort((a, b) => Math.abs(a.x - cp.x) - Math.abs(b.x - cp.x))[0];
  const dir = target && target.x < cp.x ? -1 : 1;
  const elev = 40 + Math.random() * 20;                       // degrees above horizontal
  const angle = dir > 0 ? -elev : -180 + elev;
  const power = 40 + Math.random() * 35;
  const keys = Object.keys(SPELLS);
  doFire(room, cp, keys[Math.floor(Math.random() * keys.length)], angle, power);
}

function endTurn(room, delay = 0) {
  const alive = room.players.filter(p => p.hp > 0);
  if (alive.length <= 1) {
    room.phase = 'over';
    io.to(room.id).emit('game_over', { winner: alive[0] || null });
    return;
  }
  room.advanceTurn();
  io.to(room.id).emit('turn_changed', { currentPlayerId: room.currentPlayer()?.id });
  if (room.currentPlayer()?.isBot) setTimeout(() => botTurn(room), delay + 1000);
}

function roomStateFor(room) {
  return {
    spells: SPELLS,
    maps: Object.fromEntries(Object.entries(MAPS).map(([k, m]) => [k, m.name])),
    id: room.id,
    phase: room.phase,
    players: room.players,
    currentPlayerId: room.currentPlayer()?.id,
    terrain: room.terrain,
  };
}

function simulateProjectile(proj, room, ownerId) {
  const dt = 1 / 60;
  const maxSteps = 60 * 15; // 15 seconds max
  const path = [];
  const { worldW, worldH } = room.terrain;
  let { x, y, vx, vy, gravity } = proj;

  for (let i = 0; i < maxSteps; i++) {
    vy += gravity * dt;
    x += vx * dt;
    y += vy * dt;

    if (i % 3 === 0) path.push({ x: Math.round(x), y: Math.round(y) });

    if (y >= room.terrainYAt(x) || x < 0 || x > worldW || y > worldH) break;

    // Direct hit on a player's body (ignore the caster for the first moments)
    const hit = room.players.some(p => p.hp > 0 && (p.id !== ownerId || i > 30) &&
      Math.abs(p.x - x) < 18 && Math.abs((p.y - PLAYER_H / 2) - y) < PLAYER_H / 2);
    if (hit) break;
  }
  path.push({ x: Math.round(x), y: Math.round(y) });

  return { x: Math.round(x), y: Math.round(y), path };
}

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Daoist Duels running on port ${PORT}`));
