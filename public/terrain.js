// ─── Daoist Duels — shared terrain (used by server and browser) ──────────────
// The world is split into narrow vertical columns. Each column holds a list of
// solid spans [top, bottom, material], so we can have floating ledges, caves,
// ribs and skulls — and blast holes through any of them.
(function (root) {
  const COL = 4;          // column width in px
  const STEP_UP = 14;     // tallest ledge you can just walk up
  const PLAYER_H = 40;    // character height — maps are ~100 characters wide, like Worms
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

  // Jumps: 'hop' = short forward jump (~2 body heights), 'leap' = qinggong high leap (~7 body heights)
  const JUMPS = { hop: { vx: 150, vy: -400 }, leap: { vx: 110, vy: -720 } };
  function jump(t, p, kind = 'hop') {
    const J = JUMPS[kind] || JUMPS.hop;
    let x = p.x, y = p.y, vx = J.vx * (p.facing || 1), vy = J.vy;
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
  // Worms-style proportions: 4000×1800 world with 40px characters, mostly one
  // connected landmass. Gaps are hop-able, ledges are within a qinggong leap.
  const MAPS = {
    jade_mountain: { name: 'Jade Mountain', build: buildJade },
    dragons_spine: { name: "Dragon's Spine", build: buildDragon },
  };

  // Smooth curve through control points [[x, y], ...]
  const curve = pts => x => {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      if (x <= x1) {
        const [x0, y0] = pts[i - 1];
        const u = (1 - Math.cos(((x - x0) / (x1 - x0)) * Math.PI)) / 2;
        return y0 + (y1 - y0) * u;
      }
    }
    return pts[pts.length - 1][1];
  };

  // Dig a tunnel between two points
  function tunnel(t, x0, y0, x1, y1, r) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6);
    for (let i = 0; i <= n; i++) carve(t, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, r);
  }

  const putDecor = (t, type, x, hintY = 0, extra = {}) => {
    const y = groundBelow(t, x, hintY);
    if (y !== null) t.decor.push({ type, x, y, ...extra });
  };

  function buildJade() {
    const t = blank(4000, 1800);
    t.bg = '/assets/maps/jade_mountain.jpg';
    t.theme = 'jade';
    t.liquid = { y: 1640, type: 'water' };
    const E = MAT.EARTH, H = t.worldH;

    // Rolling hills with a mountain in the middle; four narrow inlets you can hop over
    const land = curve([[0, 1240], [250, 1215], [450, 1290], [600, 1400], [680, 1400], [880, 1260],
      [1100, 1185], [1300, 1225], [1500, 1400], [1580, 1400], [1800, 1060], [1950, 905], [2080, 885],
      [2220, 1010], [2420, 1200], [2600, 1400], [2680, 1400], [2900, 1150], [3100, 1180], [3360, 1400],
      [3440, 1400], [3700, 1205], [4000, 1225]]);
    const segs = [[0, 610], [670, 1510], [1570, 2610], [2670, 3370], [3430, 4000]];
    segs.forEach(([x0, x1]) => addSolid(t, E, x0, x1, x => {
      const edge = Math.min(x - x0, x1 - x);
      return land(x) + Math.max(0, 24 - edge) * 1.5 + wob(x, 1) * 8;
    }, () => H));
    addSolid(t, E, 0, 4000, x => 1720 + wob(x, 9) * 10, () => H);   // lake bed

    // Floating grass ledges — reachable with a qinggong leap (Q)
    const ledge = (x, y, w) => addSolid(t, E, x, x + w, xx => y + wob(xx, x) * 2, xx => {
      const edge = Math.min(xx - x, x + w - xx);
      return y + 12 + Math.min(18, edge * 0.5);
    });
    ledge(250, 1080, 180); ledge(950, 1050, 170); ledge(1200, 930, 170); ledge(1990, 700, 200);
    ledge(2880, 960, 180); ledge(3180, 860, 160); ledge(3620, 1000, 200);
    normalise(t);

    [150, 900, 1360, 2330, 2840, 3580, 3920].forEach(x => putDecor(t, 'bamboo', x, 1100));
    [470, 1150, 1720, 2470, 3050, 3800].forEach(x => putDecor(t, 'boulder', x, 1100));
    [800, 1300, 2760, 3330].forEach(x => putDecor(t, 'cherry', x, 1100));
    putDecor(t, 'pagoda', 2090, 650); putDecor(t, 'pagoda', 3720, 950);
    putDecor(t, 'bamboo', 330, 1000); putDecor(t, 'cherry', 1290, 900);
    putDecor(t, 'torii', 3520, 1100);

    t.spawns = [[180, 1150], [3830, 1150], [2050, 800], [1050, 1150], [2950, 1100], [1300, 1150]];
    return t;
  }

  function buildDragon() {
    const t = blank(4000, 1800);
    t.bg = null;
    t.theme = 'cave';
    t.liquid = { y: 1680, type: 'lava' };
    const R = MAT.ROCK, B = MAT.BONE, H = t.worldH;

    // Cave walls
    addSolid(t, R, 0, 100, () => 0, () => H);
    addSolid(t, R, 3900, 4000, () => 0, () => H);

    // Ceiling with three alcoves cut up into it, stalactites elsewhere
    const pockets = [[350, 650], [1500, 1800], [2700, 3000]];
    const nearPocket = x => pockets.some(([a, b]) => x > a - 150 && x < b + 320);
    addSolid(t, R, 100, 3900, () => 0, x => {
      if (pockets.some(([a, b]) => x >= a && x <= b)) return 540 + wob(x, 3) * 10;
      let y = 650 + wob(x, 5) * 12;
      if (!nearPocket(x)) {
        const k = ((x % 150) + 150) % 150;
        y += Math.max(0, 55 - Math.abs(k - 75) * 3);
      }
      return y;
    });
    // Alcove balconies stick out to the right; a rock outcrop below each lets you leap up
    pockets.forEach(([a, b]) => {
      addSolid(t, R, a, b + 140, x => 740 + wob(x, a) * 3, x => 772 + Math.min(16, (b + 140 - x) * 0.4));
      addSolid(t, R, b + 160, b + 320, x => 1010 + wob(x, b) * 4, x => {
        const u = (x - b - 160) / 160;
        return 1040 + 50 * Math.sin(u * Math.PI);
      });
    });
    // Extra cover in the open
    [[1150, 1300], [2350, 2500]].forEach(([a, b]) => addSolid(t, R, a, b, x => 1090 + wob(x, a) * 4, x => 1120 + 40 * Math.sin((x - a) / (b - a) * Math.PI)));

    // The spine — walkable, with vertebra spikes you can hop over
    const spike = x => { const k = ((x - 100) % 200 + 200) % 200; return Math.max(0, 38 - Math.abs(k - 100) * 1.7); };
    addSolid(t, B, 100, 3150, x => 1250 + wob(x, 7) * 5 - spike(x), () => 1330);

    // Ribs curling down towards the lava
    for (let cx = 260; cx < 3100; cx += 200) {
      const len = 110;
      const top = x => 1320 + 230 * Math.sin(Math.max(0, (cx - x) / len) * Math.PI / 2);
      addSolid(t, B, cx - len, cx + 4, top, x => {
        const slope = Math.abs(top(x + 2) - top(x - 2)) / 4;
        return top(x) + 20 + Math.min(30, slope * COL * 1.5);
      });
    }

    // Dragon skull: cranium with swept-back horn, long snout, open jaw
    const CX = 3450, CY = 1230;
    const cranium = x => { const u = (x - CX) / 190; return Math.sqrt(Math.max(0, 1 - u * u)); };
    addSolid(t, B, 3100, 3300, x => 1250 - (x - 3100) * 0.75 + wob(x, 2) * 3, () => 1330);       // neck ramp
    addSolid(t, B, CX - 190, CX + 190, x => CY - 210 * cranium(x), x => CY + 100 * cranium(x));
    addSolid(t, B, 3362, 3530, x => x < 3400 ? 880 + (3400 - x) * 4 : 880 + (x - 3400) * 1.3, () => 1120); // horn
    addSolid(t, B, 3560, 3880, x => {
      const brow = Math.max(0, 30 - Math.abs(x - 3590) * 0.8);
      return 1150 + (x - 3560) * 0.18 - brow + wob(x, 4) * 3;
    }, x => 1285 - Math.max(0, x - 3820) * 0.6);                                                   // snout
    addSolid(t, B, 3520, 3850, x => 1322 + (x - 3520) * 0.02, x => 1362 - Math.max(0, x - 3800) * 0.4); // lower jaw
    normalise(t);

    t.decor.push({ type: 'eye', x: CX + 40, y: CY - 70 });
    t.decor.push({ type: 'teeth', x: 3580, y: 1285, w: 240 });
    t.decor.push({ type: 'nostril', x: 3845, y: 1215 });

    t.spawns = [[400, 1200], [3700, 1100], [1650, 700], [2600, 1200], [500, 700], [2850, 700]];
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
