// Nibbo — controlador de navegador: bucle, render en canvas, entrada, sonido y HUD.
// Script clásico (sin módulos) para que index.html funcione abriendo el archivo.
// Requiere window.Nibbo (logic.js).
(function () {
  'use strict';

  const L = window.Nibbo;
  if (!L) throw new Error('Nibbo: falta logic.js');

  const TILE = 24;
  const W = 21;
  const H = 23;
  const PXW = W * TILE;
  const PXH = H * TILE;

  const P = L.parseMap(L.RAW_MAP);
  const wrap = (x) => L.wrapX(x, W);
  const canGo = (x, y, d) => L.canGo(P.grid, x, y, d, W);
  const cx = (tx) => tx * TILE + TILE / 2;
  const cy = (ty) => ty * TILE + TILE / 2;
  const tkey = (x, y) => x + ',' + y;

  const MOTH_STYLE = {
    umbra: '#ff6a5e',
    vela: '#3fd9d9',
    petra: '#b07aff',
    fusa: '#ffb0e3',
  };

  // ---------------------------------------------------------------------------
  // Sonido: WebAudio sin assets, se inicializa con el primer gesto del jugador.
  // ---------------------------------------------------------------------------
  const Sfx = {
    ctx: null,
    wakaHigh: false,
    muted: false,
    ensure() {
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) this.ctx = new AC();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { /* sin audio, el juego sigue */ }
    },
    toggleMute() {
      this.muted = !this.muted;
      saveMute();
      updateMuteBtn();
      return this.muted;
    },
    tone(freq, dur, type, vol, delay, slideTo) {
      if (this.muted || !this.ctx) return;
      const t0 = this.ctx.currentTime + (delay || 0);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(vol || 0.08, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    dot() {
      this.wakaHigh = !this.wakaHigh;
      this.tone(this.wakaHigh ? 540 : 390, 0.06, 'square', 0.05);
    },
    power() { this.tone(180, 0.35, 'sawtooth', 0.07, 0, 720); },
    moth() {
      this.tone(300, 0.09, 'square', 0.09);
      this.tone(450, 0.09, 'square', 0.09, 0.08);
      this.tone(680, 0.14, 'square', 0.09, 0.16);
    },
    death() {
      for (let i = 0; i < 5; i++) this.tone(420 - i * 70, 0.14, 'triangle', 0.1, i * 0.13);
    },
    clear() {
      [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.1, i * 0.12));
    },
    start() {
      [392, 523, 659].forEach((f, i) => this.tone(f, 0.12, 'square', 0.07, i * 0.1));
    },
    extra() {
      [660, 880, 1320].forEach((f, i) => this.tone(f, 0.12, 'sine', 0.1, i * 0.09));
    },
    gameover() {
      [330, 262, 196].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.1, i * 0.2));
    },
    hurry() {
      this.tone(880, 0.08, 'square', 0.09);
      this.tone(1174, 0.12, 'square', 0.09, 0.08);
    },
  };

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------
  const S = {
    phase: 'title', // title | ready | play | dying | clear | gameover
    paused: false,
    score: 0,
    lives: 3,
    level: 1,
    best: 0,
    extraGiven: false,
    fright: 0,
    combo: 0,
    cfg: L.levelConfig(1),
    dots: new Map(),
    nibbo: null,
    moths: [],
    readyT: 0,
    deathT: 0,
    clearT: 0,
    time: 0,
    levelTime: 0,
    stats: { dots: 0, powers: 0, combos: [] },
    clearSummary: null,
    clearRaf: 0,
    hurryPlayed: false,
    lastTimeMs: null,
    newRecord: false,
  };

  const CLEAR_DUR = 5;

  function resetLevelStats() {
    S.levelTime = 0;
    S.stats = { dots: 0, powers: 0, combos: [] };
    S.clearSummary = null;
    S.lastTimeMs = null;
    S.newRecord = false;
    stopClearCount();
    hideRecordToast();
  }

  function stopClearCount() {
    if (S.clearRaf) {
      try { window.cancelAnimationFrame(S.clearRaf); } catch (e) {}
      S.clearRaf = 0;
    }
  }

  try {
    S.best = parseInt(window.localStorage.getItem('nibbo-best') || '0', 10) || 0;
  } catch (e) { S.best = 0; }

  function saveBest() {
    try { window.localStorage.setItem('nibbo-best', String(S.best)); } catch (e) {}
  }

  // Silencio: persiste 'nibbo-muted' como '1'/'0'; por defecto con sonido.
  const MUTE_KEY = 'nibbo-muted';

  function loadMute() {
    try {
      Sfx.muted = window.localStorage.getItem(MUTE_KEY) === '1';
    } catch (e) { Sfx.muted = false; }
    return Sfx.muted;
  }

  function saveMute() {
    try { window.localStorage.setItem(MUTE_KEY, Sfx.muted ? '1' : '0'); } catch (e) {}
  }

  loadMute();

  // ---------------------------------------------------------------------------
  // Mejor tiempo por nivel: persistencia en localStorage por nivel.
  // ---------------------------------------------------------------------------
  // Clave por nivel ('nibbo-best-time-<nivel>'), distinta de 'nibbo-best'
  // (récord de puntos global). La fuente de verdad en memoria vive en
  // logic.js (L.getRecord / L.recordTime); aquí solo se carga al iniciar
  // y se guarda al superar un nivel. Todo envuelto en try/catch para que
  // file:// y el modo privado sin localStorage sigan jugables.
  const TIME_KEY_PREFIX = 'nibbo-best-time-';

  function timeKey(level) {
    let lv = Math.floor(Number(level));
    if (!Number.isFinite(lv) || lv < 1) lv = 1;
    return TIME_KEY_PREFIX + lv;
  }

  function formatTime(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
    const tenths = Math.floor(ms / 100);
    const m = Math.floor(tenths / 600);
    const s = Math.floor((tenths % 600) / 10);
    const t = tenths % 10;
    return m + ':' + String(s).padStart(2, '0') + '.' + t;
  }

  // Carga un nivel concreto de localStorage a la memoria de logic.js.
  // Cadenas vacías o solo-blancos se tratan como "sin marca": Number('')
  // es 0 y grabaría un falso récord de 0 ms.
  function loadTimeRecord(level) {
    try {
      const raw = window.localStorage.getItem(timeKey(level));
      if (raw === null || raw === undefined) return L.getRecord(level);
      if (typeof raw === 'string' && raw.trim() === '') return L.getRecord(level);
      return L.recordTime(level, Number(raw));
    } catch (e) {
      return L.getRecord(level);
    }
  }

  // Carga inicial: vuelca todas las claves de tiempo a logic.js.
  // El sufijo debe ser un nivel canónico (entero >= 1 sin ceros ni
  // extras: '2-extra' o '-1' se ignoran) y cada clave se aísla en su
  // propio try para que una lectura mala no aborte el resto.
  function loadAllTimeRecords() {
    try {
      const ls = window.localStorage;
      const n = ls.length;
      for (let i = 0; i < n; i++) {
        try {
          const k = ls.key(i);
          if (!k || k.indexOf(TIME_KEY_PREFIX) !== 0) continue;
          const suffix = k.slice(TIME_KEY_PREFIX.length);
          if (!/^[1-9]\d*$/.test(suffix)) continue;
          const raw = ls.getItem(k);
          if (raw === null || raw === undefined) continue;
          if (typeof raw === 'string' && raw.trim() === '') continue;
          L.recordTime(Number(suffix), Number(raw));
        } catch (e) { /* clave ilegible, sigue con la siguiente */ }
      }
    } catch (e) { /* sin persistencia, el juego sigue */ }
  }

  // Guarda solo marcas válidas (número finito >= 0); nunca persiste
  // 'null', 'NaN' o negativos que contaminarían la próxima carga.
  function saveTimeRecord(level, ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    try { window.localStorage.setItem(timeKey(level), String(ms)); } catch (e) {}
  }

  loadAllTimeRecords();
  loadTimeRecord(S.level);

  function buildDots() {
    S.dots = new Map(P.dots.map((d) => [tkey(d.x, d.y), d.power ? 'power' : 'dot']));
    S.hurryPlayed = false;
  }

  function makeNibbo() {
    const s = P.nibboSpawn;
    return { fx: s.x, fy: s.y, tx: s.x, ty: s.y, t: 1, dir: 'left', nextDir: 'left', x: cx(s.x), y: cy(s.y) };
  }

  function makeMoths(stagger) {
    return L.MOTHS.map((def, i) => ({
      def,
      fx: def.spawn.x, fy: def.spawn.y, tx: def.spawn.x, ty: def.spawn.y, t: 1,
      dir: 'up', state: 'nest', nestTimer: stagger ? 1 + i * 1.4 : 0,
      cornerIdx: i % L.CORNERS.length,
      x: cx(def.spawn.x), y: cy(def.spawn.y),
    }));
  }

  function resetPositions(stagger) {
    S.nibbo = makeNibbo();
    S.moths = makeMoths(stagger);
    S.fright = 0;
    S.combo = 0;
  }

  // Avance suave por casillas con modelo origen -> destino y progreso t.
  // Devuelve 'arrived' | 'moving' | 'stopped'.
  function advance(e, dt, tps) {
    if (!e.dir) return 'stopped';
    if (e.t >= 1) {
      const nx = wrap(e.tx + L.DIRS[e.dir].x);
      const ny = e.ty + L.DIRS[e.dir].y;
      if (!L.isWalkable(P.grid, nx, ny)) {
        e.dir = null;
        return 'stopped';
      }
      e.fx = e.tx; e.fy = e.ty; e.tx = nx; e.ty = ny; e.t = 0;
    }
    e.t += tps * dt;
    if (e.t >= 1) {
      e.t = 1;
      e.x = cx(e.tx); e.y = cy(e.ty);
      return 'arrived';
    }
    let x0 = cx(e.fx);
    let x1 = cx(e.tx);
    if (Math.abs(x1 - x0) > (PXW / 2)) {
      if (x1 > x0) x1 -= PXW; else x1 += PXW;
    }
    let x = x0 + (x1 - x0) * e.t;
    x = ((x % PXW) + PXW) % PXW;
    e.x = x;
    e.y = cy(e.fy) + (cy(e.ty) - cy(e.fy)) * e.t;
    return 'moving';
  }

  function nibTile() {
    return { x: S.nibbo.tx, y: S.nibbo.ty };
  }

  // ---------------------------------------------------------------------------
  // Actualización
  // ---------------------------------------------------------------------------
  function eatAt(x, y) {
    const k = tkey(x, y);
    const v = S.dots.get(k);
    if (!v) return;
    const prev = L.remainingSeeds(S.dots);
    S.dots.delete(k);
    const next = L.remainingSeeds(S.dots);
    if (!S.hurryPlayed && L.crossedLowSeeds(prev, next)) {
      S.hurryPlayed = true;
      Sfx.hurry();
    }
    if (v === 'power') {
      S.stats.powers++;
      S.score += L.POWER_SCORE;
      S.fright = S.cfg.frightTime;
      S.combo = 0;
      Sfx.power();
    } else {
      S.stats.dots++;
      S.score += L.DOT_SCORE;
      Sfx.dot();
    }
    if (S.score > S.best) { S.best = S.score; saveBest(); }
    if (!S.extraGiven && S.score >= L.EXTRA_LIFE_AT) {
      S.extraGiven = true;
      S.lives++;
      Sfx.extra();
    }
    if (S.dots.size === 0) {
      beginClear();
    }
  }

  // Nivel superado: desglose puro de logic.js; solo el bonus de tiempo es
  // puntos nuevos (semillas y polillas ya se sumaron al comerlas).
  function beginClear() {
    stopClearCount();
    S.phase = 'clear';
    S.clearT = CLEAR_DUR;
    S.clearSummary = L.levelClearSummary({
      dotsEaten: S.stats.dots,
      powersEaten: S.stats.powers,
      mothCombos: S.stats.combos.slice(),
      elapsedSecs: S.levelTime,
      level: S.level,
    });
    S.score += S.clearSummary.time;
    const elapsedMs = Math.round(S.levelTime * 1000);
    const prevRec = L.getRecord(S.level);
    const bestRec = L.recordTime(S.level, elapsedMs);
    S.lastTimeMs = elapsedMs;
    S.newRecord = prevRec === null || elapsedMs < prevRec;
    if (S.newRecord && bestRec !== null) saveTimeRecord(S.level, bestRec);
    if (S.score > S.best) { S.best = S.score; saveBest(); }
    if (!S.extraGiven && S.score >= L.EXTRA_LIFE_AT) {
      S.extraGiven = true;
      S.lives++;
      Sfx.extra();
    }
    Sfx.clear();
    updateOverlay();
    startClearCount();
    if (S.newRecord) flashRecordToast(elapsedMs);
  }

  function updateNibbo(dt) {
    const n = S.nibbo;
    if (n.nextDir && n.dir && n.nextDir === L.OPPOSITE[n.dir] && n.t < 1) {
      const sx = n.fx, sy = n.fy;
      n.fx = n.tx; n.fy = n.ty; n.tx = sx; n.ty = sy;
      n.t = 1 - n.t;
      n.dir = n.nextDir;
    }
    if (n.t >= 1) {
      eatAt(n.tx, n.ty);
      if (S.phase !== 'play') return;
      if (n.nextDir && n.nextDir !== n.dir && canGo(n.tx, n.ty, n.nextDir)) n.dir = n.nextDir;
    }
    advance(n, dt, S.cfg.nibboSpeed);
  }

  function mothThink(m) {
    const t = { x: m.tx, y: m.ty };
    if (m.state === 'nest') {
      if (m.nestTimer > 0) { m.dir = null; return; }
      if (t.x === P.door.x && t.y === P.door.y) { m.state = 'out'; return; }
      m.dir = L.exitHouseStep(t.x, t.y, P.door, P.nestRow) || 'up';
      return;
    }
    if (m.state === 'eyes') {
      if (t.x === P.nestCenter.x && t.y === P.nestCenter.y) {
        m.state = 'nest'; m.nestTimer = 1.6; m.dir = 'up';
        return;
      }
      if (t.x === P.door.x && t.y === P.door.y) { m.dir = 'down'; return; }
      m.dir = L.chooseDirection(P.grid, t.x, t.y, m.dir, P.door, W) || null;
      return;
    }
    // Fuera del nido: IA propia de cada polilla (o huida).
    if (S.fright > 0) {
      m.dir = L.chooseDirection(P.grid, t.x, t.y, m.dir, nibTile(), W, { flee: true }) || null;
      return;
    }
    let target = null;
    if (m.def.kind === 'chase') {
      target = L.chaseTarget(nibTile());
    } else if (m.def.kind === 'ambush') {
      target = L.ambushTarget(nibTile(), S.nibbo.dir || 'left', W, H);
    } else if (m.def.kind === 'patrol') {
      const r = L.patrolAdvance(t, L.CORNERS, m.cornerIdx);
      m.cornerIdx = r.idx;
      target = r.target;
    } else {
      m.dir = L.randomDirection(P.grid, t.x, t.y, m.dir, W, Math.random);
      return;
    }
    m.dir = L.chooseDirection(P.grid, t.x, t.y, m.dir, target, W) || null;
  }

  function mothSpeed(m) {
    if (m.state === 'eyes') return S.cfg.eyesSpeed;
    if (S.fright > 0 && m.state === 'out') return S.cfg.mothSpeed * 0.62;
    return S.cfg.mothSpeed;
  }

  function updateMoths(dt) {
    for (const m of S.moths) {
      if (m.state === 'nest' && m.nestTimer > 0) {
        m.nestTimer -= dt;
        continue;
      }
      if (m.t >= 1) mothThink(m);
      advance(m, dt, mothSpeed(m));
    }
  }

  function checkCollisions() {
    const n = S.nibbo;
    for (const m of S.moths) {
      if (m.state !== 'out') continue;
      const same = L.sameTile({ x: n.tx, y: n.ty }, { x: m.tx, y: m.ty });
      const near = Math.hypot(n.x - m.x, n.y - m.y) < TILE * 0.55;
      if (!same && !near) continue;
      if (S.fright > 0) {
        S.stats.combos.push(S.combo);
        S.score += L.mothScore(S.combo);
        S.combo++;
        if (S.score > S.best) { S.best = S.score; saveBest(); }
        m.state = 'eyes';
        Sfx.moth();
      } else {
        S.phase = 'dying';
        S.deathT = 1.4;
        Sfx.death();
        updateOverlay();
        return;
      }
    }
  }

  function update(dt) {
    S.time += dt;
    if (S.phase === 'ready') {
      S.readyT -= dt;
      if (S.readyT <= 0) { S.phase = 'play'; updateOverlay(); }
      updateHUD(); // récord del nivel visible también en ready y tras subir de nivel
      return;
    }
    if (S.phase === 'dying') {
      S.deathT -= dt;
      if (S.deathT <= 0) {
        S.lives--;
        if (S.lives <= 0) {
          S.phase = 'gameover';
          Sfx.gameover();
        } else {
          resetPositions(false);
          S.phase = 'ready';
          S.readyT = 1.6;
        }
        updateOverlay();
      }
      return;
    }
    if (S.phase === 'clear') {
      S.clearT -= dt;
      if (S.clearT <= 0) {
        stopClearCount();
        S.level++;
        loadTimeRecord(S.level);
        S.cfg = L.levelConfig(S.level);
        buildDots();
        resetPositions(true);
        resetLevelStats();
        S.phase = 'ready';
        S.readyT = 2;
        updateOverlay();
      }
      return;
    }
    if (S.phase !== 'play') return;
    S.levelTime += dt;
    if (S.fright > 0) {
      S.fright -= dt;
      if (S.fright <= 0) { S.fright = 0; S.combo = 0; }
    }
    updateNibbo(dt);
    if (S.phase !== 'play') return; // comer la última semilla cambia de fase
    updateMoths(dt);
    checkCollisions();
    updateHUD();
  }

  // ---------------------------------------------------------------------------
  // Dibujo en canvas (sin assets externos)
  // ---------------------------------------------------------------------------
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const staticLayer = document.createElement('canvas');
  staticLayer.width = PXW;
  staticLayer.height = PXH;

  function hash2(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  }

  function prerenderStatic() {
    const g = staticLayer.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 0, PXH);
    bg.addColorStop(0, '#0a1c13');
    bg.addColorStop(1, '#0d2417');
    g.fillStyle = bg;
    g.fillRect(0, 0, PXW, PXH);
    // Suelo: sutil moteado de jardín.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (P.grid[y][x] === '#') continue;
        if (hash2(x, y) > 0.86) {
          g.fillStyle = 'rgba(46, 110, 66, 0.35)';
          g.fillRect(x * TILE + 6, y * TILE + 6, 3, 3);
        }
      }
    }
    // Setos.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (P.grid[y][x] !== '#') continue;
        const px = x * TILE, py = y * TILE;
        g.fillStyle = '#16452a';
        g.beginPath();
        g.roundRect(px + 1, py + 1, TILE - 2, TILE - 2, 6);
        g.fill();
        g.fillStyle = '#2c8a4e';
        g.fillRect(px + 4, py + 3, TILE - 8, 3);
        g.fillStyle = '#1f6b3c';
        for (let i = 0; i < 3; i++) {
          const hx = px + 5 + hash2(x * 3 + i, y) * (TILE - 10);
          const hy = py + 9 + hash2(x, y * 3 + i) * (TILE - 14);
          g.beginPath();
          g.arc(hx, hy, 2, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    // Puerta del nido.
    g.fillStyle = '#c9a227';
    g.fillRect(cx(P.door.x) - 10, cy(P.door.y) - 3, 20, 6);
    g.fillStyle = '#7a5f14';
    for (let i = -1; i <= 1; i++) g.fillRect(cx(P.door.x) + i * 7 - 1, cy(P.door.y) - 6, 2, 12);
    // Marcas del túnel.
    g.fillStyle = 'rgba(255, 233, 163, 0.5)';
    for (const [tx, flip] of [[0, false], [W - 1, true]]) {
      const y = cy(P.tunnelRow);
      const x = flip ? tx * TILE + 6 : tx * TILE + TILE - 6;
      g.beginPath();
      g.moveTo(x + (flip ? 6 : -6), y - 6);
      g.lineTo(x + (flip ? -2 : 2), y);
      g.lineTo(x + (flip ? 6 : -6), y + 6);
      g.closePath();
      g.fill();
    }
  }

  function drawDots(time) {
    for (const [k, v] of S.dots) {
      const [sx, sy] = k.split(',').map(Number);
      const x = cx(sx), y = cy(sy);
      if (v === 'power') {
        const r = 5.5 + Math.sin(time * 5) * 1.5;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r + 8);
        glow.addColorStop(0, 'rgba(255, 240, 180, 0.9)');
        glow.addColorStop(1, 'rgba(255, 240, 180, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r + 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffedb0';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#ffe9a3';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawNibbo(time) {
    const n = S.nibbo;
    if (S.phase === 'dying') {
      const k = Math.max(0.01, S.deathT / 1.4);
      ctx.save();
      ctx.globalAlpha = k;
      ctx.fillStyle = '#ffd94d';
      ctx.beginPath();
      ctx.arc(n.x, n.y, 10 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    const halo = ctx.createRadialGradient(n.x, n.y, 2, n.x, n.y, 26);
    halo.addColorStop(0, 'rgba(255, 205, 90, 0.55)');
    halo.addColorStop(1, 'rgba(255, 205, 90, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(n.x, n.y, 26, 0, Math.PI * 2);
    ctx.fill();
    // Cuerpo de farolillo.
    ctx.fillStyle = '#ffd94d';
    ctx.beginPath();
    ctx.arc(n.x, n.y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff9d3c';
    ctx.beginPath();
    ctx.arc(n.x, n.y - 3, 10, Math.PI * 1.1, Math.PI * 1.9);
    ctx.fill();
    // Antenas.
    ctx.strokeStyle = '#ff9d3c';
    ctx.lineWidth = 1.5;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(n.x + s * 4, n.y - 8);
      ctx.lineTo(n.x + s * 7, n.y - 13);
      ctx.stroke();
      ctx.fillStyle = '#fff3c4';
      ctx.beginPath();
      ctx.arc(n.x + s * 7, n.y - 13, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // Cara orientada.
    const d = L.DIRS[n.dir] || L.DIRS.left;
    const ex = d.x * 3, ey = d.y * 3;
    const moving = n.dir && S.phase === 'play';
    const open = moving ? 0.25 + Math.abs(Math.sin(time * 12)) * 0.5 : 0.15;
    ctx.fillStyle = '#3a2a10';
    ctx.beginPath();
    ctx.arc(n.x + d.x * 6 + ex * 0.4, n.y + d.y * 6 - 3 + ey * 0.4, open * 8 + 1.5, 0, Math.PI * 2);
    ctx.fill();
    // Ojos.
    ctx.fillStyle = '#fff';
    for (const s of [-1, 1]) {
      const ox = n.x - d.y * s * 5 + d.x * 2;
      const oy = n.y + d.x * s * 5 + d.y * 2 - 4;
      ctx.beginPath();
      ctx.arc(ox, oy, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(ox + ex * 0.5, oy + ey * 0.5, 1.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
    }
  }

  function drawMoth(m, time) {
    const frightened = S.fright > 0 && m.state === 'out';
    const flash = frightened && S.fright < 1.5 && Math.floor(time * 8) % 2 === 0;
    if (m.state === 'eyes') {
      drawEyes(m.x, m.y, '#fff', '#c33');
      return;
    }
    const body = flash ? '#e8ecff' : frightened ? '#3a6df0' : '#2a2138';
    const wing = flash ? '#ffffff' : frightened ? '#9db9ff' : MOTH_STYLE[m.def.id];
    const flap = Math.sin(time * 18 + m.def.spawn.x) * 0.55;
    ctx.save();
    ctx.globalAlpha = m.state === 'nest' ? 0.95 : 1;
    // Alas.
    ctx.fillStyle = wing;
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(s * (0.5 + flap * 0.5));
      ctx.beginPath();
      ctx.ellipse(s * 8, -2, 7, 4.5, s * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // Cuerpo de sombra.
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(m.x, m.y + 1, 5.5, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // Antenas en plumero.
    ctx.strokeStyle = body;
    ctx.lineWidth = 1.5;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(m.x + s * 2, m.y - 5);
      ctx.lineTo(m.x + s * 5, m.y - 10);
      ctx.stroke();
    }
    if (frightened) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(m.x - 2.5, m.y - 1, 1.8, 0, Math.PI * 2);
      ctx.arc(m.x + 2.5, m.y - 1, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(m.x - 4, m.y + 4);
      for (let i = 0; i < 4; i++) ctx.lineTo(m.x - 2 + i * 2, m.y + 4 + (i % 2 ? -1.5 : 1.5));
      ctx.stroke();
    } else {
      const d = L.DIRS[m.dir] || L.DIRS.left;
      drawEyes(m.x + d.x * 1.5, m.y - 1 + d.y * 1.5, '#fff', '#e33');
    }
    ctx.restore();
  }

  function drawEyes(x, y, white, pupil) {
    ctx.fillStyle = white;
    ctx.beginPath();
    ctx.arc(x - 2.5, y, 2.2, 0, Math.PI * 2);
    ctx.arc(x + 2.5, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pupil;
    ctx.beginPath();
    ctx.arc(x - 2.5, y, 1.1, 0, Math.PI * 2);
    ctx.arc(x + 2.5, y, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  function render(time) {
    ctx.drawImage(staticLayer, 0, 0);
    drawDots(time);
    for (const m of S.moths) drawMoth(m, time);
    drawNibbo(time);
    if (S.fright > 0 && S.phase === 'play') {
      ctx.fillStyle = 'rgba(120, 160, 255, 0.08)';
      ctx.fillRect(0, 0, PXW, PXH);
    }
  }

  // ---------------------------------------------------------------------------
  // HUD, overlays y flujo de juego
  // ---------------------------------------------------------------------------
  const el = (id) => document.getElementById(id);

  let lastHudLevel = S.level;

  function updateHUD() {
    el('hud-score').textContent = S.score;
    el('hud-best').textContent = S.best;
    const recEl = el('hud-record');
    if (recEl) recEl.textContent = formatTime(L.getRecord(S.level));
    const seedsLeft = L.remainingSeeds(S.dots);
    const seedsEl = el('hud-seeds');
    seedsEl.textContent = seedsLeft;
    seedsEl.classList.toggle('blink', L.shouldBlinkSeeds(seedsLeft));
    const levelEl = el('hud-level');
    levelEl.textContent = S.level;
    if (S.level !== lastHudLevel) {
      lastHudLevel = S.level;
      levelEl.classList.remove('level-pop');
      void levelEl.offsetWidth;
      levelEl.classList.add('level-pop');
    }
    el('hud-lives').textContent = '●'.repeat(Math.max(0, Math.min(9, S.lives)));
  }

  function updateMuteBtn() {
    const btn = el('btn-mute');
    if (!btn) return;
    btn.textContent = Sfx.muted ? 'Activar sonido (M)' : 'Silenciar (M)';
    if (btn.setAttribute) btn.setAttribute('aria-pressed', String(Sfx.muted));
  }

  // Aviso breve al batir el mejor tiempo del nivel. UN solo gancho:
  // beginClear lo dispara una vez (no clearBreakdownHTML, que se
  // re-ejecuta en cada pintado del overlay). Contenido: '¡Récord!'
  // + tiempo con formatTime; se oculta solo a los ~2.5 s o al
  // cambiar de nivel (resetLevelStats). El empate no avisa porque
  // S.newRecord usa < estricto.
  const RECORD_TOAST_MS = 2500;
  let recordToastTimer = 0;

  function hideRecordToast() {
    if (recordToastTimer) {
      try {
        if (typeof window.clearTimeout === 'function') window.clearTimeout(recordToastTimer);
      } catch (e) {}
      recordToastTimer = 0;
    }
    const toast = el('record-toast');
    if (toast) toast.classList.add('hidden');
  }

  function flashRecordToast(ms) {
    hideRecordToast();
    const toast = el('record-toast');
    if (!toast) return;
    toast.textContent = '¡Récord! ' + formatTime(ms);
    toast.classList.remove('hidden');
    toast.classList.remove('record-pop');
    void toast.offsetWidth;
    toast.classList.add('record-pop');
    try {
      if (typeof window.setTimeout === 'function') {
        recordToastTimer = window.setTimeout(hideRecordToast, RECORD_TOAST_MS);
      }
    } catch (e) { recordToastTimer = 0; }
  }

  function clearBreakdownHTML() {
    const s = S.clearSummary;
    if (!s) return 'Preparando el siguiente nivel…';
    const row = (label, key, value) =>
      '<div class="clear-row"><span>' + label + '</span>' +
      '<span data-clear-key="' + key + '">0</span></div>';
    let html =
      '<div class="clear-rows">' +
      row('Semillas × ' + s.dotsEaten, 'dots', s.dots) +
      row('Grandes × ' + s.powersEaten, 'powers', s.powers) +
      row('Polillas × ' + s.mothsEaten, 'moths', s.moths) +
      row('Bonus tiempo', 'time', s.time) +
      '<div class="clear-row total"><span>Total nivel</span>' +
      '<span data-clear-key="total">0</span></div>' +
      '</div>';
    if (typeof S.lastTimeMs === 'number') {
      const rec = L.getRecord(S.level);
      html += '<p class="clear-next">Tu tiempo ' + formatTime(S.lastTimeMs);
      if (rec !== null) html += ' · récord ' + formatTime(rec);
      html += '</p>';
      if (S.newRecord) html += '<p class="clear-next">¡Nuevo récord de tiempo!</p>';
    }
    html += '<p class="clear-next">Siguiente nivel en camino…</p>';
    return html;
  }

  // Recuento animado con rAF: cada fila cuenta de 0 a su valor con un
  // desfase escalonado. Sin movimiento si el usuario prefiere reducirlo.
  function startClearCount() {
    stopClearCount();
    const s = S.clearSummary;
    if (!s) return;
    const nodes = Array.from(document.querySelectorAll('[data-clear-key]'));
    if (!nodes.length) return;
    const targets = nodes.map((n) => ({
      node: n,
      key: n.getAttribute('data-clear-key'),
      target: Number(s[n.getAttribute('data-clear-key')]) || 0,
    }));
    let reduced = false;
    try {
      reduced = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { reduced = false; }
    if (reduced) {
      for (const t of targets) t.node.textContent = String(t.target);
      updateHUD();
      return;
    }
    const DUR = 700;
    const STAGGER = 180;
    const t0 = (window.performance && window.performance.now) ?
      window.performance.now() : Date.now();
    const tick = (now) => {
      if (S.phase !== 'clear') return;
      const t = (now || t0) - t0;
      let done = true;
      targets.forEach((item, i) => {
        const local = Math.min(1, Math.max(0, (t - i * STAGGER) / DUR));
        if (local < 1) done = false;
        const eased = 1 - Math.pow(1 - local, 2);
        item.node.textContent = String(Math.round(item.target * eased));
      });
      updateHUD();
      if (!done) {
        S.clearRaf = window.requestAnimationFrame(tick);
      } else {
        S.clearRaf = 0;
        for (const item of targets) item.node.textContent = String(item.target);
        updateHUD();
      }
    };
    S.clearRaf = window.requestAnimationFrame(tick);
  }

  function updateOverlay() {
    const ov = el('overlay');
    const title = el('overlay-title');
    const text = el('overlay-text');
    const btn = el('btn-start');
    updateHUD();
    const show = (t, h, btnLabel) => {
      title.textContent = t;
      h ? (text.innerHTML = h, text.style.display = 'block') : (text.style.display = 'none');
      btn.textContent = btnLabel;
      btn.style.display = 'inline-block';
      ov.classList.remove('hidden');
    };
    if (S.paused && (S.phase === 'play' || S.phase === 'ready')) {
      show('Pausa', 'Pulsa P para seguir.', 'Seguir');
      return;
    }
    if (S.phase === 'title') {
      show(
        'NIBBO',
        'El bichito-farol del jardín.<br>Flechas o WASD para moverte · swipe en móvil · P pausa.<br>Come las 4 semillas grandes y caza polillas.',
        'Jugar'
      );
    } else if (S.phase === 'ready') {
      const rec = L.getRecord(S.level);
      let readyText = S.lives + ' vidas · récord ' + S.best;
      if (rec !== null) readyText += ' · mejor tiempo ' + formatTime(rec);
      show('Nivel ' + S.level, readyText, '¡Vamos!');
      btn.style.display = 'none';
    } else if (S.phase === 'clear') {
      show('¡Nivel ' + S.level + ' superado!', clearBreakdownHTML(), '¡Vamos!');
      btn.style.display = 'none';
    } else if (S.phase === 'gameover') {
      show('Fin del juego', S.score + ' puntos · récord ' + S.best, 'Otra vez');
    } else {
      ov.classList.add('hidden');
    }
  }

  function startGame() {
    S.score = 0;
    S.lives = 3;
    S.level = 1;
    loadTimeRecord(S.level);
    S.extraGiven = false;
    S.cfg = L.levelConfig(1);
    S.paused = false;
    resetLevelStats();
    buildDots();
    resetPositions(true);
    S.phase = 'ready';
    S.readyT = 2;
    Sfx.ensure();
    Sfx.start();
    updateOverlay();
  }

  function confirm() {
    Sfx.ensure();
    if (S.phase === 'title' || S.phase === 'gameover') startGame();
    else if (S.paused) togglePause();
  }

  function togglePause() {
    if (S.phase !== 'play' && S.phase !== 'ready') return;
    S.paused = !S.paused;
    updateOverlay();
  }

  function setDir(d) {
    if (S.nibbo) S.nibbo.nextDir = d;
  }

  // ---------------------------------------------------------------------------
  // Entrada: teclado + swipe
  // ---------------------------------------------------------------------------
  const KEY_DIRS = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
  };

  document.addEventListener('keydown', (ev) => {
    if (KEY_DIRS[ev.code]) {
      setDir(KEY_DIRS[ev.code]);
      Sfx.ensure();
      if (S.phase === 'play') ev.preventDefault();
    } else if (ev.code === 'KeyP') {
      togglePause();
    } else if (ev.code === 'KeyM') {
      Sfx.toggleMute();
    } else if (ev.code === 'Enter' || ev.code === 'Space') {
      confirm();
      ev.preventDefault();
    }
  });

  let touchStart = null;
  cv.addEventListener('touchstart', (ev) => {
    Sfx.ensure();
    const t = ev.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });

  cv.addEventListener('touchend', (ev) => {
    if (!touchStart) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.hypot(dx, dy) < 24) {
      confirm(); // toque corto: empezar / seguir
    } else if (Math.abs(dx) > Math.abs(dy)) {
      setDir(dx > 0 ? 'right' : 'left');
    } else {
      setDir(dy > 0 ? 'down' : 'up');
    }
    touchStart = null;
  }, { passive: true });
  cv.addEventListener('touchmove', (ev) => ev.preventDefault(), { passive: false });

  el('btn-start').addEventListener('click', confirm);
  el('btn-pause').addEventListener('click', () => { Sfx.ensure(); togglePause(); });
  el('btn-mute').addEventListener('click', () => { Sfx.toggleMute(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.phase === 'play' && !S.paused) togglePause();
  });
  window.addEventListener('blur', () => {
    if (S.phase === 'play' && !S.paused) togglePause();
  });

  // ---------------------------------------------------------------------------
  // Bucle principal
  // ---------------------------------------------------------------------------
  let last = 0;
  function frame(ts) {
    window.requestAnimationFrame(frame);
    const dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    if (!S.paused) update(dt);
    render(S.time);
  }

  buildDots();
  resetPositions(false);
  prerenderStatic();
  updateHUD();
  updateMuteBtn();
  updateOverlay();
  window.requestAnimationFrame(frame);

  // Gancho mínimo para la prueba de humo (no es parte del juego).
  window.__nibbo = { state: S, update, start: startGame, parse: P };
})();
