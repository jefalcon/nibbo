const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// El HUD muestra el mejor tiempo del nivel actual durante la partida.
// Estos tests ejercen el camino REAL de game.js (updateHUD pinta
// formatTime(L.getRecord(S.level)) en b#hud-record cada frame en play
// y ready), con el game.js auténtico y un DOM/localStorage mínimos,
// igual que tests/persistence.test.js. Deterministas y aislados.

const GAME_SRC = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

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
// (récords en memoria aislados) y expone el gancho window.__nibbo
// más el documento falso para leer el HUD pintado.
function boot({ seed, storage } = {}) {
  const logicPath = require.resolve('../logic.js');
  delete require.cache[logicPath];
  const L = require('../logic.js');
  const store = storage !== undefined ? storage : new FakeStorage(seed);
  const doc = documentStub();
  const win = {
    Nibbo: L,
    localStorage: store,
    addEventListener() {},
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
  };
  new Function('window', 'document', GAME_SRC)(win, doc);
  return { L, store, doc, win, nibbo: win.__nibbo };
}

function hudRecord(doc) {
  return doc.getElementById('hud-record').textContent;
}

// Un frame en plena partida por el camino real (dt=0: sin movimiento,
// pero updateHUD sí se ejecuta al final del update en fase play).
function playFrame(nibbo) {
  const S = nibbo.state;
  S.phase = 'play';
  S.paused = false;
  nibbo.update(0);
  return S;
}

describe('HUD del mejor tiempo (hud-record)', () => {
  test('el markup trae la etiqueta "Mejor tiempo" y el b#hud-record', () => {
    assert.ok(INDEX_SRC.includes('Mejor tiempo'));
    assert.ok(INDEX_SRC.includes('id="hud-record"'));
  });

  test('sin récord muestra "—" durante la partida', () => {
    const { nibbo, doc } = boot({});
    assert.equal(hudRecord(doc), '—');
    nibbo.start();
    const S = playFrame(nibbo);
    assert.equal(S.phase, 'play');
    assert.equal(hudRecord(doc), '—');
  });

  test('con récord muestra el mejor tiempo formateado durante la partida', () => {
    const { L, nibbo, doc } = boot({ seed: { 'nibbo-best-time-1': '95000' } });
    assert.equal(L.getRecord(1), 95000);
    nibbo.start();
    const S = playFrame(nibbo);
    assert.equal(S.phase, 'play');
    assert.equal(hudRecord(doc), '1:35.0');
  });

  test('en ready también se ve el récord del nivel actual', () => {
    const { nibbo, doc } = boot({ seed: { 'nibbo-best-time-1': '60000' } });
    nibbo.start();
    assert.equal(nibbo.state.phase, 'ready');
    nibbo.update(0);
    assert.equal(nibbo.state.phase, 'ready');
    assert.equal(hudRecord(doc), '1:00.0');
  });

  test('al cambiar de nivel muestra el récord del nivel actual', () => {
    const { nibbo, doc } = boot({
      seed: { 'nibbo-best-time-1': '60000', 'nibbo-best-time-2': '125500' },
    });
    nibbo.start();
    playFrame(nibbo);
    assert.equal(hudRecord(doc), '1:00.0');
    nibbo.state.level = 2;
    const S = playFrame(nibbo);
    assert.equal(S.phase, 'play');
    assert.equal(hudRecord(doc), '2:05.5');
  });

  test('un nivel sin récord muestra "—" aunque otros niveles tengan marca', () => {
    const { nibbo, doc } = boot({ seed: { 'nibbo-best-time-1': '60000' } });
    nibbo.start();
    nibbo.state.level = 3;
    const S = playFrame(nibbo);
    assert.equal(S.phase, 'play');
    assert.equal(hudRecord(doc), '—');
  });
});
