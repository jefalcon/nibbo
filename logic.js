// Nibbo — lógica pura del juego (sin DOM ni canvas).
// Módulo UMD: funciona en el navegador como `window.Nibbo` (script clásico,
// compatible con apertura directa de index.html vía file://) y en Node con require().

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Nibbo = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Rejilla y laberinto
  // ---------------------------------------------------------------------------
  // Leyenda: '#' seto, '.' semilla de luz, 'o' semilla grande,
  //          ' ' suelo sin semilla, '-' puerta del nido, 'T' túnel lateral.
  // Laberinto original de 21 x 23 con túnel lateral en la fila 11.
  // El nido de polillas ocupa las columnas 8-12 de la fila 10, con puerta en (10,9).
  // Nibbo aparece en (10,12).
  const RAW_MAP = [
    '#####################',
    '#.........#.........#',
    '#.##.###.#.#.###.##.#',
    '#o##.###.#.#.###.##o#',
    '#.##.###.#.#.###.##.#',
    '#...................#',
    '#.##.#.###.###.#.##.#',
    '#.##.....#.#.....##.#',
    '#....#...#.#...#....#',
    '####.#####-#####.####',
    '#......#     #......#',
    'T.......#####.......T',
    '#....###.....###....#',
    '#.##.....#.#.....##.#',
    '#....#...#.#...#....#',
    '#.##.#.###.###.#.##.#',
    '#...................#',
    '#o##.###.#.#.###.##o#',
    '#.##.###.#.#.###.##.#',
    '#.........#.........#',
    '#...................#',
    '#...##.........##...#',
    '#####################',
  ];

  const WALL = '#';
  const TUNNEL_ROW = 11;
  const NEST_ROW = 10;
  const DOOR = { x: 10, y: 9 };
  const NEST_CENTER = { x: 10, y: 10 };
  const NIBBO_SPAWN = { x: 10, y: 12 };

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const DIR_LIST = ['up', 'left', 'down', 'right'];
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  function parseMap(rows) {
    const height = rows.length;
    const width = rows[0].length;
    const grid = rows.map((r) => r.split(''));
    const dots = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const c = grid[y][x];
        if (c === '.' || c === 'o') dots.push({ x, y, power: c === 'o' });
      }
    }
    return {
      width,
      height,
      grid,
      dots,
      tunnelRow: TUNNEL_ROW,
      nestRow: NEST_ROW,
      door: { ...DOOR },
      nestCenter: { ...NEST_CENTER },
      nibboSpawn: { ...NIBBO_SPAWN },
    };
  }

  function inBounds(grid, x, y) {
    return y >= 0 && y < grid.length && x >= 0 && x < grid[0].length;
  }

  function isWalkable(grid, x, y) {
    return inBounds(grid, x, y) && grid[y][x] !== WALL;
  }

  function wrapX(x, w) {
    return ((x % w) + w) % w;
  }

  function stepPos(x, y, dir) {
    return { x: x + DIRS[dir].x, y: y + DIRS[dir].y };
  }

  function canGo(grid, x, y, dir, w) {
    const nx = wrapX(x + DIRS[dir].x, w);
    const ny = y + DIRS[dir].y;
    return isWalkable(grid, nx, ny);
  }

  function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  // ---------------------------------------------------------------------------
  // Polillas: definición de las cuatro personalidades
  // ---------------------------------------------------------------------------
  // - umbra: persigue directamente la casilla de Nibbo.
  // - vela: intenta anticiparse (4 casillas por delante de su dirección).
  // - petra: patrulla sus esquinas en ciclo.
  // - fusa: se mueve de forma errática (azar).
  const MOTHS = [
    { id: 'umbra', name: 'Umbra', kind: 'chase', spawn: { x: 9, y: 10 } },
    { id: 'vela', name: 'Vela', kind: 'ambush', spawn: { x: 11, y: 10 } },
    { id: 'petra', name: 'Petra', kind: 'patrol', spawn: { x: 8, y: 10 } },
    { id: 'fusa', name: 'Fusa', kind: 'erratic', spawn: { x: 12, y: 10 } },
  ];

  const CORNERS = [
    { x: 1, y: 1 },
    { x: 19, y: 1 },
    { x: 19, y: 21 },
    { x: 1, y: 21 },
  ];

  function chaseTarget(nibboPos) {
    return { x: nibboPos.x, y: nibboPos.y };
  }

  function ambushTarget(nibboPos, nibboDir, w, h) {
    const d = DIRS[nibboDir] || DIRS.left;
    const x = Math.min(w - 1, Math.max(0, nibboPos.x + d.x * 4));
    const y = Math.min(h - 1, Math.max(0, nibboPos.y + d.y * 4));
    return { x, y };
  }

  function patrolTarget(corners, idx) {
    return corners[idx % corners.length];
  }

  // Si la polilla ya está cerca de su esquina objetivo, avanza a la siguiente.
  function patrolAdvance(pos, corners, idx) {
    const target = patrolTarget(corners, idx);
    if (manhattan(pos, target) <= 3) return { target, idx: idx + 1 };
    return { target, idx };
  }

  function walkableOptions(grid, x, y, dir, w) {
    const out = [];
    for (const d of DIR_LIST) {
      if (dir && d === OPPOSITE[dir]) continue;
      const nx = wrapX(x + DIRS[d].x, w);
      const ny = y + DIRS[d].y;
      if (isWalkable(grid, nx, ny)) out.push(d);
    }
    return out;
  }

  // Elección voraz de dirección hacia (o huyendo de, con flee:true) el objetivo.
  // Nunca da marcha atrás salvo en callejón sin salida. Devuelve null si no hay salida.
  function chooseDirection(grid, x, y, dir, target, w, opts) {
    const flee = !!(opts && opts.flee);
    let cands = walkableOptions(grid, x, y, dir, w);
    if (cands.length === 0) {
      if (dir) {
        const rev = OPPOSITE[dir];
        const nx = wrapX(x + DIRS[rev].x, w);
        const ny = y + DIRS[rev].y;
        if (isWalkable(grid, nx, ny)) return rev;
      }
      return null;
    }
    if (!target) return cands[0];
    let best = cands[0];
    let bestScore = scoredTarget(grid, x, y, best, target, w);
    for (let i = 1; i < cands.length; i++) {
      const s = scoredTarget(grid, x, y, cands[i], target, w);
      if (flee ? s > bestScore : s < bestScore) {
        best = cands[i];
        bestScore = s;
      }
    }
    return best;
  }

  function scoredTarget(grid, x, y, dir, target, w) {
    const nx = wrapX(x + DIRS[dir].x, w);
    const ny = y + DIRS[dir].y;
    return manhattan({ x: nx, y: ny }, target);
  }

  // Movimiento errático: dirección aleatoria entre las transitables (sin marcha atrás).
  // `rng` es inyectable para que los tests sean deterministas.
  function randomDirection(grid, x, y, dir, w, rng) {
    const cands = walkableOptions(grid, x, y, dir, w);
    if (cands.length === 0) {
      if (dir) {
        const rev = OPPOSITE[dir];
        const nx = wrapX(x + DIRS[rev].x, w);
        const ny = y + DIRS[rev].y;
        if (isWalkable(grid, nx, ny)) return rev;
      }
      return null;
    }
    const r = rng ? rng() : Math.random();
    return cands[Math.floor(r * cands.length) % cands.length];
  }

  // Salida determinista del nido hacia la puerta.
  function exitHouseStep(x, y, door, nestRow) {
    if (y === nestRow) {
      if (x < door.x) return 'right';
      if (x > door.x) return 'left';
      return 'up';
    }
    if (x === door.x && y > door.y) return 'up';
    return null;
  }

  // ---------------------------------------------------------------------------
  // Puntuación, niveles y colisiones
  // ---------------------------------------------------------------------------
  const DOT_SCORE = 10;
  const POWER_SCORE = 50;
  const MOTH_BASE_SCORE = 200;
  const EXTRA_LIFE_AT = 10000;

  function mothScore(comboIndex) {
    // 200, 400, 800, 1600 (tope).
    return Math.min(MOTH_BASE_SCORE * 2 ** comboIndex, 1600);
  }

  // ---------------------------------------------------------------------------
  // Bonus por tiempo y desglose de nivel superado (puros, sin DOM).
  // ---------------------------------------------------------------------------
  // Escala coherente con el resto de puntuación:
  // - TIME_BONUS_MAX (500) = POWER_SCORE x 10 = DOT_SCORE x 50: por debajo
  //   de una cadena completa de polillas (3000) y del total de semillas
  //   del nivel (~2700), para que el tiempo premie sin dominar la partida.
  //   También queda por debajo del tope de una sola polilla (1600).
  // - TIME_BONUS_MIN (50) = POWER_SCORE x 1 = DOT_SCORE x 5: suelo que
  //   garantiza una recompensa mínima por superar el nivel.
  // - TIME_BONUS_PER_SECOND (5) = DOT_SCORE / 2: cada 2 s lentos restan
  //   lo mismo que una semilla pequeña.
  // - TIME_BONUS_PER_LEVEL (25): compensa que los niveles altos son más
  //   rápidos (ver levelConfig); nunca supera el tope explícito.
  const TIME_BONUS_MAX = 500;
  const TIME_BONUS_MIN = 50;
  const TIME_BONUS_PER_SECOND = 5;
  const TIME_BONUS_PER_LEVEL = 25;

  function toCount(n) {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  // Bonus por tiempo de nivel, entero dentro de [minBonus, maxBonus].
  // `elapsedSecs`: segundos tardados (>= 0; NaN/negativo se trata como 0).
  // `level`: como en levelConfig (se normaliza a >= 1 con la misma regla).
  // `opts`: { maxBonus, minBonus, perSecond, perLevel } con topes explícitos;
  // por defecto usa TIME_BONUS_MAX/MIN/PER_SECOND/PER_LEVEL.
  function timeBonus(elapsedSecs, level, opts) {
    const o = opts || {};
    let maxBonus = Number(o.maxBonus);
    if (!Number.isFinite(maxBonus)) maxBonus = TIME_BONUS_MAX;
    let minBonus = Number(o.minBonus);
    if (!Number.isFinite(minBonus)) minBonus = TIME_BONUS_MIN;
    let perSecond = Number(o.perSecond);
    if (!Number.isFinite(perSecond) || perSecond < 0) perSecond = TIME_BONUS_PER_SECOND;
    let perLevel = Number(o.perLevel);
    if (!Number.isFinite(perLevel)) perLevel = TIME_BONUS_PER_LEVEL;
    if (maxBonus < minBonus) {
      const t = maxBonus;
      maxBonus = minBonus;
      minBonus = t;
    }
    let elapsed = Number(elapsedSecs);
    if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;
    let lv = Math.floor(Number(level));
    if (!Number.isFinite(lv) || lv < 1) lv = 1;
    const raw = maxBonus - Math.floor(elapsed) * perSecond + (lv - 1) * perLevel;
    return Math.min(maxBonus, Math.max(minBonus, Math.floor(raw)));
  }

  // Desglose puro de un nivel superado. Suma semillas, grandes, polillas
  // (vía mothScore) y bonus de tiempo (vía timeBonus).
  // Entrada: { dotsEaten, powersEaten, mothCombos, elapsedSecs, level, timeOpts }.
  // - mothCombos: lista de índices de combo (0,1,2,3...) ya limitada por
  //   mothScore; p. ej. comerse 2 polillas en una huida = [0, 1] -> 600.
  // Devuelve: { level, dotsEaten, dots, powersEaten, powers,
  //             moths, time, total, config }.
  function levelClearSummary(input) {
    const inp = input || {};
    const dotsEaten = toCount(inp.dotsEaten);
    const powersEaten = toCount(inp.powersEaten);
    const combos = Array.isArray(inp.mothCombos) ? inp.mothCombos : [];
    let moths = 0;
    for (const c of combos) {
      const idx = Math.floor(Number(c));
      moths += mothScore(Number.isFinite(idx) && idx > 0 ? idx : 0);
    }
    const cfg = levelConfig(inp.level === undefined ? 1 : inp.level);
    const time = timeBonus(inp.elapsedSecs, cfg.level, inp.timeOpts);
    const dots = dotsEaten * DOT_SCORE;
    const powers = powersEaten * POWER_SCORE;
    return {
      level: cfg.level,
      dotsEaten,
      dots,
      powersEaten,
      powers,
      mothsEaten: combos.length,
      moths,
      time,
      total: dots + powers + moths + time,
      config: cfg,
    };
  }

  function levelConfig(level) {
    const lv = Math.max(1, level);
    return {
      level: lv,
      nibboSpeed: Math.min(7 + 0.35 * (lv - 1), 10.5), // casillas por segundo
      mothSpeed: Math.min(6.6 + 0.35 * (lv - 1), 10),
      frightTime: Math.max(1.5, 6 - 0.8 * (lv - 1)), // segundos de huida
      eyesSpeed: 11,
    };
  }

  function sameTile(a, b) {
    return a.x === b.x && a.y === b.y;
  }

  // Semillas restantes (pequeñas + grandes). Puro, sin DOM.
  // Acepta Map (clave -> 'dot'/'power'/boolean), Set, array u objeto
  // plano; nulo/indefinido o tipos no colección devuelven 0.
  function remainingSeeds(dots) {
    if (!dots) return 0;
    if (dots instanceof Map) return dots.size;
    if (dots instanceof Set) return dots.size;
    if (Array.isArray(dots)) return dots.length;
    if (typeof dots === 'object') return Object.keys(dots).length;
    return 0;
  }

  // Parpadeo del contador de semillas cuando quedan pocas. Puro, sin DOM.
  function shouldBlinkSeeds(count) {
    return typeof count === 'number' && Number.isFinite(count) && count < 10;
  }

  // Cruce del umbral de "pocas semillas" (<10). Puro, sin DOM.
  // Devuelve true solo al pasar de >=10 a <10 (para el aviso sonoro único).
  function crossedLowSeeds(prevCount, nextCount) {
    return (
      typeof prevCount === 'number' && Number.isFinite(prevCount) &&
      typeof nextCount === 'number' && Number.isFinite(nextCount) &&
      prevCount >= 10 && nextCount < 10
    );
  }

  // ---------------------------------------------------------------------------
  // Mejor tiempo por nivel (en memoria; sin DOM ni localStorage).
  // ---------------------------------------------------------------------------
  // `records` vive en memoria; game.js lo hidrata desde localStorage
  // al arrancar y persiste cada mejora al superar el nivel. Claves
  // aisladas por nivel normalizado (entero >= 1, como en timeBonus).
  const records = {};

  function toLevel(n) {
    const lv = Math.floor(Number(n));
    return Number.isFinite(lv) && lv >= 1 ? lv : 1;
  }

  function toMillis(ms) {
    const v = Number(ms);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }

  // Mejor tiempo guardado para el nivel (ms) o null si aún no hay marca.
  function getRecord(nivel) {
    const v = records[toLevel(nivel)];
    return typeof v === 'number' ? v : null;
  }

  // Guarda `ms` si es el primer tiempo del nivel o mejora el récord;
  // tiempos inválidos (NaN, negativos, no numéricos) se ignoran.
  // Devuelve el récord vigente (ms) o null si no hay marca.
  function recordTime(nivel, ms) {
    const v = toMillis(ms);
    if (v === null) return getRecord(nivel);
    const lv = toLevel(nivel);
    const prev = records[lv];
    if (typeof prev !== 'number' || v < prev) records[lv] = v;
    return records[lv];
  }

  return {
    RAW_MAP,
    WALL,
    TUNNEL_ROW,
    NEST_ROW,
    DOOR,
    NEST_CENTER,
    NIBBO_SPAWN,
    DIRS,
    DIR_LIST,
    OPPOSITE,
    MOTHS,
    CORNERS,
    DOT_SCORE,
    POWER_SCORE,
    MOTH_BASE_SCORE,
    EXTRA_LIFE_AT,
    TIME_BONUS_MAX,
    TIME_BONUS_MIN,
    TIME_BONUS_PER_SECOND,
    TIME_BONUS_PER_LEVEL,
    parseMap,
    inBounds,
    isWalkable,
    wrapX,
    stepPos,
    canGo,
    manhattan,
    chaseTarget,
    ambushTarget,
    patrolTarget,
    patrolAdvance,
    walkableOptions,
    chooseDirection,
    randomDirection,
    exitHouseStep,
    mothScore,
    levelConfig,
    timeBonus,
    levelClearSummary,
    sameTile,
    remainingSeeds,
    shouldBlinkSeeds,
    crossedLowSeeds,
    getRecord,
    recordTime,
  };
});
