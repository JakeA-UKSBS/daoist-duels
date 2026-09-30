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
const WORLD_W = 2560;
const WORLD_H = 1440;
const GRAVITY  = 600;   // px / s²
const MAX_PLAYERS = 6;

// ─── Game state ───────────────────────────────────────────────────────────────
const rooms = {};   // roomId → GameRoom

class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = [];   // [{ id, name, x, y, hp, facing, color, charIndex }]
    this.currentTurn = 0;
    this.projectile = null;
    this.terrain = this.buildTerrain();
    this.phase = 'lobby';   // lobby | playing | over
  }

  buildTerrain() {
    // Simple heightmap for initial terrain (Jade Mountain style)
    const heights = [];
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      // Rolling hills with two peaks
      const h = 0.55 + 0.12 * Math.sin(t * Math.PI * 3) + 0.05 * Math.sin(t * Math.PI * 7);
      heights.push(Math.floor(h * WORLD_H));
    }
    return { type: 'heightmap', heights, segments, worldW: WORLD_W, worldH: WORLD_H };
  }

  addPlayer(socketId, name) {
    if (this.players.length >= MAX_PLAYERS) return null;
    const idx = this.players.length;
    const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];
    const startX = 200 + (WORLD_W - 400) / Math.max(MAX_PLAYERS - 1, 1) * idx;
    const startY = this.terrainYAt(startX) - 1;  // feet on terrain
    const player = {
      id: socketId,
      name,
      x: startX,
      y: startY,
      hp: 100,
      facing: 1,
      color: colors[idx],
      charIndex: idx % 4,
      angle: -45,
      power: 50,
    };
    this.players.push(player);
    return player;
  }

  terrainYAt(x) {
    const { heights, segments } = this.terrain;
    const t = Math.max(0, Math.min(1, x / WORLD_W));
    const fi = t * segments;
    const i = Math.floor(fi);
    const frac = fi - i;
    const h0 = heights[Math.min(i, segments)];
    const h1 = heights[Math.min(i + 1, segments)];
    return h0 + (h1 - h0) * frac;
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

  applyExplosion(x, y, radius) {
    // Carve terrain heightmap
    const { heights, segments } = this.terrain;
    for (let i = 0; i <= segments; i++) {
      const tx = (i / segments) * WORLD_W;
      const dx = tx - x;
      if (Math.abs(dx) < radius) {
        const depth = Math.sqrt(Math.max(0, radius * radius - dx * dx));
        heights[i] = Math.min(WORLD_H, heights[i] + depth * 0.6);
      }
    }

    // Damage players in blast radius
    this.players.forEach(p => {
      if (p.hp <= 0) return;
      const dx = p.x - x;
      const dy = p.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < radius * 1.5) {
        const dmg = Math.floor((1 - dist / (radius * 1.5)) * 40);
        p.hp = Math.max(0, p.hp - dmg);
      }
    });
  }
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('join_room', ({ roomId, name }) => {
    if (!rooms[roomId]) rooms[roomId] = new GameRoom(roomId);
    const room = rooms[roomId];

    const player = room.addPlayer(socket.id, name);
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
    socket.to(roomId).emit('player_joined', { player });
  });

  socket.on('start_game', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.players[0]?.id !== socket.id) return;
    if (room.players.length < 2) {
      socket.emit('error', 'Need at least 2 players');
      return;
    }
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

    // Use angle/power sent with fire event (from mouse aim), fall back to stored
    if (angle !== undefined) cp.angle = angle;
    if (power !== undefined) cp.power = power;

    const angleRad = (cp.angle * Math.PI) / 180;
    const speed = cp.power * 12;
    const proj = {
      x: cp.x,
      y: cp.y - 22,
      vx: Math.cos(angleRad) * speed,
      vy: Math.sin(angleRad) * speed,
      spell,
      ownerId: socket.id,
    };

    // Simulate projectile server-side (deterministic)
    const result = simulateProjectile(proj, room);
    room.applyExplosion(result.x, result.y, spellRadius(spell));

    io.to(room.id).emit('projectile_result', {
      path: result.path,
      landX: result.x,
      landY: result.y,
      spell,
      radius: spellRadius(spell),
      terrain: room.terrain,
      players: room.players.map(p => ({ id: p.id, hp: p.hp })),
    });

    // Check for game over
    const alive = room.players.filter(p => p.hp > 0);
    if (alive.length <= 1) {
      room.phase = 'over';
      io.to(room.id).emit('game_over', { winner: alive[0] || null });
      return;
    }

    room.advanceTurn();
    io.to(room.id).emit('turn_changed', {
      currentPlayerId: room.currentPlayer()?.id,
    });
  });

  socket.on('move', ({ direction }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'playing') return;
    const cp = room.currentPlayer();
    if (!cp || cp.id !== socket.id) return;

    const speed = 10;
    cp.x = Math.max(20, Math.min(WORLD_W - 20, cp.x + direction * speed));
    cp.y = room.terrainYAt(cp.x) - 1;  // feet sit ON the terrain surface
    cp.facing = direction;

    io.to(room.id).emit('player_moved', { id: socket.id, x: cp.x, y: cp.y, facing: cp.facing });
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(room.id).emit('player_left', { id: socket.id });
    if (room.players.length === 0) delete rooms[socket.data.roomId];
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function roomStateFor(room) {
  return {
    id: room.id,
    phase: room.phase,
    players: room.players,
    currentPlayerId: room.currentPlayer()?.id,
    terrain: room.terrain,
  };
}

function spellRadius(spell) {
  const radii = { dragon_blast: 120, tidal_wave: 80, thunder_strike: 100, wind_slash: 60 };
  return radii[spell] || 80;
}

function simulateProjectile(proj, room) {
  const dt = 1 / 60;
  const maxSteps = 60 * 15; // 15 seconds max
  const path = [];
  let { x, y, vx, vy } = proj;

  for (let i = 0; i < maxSteps; i++) {
    vy += GRAVITY * dt;
    x += vx * dt;
    y += vy * dt;

    if (i % 3 === 0) path.push({ x: Math.round(x), y: Math.round(y) });

    const terrainY = room.terrainYAt(x);
    if (y >= terrainY || x < 0 || x > WORLD_W || y > WORLD_H) break;
  }

  return { x: Math.round(x), y: Math.round(y), path };
}

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Daoist Duels running on port ${PORT}`));
