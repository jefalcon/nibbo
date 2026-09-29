const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Persistencia del mejor-tiempo-por-nivel: estos tests ejercen el camino
// REAL de game.js (loadAllTimeRecords/loadTimeRecord/saveTimeRecord y el
// guardado al superar un nivel), no una reimplementación. Cada arranque
// carga el game.js auténtico con un DOM/localStorage mínimos y una
// instancia fresca de logic.js, así que son deterministas y aislados.

const GAME_SRC = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');

// localStorage falso con semántica WebStorage: cadenas, null si falta.
class FakeStorage {
  constructor(seed = {}) {
    this.m = new Map();
    for (const [k, v] of Object.entries(seed)) this.m.set(String(k), String(v));
  }
  get length() {
    return this.m.size;
  }
  key(i) {
    const ks = [...this.m.keys()];
    return Number.isInteger(i) && i >= 0 && i < ks.length ? ks[i] : null;
  }
  getItem(k) {
    k = String(k);
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(String(k), String(v));
  }
  removeItem(k) {
    this.m.delete(String(k));
  }
  clear() {
    this.m.clear();
  }
}

function ctxStub() {
  const gradient = { addColorStop() {} };
  const target = {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => gradient;
      }
      if (prop === 'canvas') return {};
      return () => {};
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  });
}

function elStub() {
  return {
    textContent: '',
    innerHTML: '',
    offsetWidth: 0,
    width: 0,
    height: 0,
    style: {},
    classList: { toggle() {}, remove() {}, add() {} },
    addEventListener() {},
    getContext: () => ctxStub(),
  };
}

function documentStub() {
  const els = new Map();
  return {
    getElementById(id) {
      if (!els.has(id)) els.set(id, elStub());
      return els.get(id);
    },
    createElement() {
      return elStub();
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    hidden: false,
  };
}

// Arranca el game.js real. Cada llamada obtiene una logic.js fresca
// (récords en memoria aislados) y expone el gancho window.__nibbo.
function boot({ seed, storage, noStorage } = {}) {
  const logicPath = require.resolve('../logic.js');
  delete require.cache[logicPath];
  const L = require('../logic.js');
  const store = storage !== undefined ? storage : new FakeStorage(seed);
  const win = {
    Nibbo: L,
    addEventListener() {},
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
  };
  if (!noStorage) win.localStorage = store;
  new Function('window', 'document', GAME_SRC)(win, documentStub());
  return { L, store, win, nibbo: win.__nibbo };
}

// Supera el nivel actual por el camino real del juego: comer la última
// semilla dispara beginClear, que registra y persiste la marca.
// dt=0 para que levelTime quede en los segundos exactos pedidos.
function finishLevel(nibbo, secs) {
  const S = nibbo.state;
  S.levelTime = secs;
  S.stats = { dots: 5, powers: 1, combos: [] };
  const n = S.nibbo;
  S.dots = new Map([[n.tx + ',' + n.ty, 'dot']]);
  S.phase = 'play';
  S.paused = false;
  nibbo.update(0);
  return S;
}

describe('persistencia del mejor tiempo (localStorage)', () => {
  test('una marca canónica se hidrata al arrancar', () => {
    const { L, store } = boot({ seed: { 'nibbo-best-time-3': '95000' } });
    assert.equal(L.getRecord(3), 95000);
    assert.equal(store.getItem('nibbo-best-time-3'), '95000');
  });

  test('varias claves se hidratan aisladas por nivel', () => {
    const { L } = boot({
      seed: { 'nibbo-best-time-1': '60000', 'nibbo-best-time-2': '120000' },
    });
    assert.equal(L.getRecord(1), 60000);
    assert.equal(L.getRecord(2), 120000);
    assert.equal(L.getRecord(3), null);
  });

  test('superar un nivel persiste la marca y un rearranque la recupera', () => {
    const { L, store, nibbo } = boot({});
    const S = finishLevel(nibbo, 95.5);
    assert.equal(S.phase, 'clear');
    assert.equal(S.newRecord, true);
    assert.equal(L.getRecord(1), 95500);
    assert.equal(store.getItem('nibbo-best-time-1'), '95500');
    // Round-trip real: lógica fresca + mismo almacén -> récord presente.
    const again = boot({ storage: store });
    assert.equal(again.L.getRecord(1), 95500);
  });

  test('un peor tiempo no sobrescribe lo persistido', () => {
    const { L, store, nibbo } = boot({ seed: { 'nibbo-best-time-1': '60000' } });
    assert.equal(L.getRecord(1), 60000);
    const S = finishLevel(nibbo, 95);
    assert.equal(S.newRecord, false);
    assert.equal(L.getRecord(1), 60000);
    assert.equal(store.getItem('nibbo-best-time-1'), '60000');
  });

  test('una mejora sí sobrescribe lo persistido', () => {
    const { L, store, nibbo } = boot({ seed: { 'nibbo-best-time-2': '120000' } });
    nibbo.state.level = 2;
    const S = finishLevel(nibbo, 90);
    assert.equal(S.newRecord, true);
    assert.equal(L.getRecord(2), 90000);
    assert.equal(store.getItem('nibbo-best-time-2'), '90000');
  });

  test('blancos e inválidos se ignoran (nunca un falso 0)', () => {
    const { L } = boot({
      seed: {
        'nibbo-best-time-1': '',
        'nibbo-best-time-2': '   ',
        'nibbo-best-time-3': 'NaN',
        'nibbo-best-time-4': 'abc',
        'nibbo-best-time-5': '-5',
        'nibbo-best-time-6': 'Infinity',
        'nibbo-best-time-7': '45000',
      },
    });
    for (const lv of [1, 2, 3, 4, 5, 6]) assert.equal(L.getRecord(lv), null);
    assert.equal(L.getRecord(7), 45000);
  });

  test('un getItem que devuelve undefined se trata como sin marca', () => {
    const store = new FakeStorage({ 'nibbo-best-time-1': '30000' });
    store.getItem = () => undefined;
    const { L } = boot({ storage: store });
    assert.equal(L.getRecord(1), null);
  });

  test('claves no canónicas se ignoran', () => {
    const { L } = boot({
      seed: {
        'nibbo-best-time-0': '5000',
        'nibbo-best-time-02': '5000',
        'nibbo-best-time-2-extra': '5000',
        'nibbo-best-time--1': '5000',
        'nibbo-best-time-': '5000',
        'nibbo-best-time-x': '5000',
        'nibbo-best': '9999',
        'nibbo-best-time-3': '45000',
      },
    });
    assert.equal(L.getRecord(1), null);
    assert.equal(L.getRecord(2), null);
    assert.equal(L.getRecord(3), 45000);
  });

  test('sobrevive sin localStorage, también al superar un nivel', () => {
    const { L, nibbo } = boot({ noStorage: true });
    assert.equal(L.getRecord(1), null);
    const S = finishLevel(nibbo, 80);
    assert.equal(S.phase, 'clear');
    assert.equal(L.getRecord(1), 80000);
    assert.equal(S.newRecord, true);
  });

  test('sobrevive si localStorage lanza (modo privado)', () => {
    const throwing = {
      get length() {
        throw new Error('denegado');
      },
      key() {
        throw new Error('denegado');
      },
      getItem() {
        throw new Error('denegado');
      },
      setItem() {
        throw new Error('denegado');
      },
    };
    const { L, nibbo } = boot({ storage: throwing });
    assert.equal(L.getRecord(1), null);
    const S = finishLevel(nibbo, 70);
    assert.equal(S.phase, 'clear');
    assert.equal(L.getRecord(1), 70000);
  });

  test('lo persistido nunca es basura (null, NaN, vacíos, negativos)', () => {
    const { store, nibbo } = boot({});
    finishLevel(nibbo, 100);
    nibbo.state.level = 2;
    finishLevel(nibbo, 50);
    assert.equal(store.getItem('nibbo-best-time-1'), '100000');
    assert.equal(store.getItem('nibbo-best-time-2'), '50000');
    for (const [k, v] of store.m) {
      if (!k.startsWith('nibbo-best-time-')) continue;
      const n = Number(v);
      assert.ok(Number.isFinite(n) && n >= 0, `${k}=${v}`);
      assert.equal(v, String(n));
    }
  });
});
