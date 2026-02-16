/*
README
======
How to run:
1) Keep index.html, style.css, and main.js in the same folder.
2) Open index.html in a modern browser.

Controls:
- Mouse: steer your primary movement direction.
- Space: split your largest controlled piece toward cursor.
- W: eject a small mass pellet in cursor direction.
- Esc: pause/resume.

Notes:
- This is an original single-player cell-eat-cell game inspired by the genre.
- Tunable parameters are listed below in CONFIG.
*/

(() => {
  "use strict";

  const CONFIG = {
    worldSize: 8000,
    botCount: 28,
    pelletTarget: 1300,
    virusCount: 38,
    maxPiecesPerPlayer: 16,
    startMass: 280,
    botStartMass: 260,
    pelletMass: 11,
    ejectedMass: 22,
    ejectedCooldown: 0.12,
    minEjectMass: 320,
    splitMinMass: 380,
    splitImpulse: 700,
    splitCooldown: 0.2,
    mergeCooldown: 12,
    massDecayThreshold: 1300,
    massDecayRate: 0.012,
    eatSizeRatio: 1.16,
    eatOverlapBias: 0.78,
    baseSpeed: 540,
    minSpeed: 52,
    accelFactor: 6.2,
    damping: 0.88,
    gridSize: 180,
    virusRadius: 66,
    virusBurstThresholdRadius: 56,
    virusFeedShots: 7,
    virusShotSpeed: 360,
    botDecisionEvery: 0.42,
    botSplitChance: 0.1,
    maxDelta: 0.033,
    fixedDt: 1 / 60,
    minimapSize: 168,
  };

  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const leaderboardList = document.getElementById("leaderboardList");
  const startScreen = document.getElementById("startScreen");
  const pauseScreen = document.getElementById("pauseScreen");
  const nameInput = document.getElementById("nameInput");
  const playBtn = document.getElementById("playBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  const restartBtn = document.getElementById("restartBtn");

  const TAU = Math.PI * 2;
  let seed = 78654321;
  const rand = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const randRange = (a, b) => a + rand() * (b - a);

  const state = {
    running: false,
    paused: false,
    over: false,
    camera: { x: CONFIG.worldSize / 2, y: CONFIG.worldSize / 2, zoom: 1 },
    mouse: { x: 0, y: 0, worldX: 0, worldY: 0 },
    keys: new Set(),
    players: [],
    pellets: [],
    viruses: [],
    ejected: [],
    lastTime: 0,
    accumulator: 0,
    playerId: null,
    msg: "",
  };

  let blobIdCounter = 1;

  class SpatialHash {
    constructor(size) {
      this.size = size;
      this.map = new Map();
    }
    clear() {
      this.map.clear();
    }
    key(ix, iy) {
      return `${ix},${iy}`;
    }
    insert(item, x, y, r = 0) {
      const minX = Math.floor((x - r) / this.size);
      const maxX = Math.floor((x + r) / this.size);
      const minY = Math.floor((y - r) / this.size);
      const maxY = Math.floor((y + r) / this.size);
      for (let ix = minX; ix <= maxX; ix++) {
        for (let iy = minY; iy <= maxY; iy++) {
          const k = this.key(ix, iy);
          if (!this.map.has(k)) this.map.set(k, []);
          this.map.get(k).push(item);
        }
      }
    }
    query(x, y, r) {
      const out = [];
      const seen = new Set();
      const minX = Math.floor((x - r) / this.size);
      const maxX = Math.floor((x + r) / this.size);
      const minY = Math.floor((y - r) / this.size);
      const maxY = Math.floor((y + r) / this.size);
      for (let ix = minX; ix <= maxX; ix++) {
        for (let iy = minY; iy <= maxY; iy++) {
          const arr = this.map.get(this.key(ix, iy));
          if (!arr) continue;
          for (const it of arr) {
            if (!seen.has(it.__sid)) {
              seen.add(it.__sid);
              out.push(it);
            }
          }
        }
      }
      return out;
    }
  }

  const grids = {
    pellets: new SpatialHash(CONFIG.gridSize),
    ejected: new SpatialHash(CONFIG.gridSize),
    blobs: new SpatialHash(CONFIG.gridSize),
    viruses: new SpatialHash(CONFIG.gridSize),
  };

  const radiusFromMass = (m) => Math.sqrt(m);
  const massFromRadius = (r) => r * r;

  function makeBlob(owner, x, y, mass) {
    return {
      id: blobIdCounter++,
      owner,
      x,
      y,
      vx: 0,
      vy: 0,
      mass,
      mergeTimer: CONFIG.mergeCooldown,
      splitTimer: 0,
      color: owner.color,
      __sid: `b${blobIdCounter + rand()}`,
    };
  }

  function makePlayer(name, isBot, color) {
    return {
      id: `p${Math.floor(rand() * 1e7)}`,
      name,
      isBot,
      color,
      blobs: [],
      ai: {
        targetX: randRange(0, CONFIG.worldSize),
        targetY: randRange(0, CONFIG.worldSize),
        think: 0,
      },
      ejectCd: 0,
      splitCd: 0,
      dead: false,
    };
  }

  function palette() {
    const colors = ["#7ec8ff", "#f3a6ff", "#8af0b4", "#ffd67b", "#ff8a8a", "#9eb0ff", "#8ff4ff", "#ffb29f"];
    return colors[Math.floor(rand() * colors.length)];
  }

  function clampToWorld(entity, bounce = 0.22) {
    const r = radiusFromMass(entity.mass || 20);
    const max = CONFIG.worldSize;
    if (entity.x < r) {
      entity.x = r;
      entity.vx = Math.abs(entity.vx) * bounce;
    }
    if (entity.y < r) {
      entity.y = r;
      entity.vy = Math.abs(entity.vy) * bounce;
    }
    if (entity.x > max - r) {
      entity.x = max - r;
      entity.vx = -Math.abs(entity.vx) * bounce;
    }
    if (entity.y > max - r) {
      entity.y = max - r;
      entity.vy = -Math.abs(entity.vy) * bounce;
    }
  }

  function spawnPellet() {
    const p = {
      id: `f${Math.floor(rand() * 1e9)}`,
      x: randRange(0, CONFIG.worldSize),
      y: randRange(0, CONFIG.worldSize),
      mass: CONFIG.pelletMass * randRange(0.85, 1.2),
      color: `hsl(${Math.floor(randRange(160, 330))} 75% 60%)`,
      __sid: `f${Math.floor(rand() * 1e9)}`,
    };
    state.pellets.push(p);
  }

  function spawnVirus(x = randRange(0, CONFIG.worldSize), y = randRange(0, CONFIG.worldSize), vx = 0, vy = 0) {
    state.viruses.push({
      id: `v${Math.floor(rand() * 1e9)}`,
      x,
      y,
      vx,
      vy,
      mass: massFromRadius(CONFIG.virusRadius),
      feed: 0,
      dirX: 1,
      dirY: 0,
      __sid: `v${Math.floor(rand() * 1e9)}`,
    });
  }

  function initGame() {
    state.players = [];
    state.pellets = [];
    state.viruses = [];
    state.ejected = [];
    state.over = false;
    state.msg = "";

    const playerName = (nameInput.value.trim() || "Player").slice(0, 16);
    const human = makePlayer(playerName, false, "#78b8ff");
    human.blobs.push(makeBlob(human, CONFIG.worldSize * 0.5, CONFIG.worldSize * 0.5, CONFIG.startMass));
    state.players.push(human);
    state.playerId = human.id;

    for (let i = 0; i < CONFIG.botCount; i++) {
      const bot = makePlayer(`Bot-${i + 1}`, true, palette());
      const x = randRange(500, CONFIG.worldSize - 500);
      const y = randRange(500, CONFIG.worldSize - 500);
      bot.blobs.push(makeBlob(bot, x, y, CONFIG.botStartMass * randRange(0.86, 1.16)));
      state.players.push(bot);
    }

    for (let i = 0; i < CONFIG.pelletTarget; i++) spawnPellet();
    for (let i = 0; i < CONFIG.virusCount; i++) spawnVirus();

    state.running = true;
    state.paused = false;
    state.lastTime = 0;
    state.accumulator = 0;
  }

  function getHuman() {
    return state.players.find((p) => p.id === state.playerId);
  }

  function worldFromScreen(sx, sy) {
    const cam = state.camera;
    return {
      x: cam.x + (sx - canvas.width / 2) / cam.zoom,
      y: cam.y + (sy - canvas.height / 2) / cam.zoom,
    };
  }

  function updateCamera() {
    const human = getHuman();
    if (!human || human.blobs.length === 0) return;
    let tx = 0;
    let ty = 0;
    let tm = 0;
    for (const b of human.blobs) {
      tx += b.x * b.mass;
      ty += b.y * b.mass;
      tm += b.mass;
    }
    tx /= tm;
    ty /= tm;

    const totalMass = tm;
    const targetZoom = Math.max(0.3, Math.min(1.25, 1.2 - Math.log(totalMass) * 0.065));

    state.camera.x += (tx - state.camera.x) * 0.12;
    state.camera.y += (ty - state.camera.y) * 0.12;
    state.camera.zoom += (targetZoom - state.camera.zoom) * 0.08;
  }

  function updateMouseWorld() {
    const w = worldFromScreen(state.mouse.x, state.mouse.y);
    state.mouse.worldX = w.x;
    state.mouse.worldY = w.y;
  }

  function blobSpeed(blob) {
    return Math.max(CONFIG.minSpeed, CONFIG.baseSpeed / Math.pow(blob.mass, 0.34));
  }

  function steerBlob(blob, targetX, targetY, dt) {
    const dx = targetX - blob.x;
    const dy = targetY - blob.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const desired = blobSpeed(blob);
    const desiredVx = ux * desired;
    const desiredVy = uy * desired;
    blob.vx += (desiredVx - blob.vx) * Math.min(1, CONFIG.accelFactor * dt);
    blob.vy += (desiredVy - blob.vy) * Math.min(1, CONFIG.accelFactor * dt);
  }

  function updateBots(dt) {
    for (const p of state.players) {
      if (!p.isBot || p.dead || p.blobs.length === 0) continue;
      p.ai.think -= dt;
      if (p.ai.think <= 0) {
        p.ai.think = CONFIG.botDecisionEvery + rand() * 0.2;
        const largest = p.blobs.reduce((a, b) => (a.mass > b.mass ? a : b));
        const r = radiusFromMass(largest.mass);

        let threat = null;
        let prey = null;
        let food = null;
        let threatScore = Infinity;
        let preyScore = Infinity;
        let foodScore = Infinity;

        const nearBlobs = grids.blobs.query(largest.x, largest.y, 880);
        for (const other of nearBlobs) {
          if (other.owner.id === p.id) continue;
          const d = Math.hypot(other.x - largest.x, other.y - largest.y);
          if (other.mass > largest.mass * 1.25 && d < threatScore) {
            threatScore = d;
            threat = other;
          } else if (largest.mass > other.mass * 1.35 && d < preyScore) {
            preyScore = d;
            prey = other;
          }
        }

        if (!threat) {
          const nearPellets = grids.pellets.query(largest.x, largest.y, 760);
          for (const pellet of nearPellets) {
            const d = Math.hypot(pellet.x - largest.x, pellet.y - largest.y);
            if (d < foodScore) {
              foodScore = d;
              food = pellet;
            }
          }
        }

        if (threat) {
          const dx = largest.x - threat.x;
          const dy = largest.y - threat.y;
          const dn = Math.hypot(dx, dy) || 1;
          p.ai.targetX = largest.x + (dx / dn) * 500;
          p.ai.targetY = largest.y + (dy / dn) * 500;
        } else if (prey) {
          p.ai.targetX = prey.x;
          p.ai.targetY = prey.y;
          if (p.blobs.length < CONFIG.maxPiecesPerPlayer && largest.mass > CONFIG.splitMinMass * 1.65 && rand() < CONFIG.botSplitChance) {
            splitPlayer(p, p.ai.targetX, p.ai.targetY);
          }
        } else if (food) {
          p.ai.targetX = food.x;
          p.ai.targetY = food.y;
        } else {
          p.ai.targetX += randRange(-220, 220);
          p.ai.targetY += randRange(-220, 220);
        }

        p.ai.targetX = Math.max(0, Math.min(CONFIG.worldSize, p.ai.targetX));
        p.ai.targetY = Math.max(0, Math.min(CONFIG.worldSize, p.ai.targetY));
      }

      for (const b of p.blobs) steerBlob(b, p.ai.targetX, p.ai.targetY, dt);
    }
  }

  function updateHumanInput(dt) {
    const human = getHuman();
    if (!human || human.dead) return;
    updateMouseWorld();
    for (const b of human.blobs) steerBlob(b, state.mouse.worldX, state.mouse.worldY, dt);

    if (human.ejectCd > 0) human.ejectCd -= dt;
    if (human.splitCd > 0) human.splitCd -= dt;

    if (state.keys.has(" ") && human.splitCd <= 0) {
      splitPlayer(human, state.mouse.worldX, state.mouse.worldY);
      human.splitCd = CONFIG.splitCooldown;
    }
    if (state.keys.has("w") && human.ejectCd <= 0) {
      ejectMass(human, state.mouse.worldX, state.mouse.worldY);
      human.ejectCd = CONFIG.ejectedCooldown;
    }
  }

  function splitPlayer(player, tx, ty) {
    if (player.blobs.length >= CONFIG.maxPiecesPerPlayer) return;
    const base = player.blobs.reduce((a, b) => (a.mass > b.mass ? a : b), player.blobs[0]);
    if (!base || base.mass < CONFIG.splitMinMass) return;

    const dx = tx - base.x;
    const dy = ty - base.y;
    const dn = Math.hypot(dx, dy) || 1;
    const ux = dx / dn;
    const uy = dy / dn;

    const newMass = base.mass * 0.5;
    base.mass *= 0.5;
    const r = radiusFromMass(base.mass);

    const child = makeBlob(player, base.x + ux * (r * 2.1), base.y + uy * (r * 2.1), newMass);
    child.vx = ux * CONFIG.splitImpulse;
    child.vy = uy * CONFIG.splitImpulse;
    child.mergeTimer = CONFIG.mergeCooldown;
    base.mergeTimer = CONFIG.mergeCooldown;
    base.vx -= ux * 140;
    base.vy -= uy * 140;

    player.blobs.push(child);
  }

  function ejectMass(player, tx, ty) {
    const source = player.blobs.reduce((a, b) => (a.mass > b.mass ? a : b), player.blobs[0]);
    if (!source || source.mass < CONFIG.minEjectMass) return;

    const dx = tx - source.x;
    const dy = ty - source.y;
    const dn = Math.hypot(dx, dy) || 1;
    const ux = dx / dn;
    const uy = dy / dn;

    source.mass -= CONFIG.ejectedMass;
    const r = radiusFromMass(source.mass);
    state.ejected.push({
      id: `e${Math.floor(rand() * 1e9)}`,
      ownerId: player.id,
      x: source.x + ux * (r + 12),
      y: source.y + uy * (r + 12),
      vx: ux * 620,
      vy: uy * 620,
      mass: CONFIG.ejectedMass,
      dirX: ux,
      dirY: uy,
      __sid: `e${Math.floor(rand() * 1e9)}`,
    });

    source.vx -= ux * 70;
    source.vy -= uy * 70;
  }

  function rebuildGrids() {
    grids.pellets.clear();
    grids.ejected.clear();
    grids.blobs.clear();
    grids.viruses.clear();

    for (const p of state.pellets) grids.pellets.insert(p, p.x, p.y, 8);
    for (const e of state.ejected) grids.ejected.insert(e, e.x, e.y, 10);
    for (const v of state.viruses) grids.viruses.insert(v, v.x, v.y, CONFIG.virusRadius);

    for (const pl of state.players) {
      for (const b of pl.blobs) {
        grids.blobs.insert(b, b.x, b.y, radiusFromMass(b.mass));
      }
    }
  }

  function updatePhysics(dt) {
    for (const pl of state.players) {
      if (pl.dead) continue;
      for (const b of pl.blobs) {
        if (b.mergeTimer > 0) b.mergeTimer -= dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.vx *= Math.pow(CONFIG.damping, dt * 60);
        b.vy *= Math.pow(CONFIG.damping, dt * 60);

        if (b.mass > CONFIG.massDecayThreshold) {
          b.mass *= 1 - CONFIG.massDecayRate * dt;
        }

        clampToWorld(b);
      }
    }

    for (const e of state.ejected) {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vx *= Math.pow(0.9, dt * 60);
      e.vy *= Math.pow(0.9, dt * 60);
      clampToWorld(e, 0.12);
    }

    for (const v of state.viruses) {
      v.x += v.vx * dt;
      v.y += v.vy * dt;
      v.vx *= Math.pow(0.94, dt * 60);
      v.vy *= Math.pow(0.94, dt * 60);
      clampToWorld(v, 0.08);
    }
  }

  function canEat(big, small) {
    const rb = radiusFromMass(big.mass);
    const rs = radiusFromMass(small.mass);
    if (rb < rs * CONFIG.eatSizeRatio) return false;
    const d = Math.hypot(big.x - small.x, big.y - small.y);
    return d < rb - rs * CONFIG.eatOverlapBias;
  }

  function runCollisions() {
    const deadPellets = new Set();
    const deadEjected = new Set();

    for (const pl of state.players) {
      for (const b of pl.blobs) {
        const r = radiusFromMass(b.mass);

        for (const pellet of grids.pellets.query(b.x, b.y, r + 14)) {
          if (deadPellets.has(pellet.id)) continue;
          if (Math.hypot(pellet.x - b.x, pellet.y - b.y) < r) {
            b.mass += pellet.mass;
            deadPellets.add(pellet.id);
          }
        }

        for (const ej of grids.ejected.query(b.x, b.y, r + 14)) {
          if (deadEjected.has(ej.id)) continue;
          if (Math.hypot(ej.x - b.x, ej.y - b.y) < r && ej.ownerId !== pl.id) {
            b.mass += ej.mass;
            deadEjected.add(ej.id);
          }
        }

        for (const virus of grids.viruses.query(b.x, b.y, r + CONFIG.virusRadius + 8)) {
          const d = Math.hypot(virus.x - b.x, virus.y - b.y);
          if (d < r + CONFIG.virusRadius * 0.85 && r > CONFIG.virusBurstThresholdRadius) {
            triggerVirusBurst(pl, b, virus.x, virus.y);
          }
        }
      }
    }

    // cell-vs-cell eating using spatial hash
    const eaten = new Set();
    for (const pl of state.players) {
      for (const b of pl.blobs) {
        if (eaten.has(b.id)) continue;
        const neighbors = grids.blobs.query(b.x, b.y, radiusFromMass(b.mass) + 180);
        for (const n of neighbors) {
          if (n.id === b.id || eaten.has(n.id)) continue;
          if (n.owner.id === b.owner.id) continue;
          let big = b;
          let small = n;
          if (n.mass > b.mass) {
            big = n;
            small = b;
          }
          if (eaten.has(big.id) || eaten.has(small.id)) continue;
          if (canEat(big, small)) {
            big.mass += small.mass;
            eaten.add(small.id);
          }
        }
      }
    }

    if (deadPellets.size) state.pellets = state.pellets.filter((p) => !deadPellets.has(p.id));
    if (deadEjected.size) state.ejected = state.ejected.filter((e) => !deadEjected.has(e.id));

    if (eaten.size) {
      for (const pl of state.players) {
        pl.blobs = pl.blobs.filter((b) => !eaten.has(b.id));
        if (pl.blobs.length === 0) pl.dead = true;
      }
    }

    // virus feeding by ejected mass
    for (const virus of state.viruses) {
      for (const ej of state.ejected) {
        if (Math.hypot(ej.x - virus.x, ej.y - virus.y) < CONFIG.virusRadius + 6) {
          deadEjected.add(ej.id);
          virus.feed++;
          virus.dirX = ej.dirX;
          virus.dirY = ej.dirY;
        }
      }
      if (virus.feed >= CONFIG.virusFeedShots) {
        virus.feed = 0;
        spawnVirus(
          virus.x + virus.dirX * (CONFIG.virusRadius * 1.9),
          virus.y + virus.dirY * (CONFIG.virusRadius * 1.9),
          virus.dirX * CONFIG.virusShotSpeed,
          virus.dirY * CONFIG.virusShotSpeed
        );
      }
    }

    if (deadEjected.size) state.ejected = state.ejected.filter((e) => !deadEjected.has(e.id));

    handleMerging();
  }

  function triggerVirusBurst(player, hitBlob, vx, vy) {
    if (!player.blobs.includes(hitBlob)) return;
    if (player.blobs.length >= CONFIG.maxPiecesPerPlayer) return;

    const availableSlots = CONFIG.maxPiecesPerPlayer - player.blobs.length;
    const splits = Math.max(1, Math.min(availableSlots, Math.floor(hitBlob.mass / 220)));
    if (splits <= 1) return;

    const shareMass = hitBlob.mass / splits;
    hitBlob.mass = shareMass;
    hitBlob.mergeTimer = CONFIG.mergeCooldown;

    for (let i = 1; i < splits; i++) {
      const ang = (i / splits) * TAU + randRange(-0.2, 0.2);
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);
      const child = makeBlob(player, hitBlob.x + nx * 28, hitBlob.y + ny * 28, shareMass);
      child.vx = nx * (CONFIG.splitImpulse * randRange(0.65, 0.95));
      child.vy = ny * (CONFIG.splitImpulse * randRange(0.65, 0.95));
      child.mergeTimer = CONFIG.mergeCooldown;
      player.blobs.push(child);
    }

    const dx = hitBlob.x - vx;
    const dy = hitBlob.y - vy;
    const d = Math.hypot(dx, dy) || 1;
    hitBlob.vx += (dx / d) * 180;
    hitBlob.vy += (dy / d) * 180;
  }

  function handleMerging() {
    for (const pl of state.players) {
      const blobs = pl.blobs;
      for (let i = 0; i < blobs.length; i++) {
        const a = blobs[i];
        for (let j = i + 1; j < blobs.length; j++) {
          const b = blobs[j];
          if (a.mergeTimer > 0 || b.mergeTimer > 0) continue;
          const ra = radiusFromMass(a.mass);
          const rb = radiusFromMass(b.mass);
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < (ra + rb) * 0.55) {
            const bigger = a.mass >= b.mass ? a : b;
            const smaller = bigger === a ? b : a;
            const transfer = Math.min(smaller.mass, smaller.mass * 0.14);
            bigger.mass += transfer;
            smaller.mass -= transfer;
            if (smaller.mass < 35) {
              bigger.mass += smaller.mass;
              blobs.splice(blobs.indexOf(smaller), 1);
              j--;
            }
          }
        }
      }
    }
  }

  function maintainEntities() {
    while (state.pellets.length < CONFIG.pelletTarget) spawnPellet();
    if (state.viruses.length > CONFIG.virusCount + 20) {
      state.viruses = state.viruses.slice(state.viruses.length - (CONFIG.virusCount + 20));
    }

    const livingBots = state.players.filter((p) => p.isBot && !p.dead).length;
    if (livingBots < CONFIG.botCount) {
      const toSpawn = CONFIG.botCount - livingBots;
      for (let i = 0; i < toSpawn; i++) {
        const bot = makePlayer(`Bot-${Math.floor(randRange(100, 999))}`, true, palette());
        bot.blobs.push(makeBlob(bot, randRange(100, CONFIG.worldSize - 100), randRange(100, CONFIG.worldSize - 100), CONFIG.botStartMass));
        state.players.push(bot);
      }
    }

    const human = getHuman();
    if (human && human.blobs.length === 0 && !state.over) {
      state.over = true;
      state.msg = "You were absorbed! Press Restart to play again.";
      state.paused = true;
      showPause(true);
    }
  }

  function tick(dt) {
    if (!state.running || state.paused) return;

    updateHumanInput(dt);
    rebuildGrids();
    updateBots(dt);
    updatePhysics(dt);
    rebuildGrids();
    runCollisions();
    maintainEntities();
    updateCamera();
    refreshHud();
  }

  function refreshHud() {
    const human = getHuman();
    const mass = human ? human.blobs.reduce((s, b) => s + b.mass, 0) : 0;
    scoreEl.textContent = `Mass: ${Math.floor(mass)}`;

    const board = state.players
      .filter((p) => !p.dead)
      .map((p) => ({ name: p.name, mass: p.blobs.reduce((s, b) => s + b.mass, 0) }))
      .sort((a, b) => b.mass - a.mass)
      .slice(0, 10);

    leaderboardList.innerHTML = board
      .map((item) => `<li>${item.name}: ${Math.floor(item.mass)}</li>`)
      .join("");
  }

  function drawGrid() {
    const cam = state.camera;
    const gridGap = 120;
    const left = cam.x - canvas.width / 2 / cam.zoom;
    const top = cam.y - canvas.height / 2 / cam.zoom;
    const right = cam.x + canvas.width / 2 / cam.zoom;
    const bottom = cam.y + canvas.height / 2 / cam.zoom;

    ctx.strokeStyle = "rgba(156, 194, 255, 0.12)";
    ctx.lineWidth = 1 / cam.zoom;

    let startX = Math.floor(left / gridGap) * gridGap;
    let startY = Math.floor(top / gridGap) * gridGap;

    ctx.beginPath();
    for (let x = startX; x <= right; x += gridGap) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = startY; y <= bottom; y += gridGap) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(129, 171, 255, 0.35)";
    ctx.lineWidth = 4 / cam.zoom;
    ctx.strokeRect(0, 0, CONFIG.worldSize, CONFIG.worldSize);
  }

  function drawCircle(x, y, r, color, outline = "rgba(15,20,40,0.65)") {
    const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.12, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.25)");
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.max(2 / state.camera.zoom, r * 0.06);
    ctx.stroke();
  }

  function drawVirus(v) {
    const r = CONFIG.virusRadius;
    const spikes = 20;
    const outer = r;
    const inner = r * 0.78;
    ctx.beginPath();
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * TAU;
      const rr = i % 2 === 0 ? outer : inner;
      const x = v.x + Math.cos(a) * rr;
      const y = v.y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "#4ecf87";
    ctx.fill();
    ctx.strokeStyle = "#1e7f53";
    ctx.lineWidth = 3 / state.camera.zoom;
    ctx.stroke();
  }

  function drawMinimap() {
    const size = CONFIG.minimapSize;
    const pad = 14;
    const x = canvas.width - size - pad;
    const y = pad;
    const scale = size / CONFIG.worldSize;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "rgba(9,14,28,0.7)";
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = "rgba(120,184,255,0.5)";
    ctx.strokeRect(x, y, size, size);

    for (const pl of state.players) {
      if (pl.dead) continue;
      const tm = pl.blobs.reduce((s, b) => s + b.mass, 0);
      const bx = pl.blobs.reduce((s, b) => s + b.x * b.mass, 0) / tm;
      const by = pl.blobs.reduce((s, b) => s + b.y * b.mass, 0) / tm;
      ctx.fillStyle = pl.id === state.playerId ? "#8ed1ff" : "rgba(255,150,150,0.9)";
      ctx.beginPath();
      ctx.arc(x + bx * scale, y + by * scale, pl.id === state.playerId ? 3 : 2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cam = state.camera;
    ctx.setTransform(cam.zoom, 0, 0, cam.zoom, canvas.width / 2 - cam.x * cam.zoom, canvas.height / 2 - cam.y * cam.zoom);

    drawGrid();

    for (const p of state.pellets) drawCircle(p.x, p.y, Math.max(2.8, radiusFromMass(p.mass) * 0.4), p.color, "rgba(0,0,0,0.2)");

    for (const e of state.ejected) drawCircle(e.x, e.y, 7.5, "#e2c26f", "rgba(80,56,12,0.6)");

    for (const v of state.viruses) drawVirus(v);

    const allBlobs = [];
    for (const pl of state.players) {
      if (pl.dead) continue;
      for (const b of pl.blobs) allBlobs.push(b);
    }
    allBlobs.sort((a, b) => a.mass - b.mass);

    for (const b of allBlobs) {
      const r = radiusFromMass(b.mass);
      drawCircle(b.x, b.y, r, b.color);
      if (r > 20) {
        ctx.fillStyle = "#edf6ff";
        ctx.textAlign = "center";
        ctx.font = `${Math.max(12, r * 0.34)}px sans-serif`;
        ctx.fillText(b.owner.name, b.x, b.y - 3);
        ctx.font = `${Math.max(10, r * 0.26)}px sans-serif`;
        ctx.fillStyle = "rgba(236,242,255,0.86)";
        ctx.fillText(Math.floor(b.mass).toString(), b.x, b.y + Math.max(10, r * 0.35));
      }
    }

    drawMinimap();

    if (state.paused && state.running) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "rgba(0,0,0,0.38)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "bold 38px sans-serif";
      ctx.fillText("Paused", canvas.width / 2, canvas.height / 2 - 8);
      if (state.msg) {
        ctx.font = "16px sans-serif";
        ctx.fillStyle = "#d5e4ff";
        ctx.fillText(state.msg, canvas.width / 2, canvas.height / 2 + 26);
      }
      ctx.restore();
    }
  }

  function frame(ts) {
    if (!state.lastTime) state.lastTime = ts;
    const rawDt = Math.min(CONFIG.maxDelta, (ts - state.lastTime) / 1000);
    state.lastTime = ts;
    state.accumulator += rawDt;

    while (state.accumulator >= CONFIG.fixedDt) {
      tick(CONFIG.fixedDt);
      state.accumulator -= CONFIG.fixedDt;
    }

    render();
    requestAnimationFrame(frame);
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function showPause(flag) {
    pauseScreen.classList.toggle("hidden", !flag);
    pauseScreen.classList.toggle("visible", flag);
  }

  function bindInput() {
    window.addEventListener("resize", resize);
    resize();

    canvas.addEventListener("mousemove", (e) => {
      state.mouse.x = e.clientX;
      state.mouse.y = e.clientY;
    });

    window.addEventListener("keydown", (e) => {
      const key = e.key.toLowerCase();
      if (key === "escape") {
        if (!state.running) return;
        state.paused = !state.paused;
        showPause(state.paused);
      }
      if (key === " " || key === "w") e.preventDefault();
      state.keys.add(key);
    });

    window.addEventListener("keyup", (e) => {
      state.keys.delete(e.key.toLowerCase());
    });

    playBtn.addEventListener("click", () => {
      initGame();
      refreshHud();
      startScreen.classList.remove("visible");
      startScreen.classList.add("hidden");
      showPause(false);
    });

    resumeBtn.addEventListener("click", () => {
      state.paused = false;
      showPause(false);
    });

    restartBtn.addEventListener("click", () => {
      initGame();
      showPause(false);
      refreshHud();
    });
  }

  bindInput();
  requestAnimationFrame(frame);
})();
