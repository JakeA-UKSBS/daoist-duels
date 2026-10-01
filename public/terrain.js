// ─── Daoist Duels — shared terrain (used by server and browser) ──────────────
// The world is split into narrow vertical columns. Each column holds a list of
// solid spans [top, bottom, material], so we can have floating ledges, caves,
// ribs and skulls — and blast holes through any of them.
(function (root) {
  const COL = 4;          // column width in px
  const STEP_UP = 22;     // tallest ledge you can just walk up
  const PLAYER_H = 64;
  const MAT = { EARTH: 0, ROCK: 1, BONE: 2 };

  // Cheap deterministic wobble so edges aren't ruler-straight
  const wob = (x, s = 0) => Math.sin(x * 0.013 + s) * 0.5 + Math.sin(x * 0.037 + s * 2.1) * 0.3 + Math.sin(x * 0.091 + s * 3.7) * 0.2;

  function blank(worldW, worldH) {
    return { worldW, worldH, cols: Array.from({ length: Math.ceil(worldW / COL) }, () => []), decor: [], liquid: null };
  }

  // Add a solid between x0..x1 whose top/bottom are functions of x
  function addSolid(t, mat, x0, x1, top, bottom) {
    for (let c = Math.max(0, Math.floor(x0 / COL)); c < Math.min(t.cols.length, Math.ceil(x1 / COL)); c++) {
      const x = c * COL + COL / 2;
      const a = Math.round(top(x)), b = Math.round(bottom(x));
      if (b - a >= 2) t.cols[c].push([a, b, mat]);
    }
  }

  // Sort spans and merge overlaps (the upper span's material wins)
  function normalise(t) {
    t.cols = t.cols.map(spans => {
      spans.sort((p, q) => p[0] - q[0]);
      const out = [];
      for (const s of spans) {
        const last = out[out.length - 1];
        if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
        else out.push(s.slice());
      }
      return out;
    });
  }

  const colAt = (t, x) => t.cols[Math.floor(x / COL)] || [];
  const isSolid = (t, x, y) => colAt(t, x).some(([a, b]) => y >= a && y <= b);

  // Highest surface at or below y (null = nothing, i.e. a bottomless drop)
  function groundBelow(t, x, y) {
    let best = null;
    for (const [a] of colAt(t, x)) if (a >= y && (best === null || a < best)) best = a;
    return best;
  }

  // Something in the way of a body standing with feet at y?
  const blocked = (t, x, y) => colAt(t, x).some(([a, b]) => a < y - STEP_UP && b > y - PLAYER_H + 4);

  // Drop a player onto whatever is under them. Returns false if they fell in liquid / the abyss.
  function settle(t, p) {
    const g = groundBelow(t, p.x, p.y - STEP_UP);
    if (g === null || (t.liquid && g >= t.liquid.y)) {
      p.y = t.liquid ? t.liquid.y + 20 : t.worldH;
      return false;
    }
    p.y = g;
    return true;
  }

  // Walk (or get shoved) sideways, stopping at walls
  function walk(t, p, dist) {
    const dir = Math.sign(dist);
    let left = Math.abs(dist);
    while (left > 0) {
      const s = Math.min(2, left);
      left -= s;
      const nx = p.x + dir * s;
      if (nx < 10 || nx > t.worldW - 10 || blocked(t, nx, p.y)) break;
      p.x = nx;
      if (!settle(t, p)) return false;
    }
    return true;
  }

  // Hop forward in the facing direction. Returns the path for animation.
  function jump(t, p) {
    let x = p.x, y = p.y, vx = 170 * (p.facing || 1), vy = -440;
    const dt = 1 / 60, path = [];
    for (let i = 0; i < 240; i++) {
      vy += 900 * dt;
      const nx = x + vx * dt, ny = y + vy * dt;
      if (nx < 10 || nx > t.worldW - 10 || colAt(t, nx).some(([a, b]) => a < ny - 2 && b > ny - PLAYER_H + 4)) vx = 0;
      else x = nx;
      if (vy < 0 && isSolid(t, x, ny - PLAYER_H)) vy = 0;      // bonk head on ceiling
      const g = groundBelow(t, x, y);
      if (vy > 0 && g !== null && ny >= g) { y = g; path.push({ x, y }); break; }
      y = ny;
      path.push({ x: Math.round(x), y: Math.round(y) });
      if (t.liquid && y >= t.liquid.y + 20) break;
      if (y > t.worldH) break;
    }
    p.x = Math.round(x); p.y = y;
    const alive = settle(t, p);
    return { path, alive };
  }

  // Blast a circular hole, splitting spans where needed
  function carve(t, cx, cy, r) {
    if (r <= 0) return;
    for (let c = Math.max(0, Math.floor((cx - r) / COL)); c <= Math.min(t.cols.length - 1, Math.floor((cx + r) / COL)); c++) {
      const dx = c * COL + COL / 2 - cx;
      if (Math.abs(dx) >= r) continue;
      const d = Math.sqrt(r * r - dx * dx), a = cy - d, b = cy + d;
      const out = [];
      for (const s of t.cols[c]) {
        if (b < s[0] || a > s[1]) { out.push(s); continue; }
        if (a > s[0] + 1) out.push([s[0], Math.round(a), s[2]]);
        if (b < s[1] - 1) out.push([Math.round(b), s[1], s[2]]);
      }
      t.cols[c] = out;
    }
  }

  // ─── Maps ─────────────────────────────────────────────────────────────────
  const MAPS = {
    jade_mountain: { name: 'Jade Mountain', build: buildJade },
    dragons_spine: { name: "Dragon's Spine", build: buildDragon },
  };

  function buildJade() {
    const t = blank(2560, 1440);
    t.bg = '/assets/maps/jade_mountain.jpg';
    t.theme = 'jade';
    t.liquid = { y: 1250, type: 'water' };
    const E = MAT.EARTH, H = t.worldH;

    // Cliff islands rising out of the lake — rounded shoulders at the edges
    const island = (x0, x1, top) => addSolid(t, E, x0, x1, x => {
      const edge = Math.min(x - x0, x1 - x);
      return top(x) + Math.max(0, 40 - edge) * 1.2 + wob(x, x0) * 10;
    }, () => H);
    island(0, 470, () => 900);
    island(590, 1010, () => 1020);
    island(1120, 1690, x => x < 1430 ? 770 : x > 1490 ? 920 : 770 + (x - 1430) * 2.5);
    island(1810, 2240, x => 650 + (x - 1810) * 0.12);
    island(2350, 2560, () => 880);
    addSolid(t, E, 0, 2560, x => 1340 + wob(x, 9) * 12, () => H);   // lake bed

    // Floating grass ledges
    const ledge = (x, y, w) => addSolid(t, E, x, x + w, xx => y + wob(xx, x) * 3, xx => {
      const edge = Math.min(xx - x, x + w - xx);
      return y + 16 + Math.min(22, edge * 0.6);
    });
    ledge(80, 600, 210); ledge(470, 790, 160); ledge(860, 570, 210); ledge(1240, 520, 170);
    ledge(1550, 420, 200); ledge(2000, 450, 180); ledge(2330, 620, 190);
    normalise(t);

    // Decorations sit on the ground at x (searching down from hintY)
    const put = (type, x, hintY = 0) => { const y = groundBelow(t, x, hintY); if (y !== null) t.decor.push({ type, x, y }); };
    [300, 760, 1230, 1600, 2120, 2470].forEach(x => put('bamboo', x, x === 1600 ? 700 : 0));
    put('bamboo', 1000, 500);
    [130, 420, 930, 1380, 1950, 2520].forEach(x => put('boulder', x));
    put('pagoda', 1650, 400); put('pagoda', 180, 580);
    [690, 1330, 2200, 2400].forEach(x => put('cherry', x));
    put('torii', 1560, 800);

    t.spawns = [[220, 700], [2470, 700], [1300, 700], [790, 0], [2010, 600], [960, 500]];
    return t;
  }

  function buildDragon() {
    const t = blank(2560, 1440);
    t.bg = null;
    t.theme = 'cave';
    t.liquid = { y: 1330, type: 'lava' };
    const R = MAT.ROCK, B = MAT.BONE, H = t.worldH;

    // Cave walls
    addSolid(t, R, 0, 90, () => 0, x => H);
    addSolid(t, R, 2470, 2560, () => 0, () => H);

    // Ceiling with alcoves carved up into it, and stalactites hanging down
    const pockets = [[170, 430], [750, 1010], [1410, 1670], [2010, 2270]];
    const inPocket = x => pockets.some(([a, b]) => x >= a && x <= b);
    addSolid(t, R, 90, 2470, () => 0, x => {
      if (inPocket(x)) return 210 + wob(x, 3) * 12;
      let y = 470 + wob(x, 5) * 14;
      const sx = ((x % 115) + 115) % 115;                      // stalactite every 115px
      y += Math.max(0, 70 - Math.abs(sx - 57) * 3.2);
      return y;
    });
    // Alcove floors — leave a gap on the right so you can drop out
    pockets.forEach(([a, b]) => addSolid(t, R, a, b - 70, x => 430 + wob(x, a) * 3, x => 470 + Math.min(20, (b - 70 - x) * 0.5)));

    // Rock outcrops in the open cavern for cover
    const outcrop = (x0, x1, y) => addSolid(t, R, x0, x1, x => y + wob(x, x0) * 6, x => {
      const u = (x - x0) / (x1 - x0);
      return y + 30 + 60 * Math.sin(u * Math.PI);
    });
    outcrop(560, 780, 760); outcrop(1160, 1420, 660); outcrop(1760, 1980, 760);

    // The spine: walkable bone with vertebra spikes
    const SPINE_TOP = 1000;
    const spike = x => { const k = ((x - 170) % 170 + 170) % 170; return Math.max(0, 90 - Math.abs(k - 85 - 6) * 3.4); };
    addSolid(t, B, 90, 2200, x => SPINE_TOP + wob(x, 7) * 6 - spike(x), () => 1070);

    // Ribs curling down underneath, over the lava
    for (let cx = 250; cx < 2150; cx += 170) {
      const len = 90;
      const top = x => { const u = (cx - x) / len; return 1060 + 190 * Math.sin(Math.max(0, u) * Math.PI / 2); };
      addSolid(t, B, cx - len, cx + 4, top, x => {
        const slope = Math.abs(top(x + 2) - top(x - 2)) / 4;
        return top(x) + 18 + Math.min(30, slope * COL * 1.5);
      });
    }

    // Skull at the right, with horn and jaw
    const SX = 2320, SY = 1010;
    addSolid(t, B, SX - 150, SX + 150, x => {
      const u = (x - SX) / 150;
      const horn = Math.max(0, 130 - Math.abs(x - (SX - 70)) * 4.5);
      return SY - 140 * Math.sqrt(Math.max(0, 1 - u * u)) - horn;
    }, x => SY + 70 * Math.sqrt(Math.max(0, 1 - ((x - SX) / 150) ** 2)));
    addSolid(t, B, SX + 60, 2470, () => 1055, x => 1095);
    normalise(t);

    t.decor.push({ type: 'eye', x: SX + 30, y: SY - 40 });
    t.decor.push({ type: 'teeth', x: SX + 70, y: 1095, w: 2470 - SX - 80 });

    t.spawns = [[260, 300], [2100, 300], [1500, 300], [840, 300], [516, 800], [1876, 800]];
    return t;
  }

  function buildMap(key) {
    const k = MAPS[key] ? key : 'jade_mountain';
    const t = MAPS[k].build();
    t.map = k;
    t.name = MAPS[k].name;
    return t;
  }

  const api = { COL, STEP_UP, PLAYER_H, MAT, MAPS, buildMap, isSolid, groundBelow, settle, walk, jump, carve, blocked };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Terrain = api;
})(this);
