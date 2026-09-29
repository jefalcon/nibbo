const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../logic.js');
const P = L.parseMap(L.RAW_MAP);

describe('mapa', () => {
  test('dimensiones 21x23 y filas uniformes', () => {
    assert.equal(P.width, 21);
    assert.equal(P.height, 23);
    for (const row of L.RAW_MAP) assert.equal(row.length, 21);
  });

  test('cuatro semillas grandes y más de cien pequeñas', () => {
    const powers = P.dots.filter((d) => d.power);
    const smalls = P.dots.filter((d) => !d.power);
    assert.equal(powers.length, 4);
    assert.ok(smalls.length > 100, `pocas semillas: ${smalls.length}`);
  });

  test('borde cerrado salvo el túnel lateral', () => {
    for (let x = 0; x < P.width; x++) {
      assert.equal(P.grid[0][x], '#');
      assert.equal(P.grid[P.height - 1][x], '#');
    }
    for (let y = 0; y < P.height; y++) {
      if (y === P.tunnelRow) {
        assert.equal(P.grid[y][0], 'T');
        assert.equal(P.grid[y][P.width - 1], 'T');
      } else {
        assert.equal(P.grid[y][0], '#');
        assert.equal(P.grid[y][P.width - 1], '#');
      }
    }
  });

  test('spawns, puerta y nido transitables', () => {
    assert.ok(L.isWalkable(P.grid, P.nibboSpawn.x, P.nibboSpawn.y));
    assert.ok(L.isWalkable(P.grid, P.door.x, P.door.y));
    assert.ok(L.isWalkable(P.grid, P.nestCenter.x, P.nestCenter.y));
    for (const m of L.MOTHS) {
      assert.ok(L.isWalkable(P.grid, m.spawn.x, m.spawn.y), m.id);
    }
  });

  test('todas las semillas alcanzables desde Nibbo (flood fill)', () => {
    const seen = new Set([P.nibboSpawn.x + ',' + P.nibboSpawn.y]);
    const q = [{ ...P.nibboSpawn }];
    while (q.length) {
      const c = q.pop();
      for (const d of L.DIR_LIST) {
        const nx = L.wrapX(c.x + L.DIRS[d].x, P.width);
        const ny = c.y + L.DIRS[d].y;
        const k = nx + ',' + ny;
        if (!seen.has(k) && L.isWalkable(P.grid, nx, ny)) {
          seen.add(k);
          q.push({ x: nx, y: ny });
        }
      }
    }
    const missing = P.dots.filter((d) => !seen.has(d.x + ',' + d.y));
    assert.deepEqual(missing, []);
  });
});

describe('movimiento en rejilla', () => {
  test('wrapX envuelve ambos bordes', () => {
    assert.equal(L.wrapX(-1, 21), 20);
    assert.equal(L.wrapX(21, 21), 0);
    assert.equal(L.wrapX(5, 21), 5);
  });

  test('el túnel conecta ambos extremos', () => {
    const y = P.tunnelRow;
    assert.ok(L.canGo(P.grid, 0, y, 'left', P.width));
    assert.ok(L.canGo(P.grid, P.width - 1, y, 'right', P.width));
  });

  test('canGo respeta los setos', () => {
    // (1,1) con muro encima y a la izquierda, libre a derecha y abajo.
    assert.equal(L.canGo(P.grid, 1, 1, 'up', P.width), false);
    assert.equal(L.canGo(P.grid, 1, 1, 'left', P.width), false);
    assert.equal(L.canGo(P.grid, 1, 1, 'right', P.width), true);
    assert.equal(L.canGo(P.grid, 1, 1, 'down', P.width), true);
  });

  test('stepPos y manhattan', () => {
    assert.deepEqual(L.stepPos(3, 4, 'right'), { x: 4, y: 4 });
    assert.deepEqual(L.stepPos(3, 4, 'up'), { x: 3, y: 3 });
    assert.equal(L.manhattan({ x: 1, y: 1 }, { x: 4, y: 5 }), 7);
  });
});

describe('IA de las polillas', () => {
  test('umbra persigue la casilla exacta de Nibbo', () => {
    assert.deepEqual(L.chaseTarget({ x: 7, y: 3 }), { x: 7, y: 3 });
  });

  test('vela se anticipa 4 casillas según la dirección', () => {
    assert.deepEqual(L.ambushTarget({ x: 10, y: 10 }, 'left', 21, 23), { x: 6, y: 10 });
    assert.deepEqual(L.ambushTarget({ x: 10, y: 10 }, 'up', 21, 23), { x: 10, y: 6 });
    assert.deepEqual(L.ambushTarget({ x: 10, y: 10 }, 'right', 21, 23), { x: 14, y: 10 });
    assert.deepEqual(L.ambushTarget({ x: 10, y: 10 }, 'down', 21, 23), { x: 10, y: 14 });
  });

  test('vela recorta al borde del jardín', () => {
    assert.deepEqual(L.ambushTarget({ x: 1, y: 1 }, 'left', 21, 23), { x: 0, y: 1 });
    assert.deepEqual(L.ambushTarget({ x: 10, y: 21 }, 'down', 21, 23), { x: 10, y: 22 });
  });

  test('petra patrulla sus esquinas en ciclo', () => {
    const c = L.CORNERS;
    assert.deepEqual(L.patrolTarget(c, 0), { x: 1, y: 1 });
    assert.deepEqual(L.patrolTarget(c, 4), { x: 1, y: 1 });
    // Lejos: mantiene objetivo. Cerca (<=3): avanza al siguiente.
    let r = L.patrolAdvance({ x: 10, y: 10 }, c, 0);
    assert.deepEqual(r, { target: { x: 1, y: 1 }, idx: 0 });
    r = L.patrolAdvance({ x: 2, y: 2 }, c, 0);
    assert.deepEqual(r, { target: { x: 1, y: 1 }, idx: 1 });
    assert.deepEqual(L.patrolTarget(c, r.idx), { x: 19, y: 1 });
  });

  test('chooseDirection avanza hacia el objetivo sin marcha atrás', () => {
    // Pasillo horizontal en la fila del túnel: yendo a la derecha hacia x=18.
    const dir = L.chooseDirection(P.grid, 3, 11, 'right', { x: 18, y: 11 }, P.width);
    assert.equal(dir, 'right');
  });

  test('chooseDirection con flee se aleja del objetivo', () => {
    // Cruce en (4,9)? Uso un cruce abierto: (10,12) con Nibbo encima -> huir.
    const dir = L.chooseDirection(P.grid, 10, 12, 'up', { x: 10, y: 12 }, P.width, { flee: true });
    // Desde (10,12) las salidas son left/right/down (no reverse=down? dir=up -> excluye down).
    // Huyendo de (10,12), debe elegir left o right (distancia 1 > quedarse no es opción).
    assert.ok(dir === 'left' || dir === 'right', `dir=${dir}`);
  });

  test('chooseDirection da la vuelta en callejón sin salida', () => {
    // Mini-rejilla con un único callejón: entrando hacia la izquierda, revierte.
    const grid = [['#', '#', '#'], ['#', '.', '.'], ['#', '#', '#']];
    const dir = L.chooseDirection(grid, 1, 1, 'left', { x: 9, y: 9 }, 3);
    assert.equal(dir, 'right');
  });

  test('chooseDirection sin objetivo devuelve una opción válida', () => {
    const dir = L.chooseDirection(P.grid, 10, 12, 'up', null, P.width);
    assert.ok(['up', 'left', 'right'].includes(dir), `dir=${dir}`);
  });

  test('fusa es determinista con rng inyectado', () => {
    const a = L.randomDirection(P.grid, 10, 12, 'up', P.width, () => 0);
    const b = L.randomDirection(P.grid, 10, 12, 'up', P.width, () => 0.999);
    // Opciones sin marcha atrás desde (10,12) con dir up: up? (10,11) es muro -> [left, right].
    assert.equal(a, 'left');
    assert.equal(b, 'right');
  });

  test('exitHouseStep sale hacia la puerta', () => {
    assert.equal(L.exitHouseStep(8, 10, P.door, P.nestRow), 'right');
    assert.equal(L.exitHouseStep(12, 10, P.door, P.nestRow), 'left');
    assert.equal(L.exitHouseStep(10, 10, P.door, P.nestRow), 'up');
    assert.equal(L.exitHouseStep(5, 5, P.door, P.nestRow), null);
  });
});

describe('puntuación, niveles y colisiones', () => {
  test('valores de semilla y combo de polillas con tope', () => {
    assert.equal(L.DOT_SCORE, 10);
    assert.equal(L.POWER_SCORE, 50);
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].map((i) => L.mothScore(i)),
      [200, 400, 800, 1600, 1600, 1600]
    );
  });

  test('los niveles aceleran y la huida se acorta con mínimo', () => {
    const l1 = L.levelConfig(1);
    const l3 = L.levelConfig(3);
    const l99 = L.levelConfig(99);
    assert.ok(l3.nibboSpeed > l1.nibboSpeed);
    assert.ok(l3.mothSpeed > l1.mothSpeed);
    assert.ok(l3.frightTime < l1.frightTime);
    assert.equal(l99.frightTime, 1.5);
    assert.ok(l99.nibboSpeed <= 10.5 && l99.mothSpeed <= 10);
  });

  test('sameTile detecta colisiones', () => {
    assert.equal(L.sameTile({ x: 1, y: 2 }, { x: 1, y: 2 }), true);
    assert.equal(L.sameTile({ x: 1, y: 2 }, { x: 1, y: 3 }), false);
  });

  test('cuatro polillas con IA distinta', () => {
    const kinds = L.MOTHS.map((m) => m.kind).sort();
    assert.deepEqual(kinds, ['ambush', 'chase', 'erratic', 'patrol']);
  });
});

describe('cambio de nivel (HUD)', () => {
  test('subir un nivel cambia la configuración (1 -> 2)', () => {
    const l1 = L.levelConfig(1);
    const l2 = L.levelConfig(2);
    assert.equal(l2.level, 2);
    assert.ok(l2.nibboSpeed > l1.nibboSpeed);
    assert.ok(l2.mothSpeed > l1.mothSpeed);
    assert.ok(l2.frightTime < l1.frightTime);
  });

  test('el nivel expuesto coincide con el nivel pedido', () => {
    for (const lv of [1, 2, 5]) {
      assert.equal(L.levelConfig(lv).level, lv);
    }
  });

  test('niveles inválidos se fijan en 1', () => {
    for (const lv of [0, -1, -99]) {
      assert.deepEqual(L.levelConfig(lv), L.levelConfig(1));
    }
  });

  test('la velocidad de ojos es constante entre niveles', () => {
    assert.equal(L.levelConfig(1).eyesSpeed, 11);
    assert.equal(L.levelConfig(5).eyesSpeed, 11);
    assert.equal(L.levelConfig(99).eyesSpeed, 11);
  });

  test('los topes se mantienen al subir muy arriba (98 -> 99)', () => {
    const a = L.levelConfig(98);
    const b = L.levelConfig(99);
    assert.equal(b.frightTime, 1.5);
    assert.ok(b.nibboSpeed <= 10.5 && b.mothSpeed <= 10);
    assert.ok(b.nibboSpeed >= a.nibboSpeed);
    assert.ok(b.mothSpeed >= a.mothSpeed);
  });
});

describe('bonus por tiempo', () => {
  test('tope: nivel instantáneo da el máximo', () => {
    assert.equal(L.TIME_BONUS_MAX, 500);
    assert.equal(L.timeBonus(0, 1), 500);
  });

  test('decae 5 puntos por segundo y trunca el medio segundo', () => {
    assert.equal(L.TIME_BONUS_PER_SECOND, 5);
    assert.equal(L.timeBonus(10, 1), 450);
    assert.equal(L.timeBonus(1.9, 1), 495);
  });

  test('suelo: un nivel muy lento da el mínimo', () => {
    assert.equal(L.TIME_BONUS_MIN, 50);
    assert.equal(L.timeBonus(200, 1), 50);
    assert.equal(L.timeBonus(10000, 99), 50);
  });

  test('nivel: compensa niveles altos sin superar el tope', () => {
    assert.equal(L.TIME_BONUS_PER_LEVEL, 25);
    assert.equal(L.timeBonus(20, 1), 400);
    assert.equal(L.timeBonus(20, 2), 425);
    assert.equal(L.timeBonus(0, 3), 500);
  });

  test('nivel inválido se normaliza a 1', () => {
    assert.equal(L.timeBonus(10, 0), L.timeBonus(10, 1));
    assert.equal(L.timeBonus(10, -4), L.timeBonus(10, 1));
    assert.equal(L.timeBonus(10, NaN), L.timeBonus(10, 1));
  });

  test('tiempo inválido se trata como 0', () => {
    assert.equal(L.timeBonus(-5, 1), 500);
    assert.equal(L.timeBonus(NaN, 1), 500);
    assert.equal(L.timeBonus(undefined, 1), 500);
  });

  test('opts personalizados', () => {
    assert.equal(L.timeBonus(10, 1, { perSecond: 10 }), 400);
    assert.equal(
      L.timeBonus(10, 1, { maxBonus: 1000, minBonus: 0, perSecond: 10, perLevel: 100 }),
      900
    );
    assert.equal(L.timeBonus(10, 2, { perLevel: 100 }), 500);
  });

  test('opts con topes invertidos se intercambian', () => {
    assert.equal(L.timeBonus(0, 1, { maxBonus: 10, minBonus: 100 }), 100);
  });

  test('opts inválidos usan los valores por defecto', () => {
    assert.equal(L.timeBonus(10, 1, { perSecond: -3 }), 450);
    assert.equal(L.timeBonus(10, 1, { perSecond: NaN }), 450);
    assert.equal(L.timeBonus(0, 1, { maxBonus: NaN, minBonus: NaN }), 500);
  });
});

describe('desglose de nivel superado', () => {
  test('desglose y total de un nivel típico', () => {
    const s = L.levelClearSummary({
      dotsEaten: 10,
      powersEaten: 2,
      mothCombos: [0, 1],
      elapsedSecs: 0,
      level: 1,
    });
    assert.equal(s.dotsEaten, 10);
    assert.equal(s.dots, 100);
    assert.equal(s.powersEaten, 2);
    assert.equal(s.powers, 100);
    assert.equal(s.moths, 600);
    assert.equal(s.time, 500);
    assert.equal(s.total, 1300);
    assert.equal(s.level, 1);
  });

  test('total es la suma del desglose', () => {
    const s = L.levelClearSummary({
      dotsEaten: 7,
      powersEaten: 1,
      mothCombos: [0, 1, 2, 3],
      elapsedSecs: 20,
      level: 2,
    });
    assert.equal(s.dots, 70);
    assert.equal(s.powers, 50);
    assert.equal(s.moths, 3000);
    assert.equal(s.time, L.timeBonus(20, 2));
    assert.equal(s.total, s.dots + s.powers + s.moths + s.time);
  });

  test('entrada vacía da ceros con bonus máximo', () => {
    const s = L.levelClearSummary({});
    assert.equal(s.dots, 0);
    assert.equal(s.powers, 0);
    assert.equal(s.moths, 0);
    assert.equal(s.time, 500);
    assert.equal(s.total, 500);
    assert.equal(s.level, 1);
    assert.deepEqual(s.config, L.levelConfig(1));
  });

  test('conteos inválidos o fraccionarios se normalizan', () => {
    const s = L.levelClearSummary({ dotsEaten: 2.7, powersEaten: -3, elapsedSecs: 0, level: 1 });
    assert.equal(s.dotsEaten, 2);
    assert.equal(s.dots, 20);
    assert.equal(s.powersEaten, 0);
    assert.equal(s.powers, 0);
    const t = L.levelClearSummary({ dotsEaten: NaN, powersEaten: 'x', elapsedSecs: 0, level: 1 });
    assert.equal(t.dots, 0);
    assert.equal(t.powers, 0);
  });

  test('combos inválidos cuentan como primera polilla', () => {
    const s = L.levelClearSummary({
      mothCombos: [NaN, -1, 'x', 1.9],
      elapsedSecs: 0,
      level: 1,
    });
    assert.equal(s.moths, 200 + 200 + 200 + 400);
  });

  test('expone mothsEaten (típico N, vacío 0, combos inválidos 0)', () => {
    const tipico = L.levelClearSummary({ mothCombos: [0, 1, 2], elapsedSecs: 0, level: 1 });
    assert.equal(tipico.mothsEaten, 3);
    assert.equal(L.levelClearSummary({}).mothsEaten, 0);
    assert.equal(L.levelClearSummary({ mothCombos: [], elapsedSecs: 0, level: 1 }).mothsEaten, 0);
    for (const bad of [null, 'x', 42, { length: 2 }]) {
      assert.equal(
        L.levelClearSummary({ mothCombos: bad, elapsedSecs: 0, level: 1 }).mothsEaten,
        0
      );
    }
  });

  test('respeta timeOpts y el nivel pedido', () => {
    const s = L.levelClearSummary({
      elapsedSecs: 10,
      level: 1,
      timeOpts: { perSecond: 10 },
    });
    assert.equal(s.time, 400);
    assert.equal(s.total, s.dots + s.powers + s.moths + s.time);
    const l0 = L.levelClearSummary({ elapsedSecs: 0, level: 0 });
    assert.equal(l0.level, 1);
  });
});

describe('semillas restantes', () => {
  test('Map cuenta pequeñas y grandes por igual', () => {
    const m = new Map([
      ['1,1', 'dot'],
      ['2,2', 'power'],
      ['3,3', true],
    ]);
    assert.equal(L.remainingSeeds(m), 3);
    assert.equal(L.remainingSeeds(new Map()), 0);
  });

  test('objeto plano cuenta sus claves', () => {
    assert.equal(L.remainingSeeds({ '1,1': 'dot', '2,2': 'power' }), 2);
    assert.equal(L.remainingSeeds({}), 0);
  });

  test('array cuenta sus elementos', () => {
    assert.equal(L.remainingSeeds([{ x: 1, y: 1 }, { x: 2, y: 2, power: true }]), 2);
    assert.equal(L.remainingSeeds([]), 0);
  });

  test('nulo o indefinido devuelve 0', () => {
    assert.equal(L.remainingSeeds(null), 0);
    assert.equal(L.remainingSeeds(undefined), 0);
  });

  test('tipos no colección devuelven 0', () => {
    assert.equal(L.remainingSeeds(42), 0);
    assert.equal(L.remainingSeeds('dot'), 0);
  });
});

describe('parpadeo del contador de semillas', () => {
  test('parpadea con 9 y con 0', () => {
    assert.equal(L.shouldBlinkSeeds(9), true);
    assert.equal(L.shouldBlinkSeeds(0), true);
  });

  test('no parpadea con 10 o más', () => {
    assert.equal(L.shouldBlinkSeeds(10), false);
    assert.equal(L.shouldBlinkSeeds(11), false);
    assert.equal(L.shouldBlinkSeeds(100), false);
  });

  test('negativos parpadean', () => {
    assert.equal(L.shouldBlinkSeeds(-1), true);
  });

  test('no numéricos, NaN e Infinity no parpadean', () => {
    assert.equal(L.shouldBlinkSeeds('9'), false);
    assert.equal(L.shouldBlinkSeeds(NaN), false);
    assert.equal(L.shouldBlinkSeeds(Infinity), false);
    assert.equal(L.shouldBlinkSeeds(-Infinity), false);
    assert.equal(L.shouldBlinkSeeds(null), false);
    assert.equal(L.shouldBlinkSeeds(undefined), false);
  });
});

describe('cruce del umbral de pocas semillas', () => {
  test('cruza de 10 a 9', () => {
    assert.equal(L.crossedLowSeeds(10, 9), true);
  });

  test('cruza desde más arriba o hasta más abajo', () => {
    assert.equal(L.crossedLowSeeds(11, 9), true);
    assert.equal(L.crossedLowSeeds(10, 0), true);
    assert.equal(L.crossedLowSeeds(100, 9), true);
    assert.equal(L.crossedLowSeeds(10, -1), true);
  });

  test('no cruza si se queda en 10 o más', () => {
    assert.equal(L.crossedLowSeeds(11, 10), false);
    assert.equal(L.crossedLowSeeds(10, 10), false);
    assert.equal(L.crossedLowSeeds(100, 50), false);
  });

  test('no cruza si ya estaba por debajo', () => {
    assert.equal(L.crossedLowSeeds(9, 8), false);
    assert.equal(L.crossedLowSeeds(9, 9), false);
    assert.equal(L.crossedLowSeeds(0, 0), false);
    assert.equal(L.crossedLowSeeds(5, 0), false);
  });

  test('no cruza al subir de vuelta a 10 o más', () => {
    assert.equal(L.crossedLowSeeds(9, 10), false);
    assert.equal(L.crossedLowSeeds(8, 11), false);
  });

  test('no numéricos, NaN e Infinity no cruzan', () => {
    assert.equal(L.crossedLowSeeds('10', 9), false);
    assert.equal(L.crossedLowSeeds(10, '9'), false);
    assert.equal(L.crossedLowSeeds(NaN, 9), false);
    assert.equal(L.crossedLowSeeds(10, NaN), false);
    assert.equal(L.crossedLowSeeds(Infinity, 9), false);
    assert.equal(L.crossedLowSeeds(10, Infinity), false);
    assert.equal(L.crossedLowSeeds(-Infinity, 9), false);
    assert.equal(L.crossedLowSeeds(10, -Infinity), false);
    assert.equal(L.crossedLowSeeds(null, 9), false);
    assert.equal(L.crossedLowSeeds(10, null), false);
    assert.equal(L.crossedLowSeeds(undefined, undefined), false);
  });
});

describe('mejor tiempo por nivel', () => {
  // Niveles altos y distintos por caso: el almacén vive en memoria
  // compartida durante la sesión y los niveles inválidos caen al 1.
  test('primer tiempo guarda el récord', () => {
    assert.equal(L.getRecord(101), null);
    assert.equal(L.recordTime(101, 95000), 95000);
    assert.equal(L.getRecord(101), 95000);
  });

  test('una mejora sobrescribe el récord', () => {
    assert.equal(L.recordTime(102, 120000), 120000);
    assert.equal(L.recordTime(102, 90000), 90000);
    assert.equal(L.getRecord(102), 90000);
  });

  test('un tiempo peor (o igual) no cambia el récord', () => {
    assert.equal(L.recordTime(103, 80000), 80000);
    assert.equal(L.recordTime(103, 150000), 80000);
    assert.equal(L.recordTime(103, 80000), 80000);
    assert.equal(L.getRecord(103), 80000);
  });

  test('los niveles están aislados', () => {
    assert.equal(L.recordTime(104, 70000), 70000);
    assert.equal(L.recordTime(105, 110000), 110000);
    assert.equal(L.recordTime(104, 65000), 65000);
    assert.equal(L.getRecord(104), 65000);
    assert.equal(L.getRecord(105), 110000);
  });

  test('tiempos inválidos se ignoran', () => {
    assert.equal(L.getRecord(106), null);
    for (const bad of [NaN, -1, -999.5, 'x', '-5', undefined, {}, Infinity, -Infinity]) {
      assert.equal(L.recordTime(106, bad), null);
    }
    assert.equal(L.getRecord(106), null);
    // Un inválido tampoco borra ni empeora un récord existente.
    assert.equal(L.recordTime(107, 60000), 60000);
    assert.equal(L.recordTime(107, NaN), 60000);
    assert.equal(L.recordTime(107, -5), 60000);
    assert.equal(L.recordTime(107, 'x'), 60000);
    assert.equal(L.getRecord(107), 60000);
  });
});
