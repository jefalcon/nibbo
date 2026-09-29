const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Aviso '¡Récord!' al batir el mejor tiempo del nivel. Estos tests ejercen
// el camino REAL de game.js (beginClear -> flashRecordToast) con el game.js
// auténtico y un DOM/localStorage/timers mínimos, igual que
// tests/hud-record.test.js. Deterministas y aislados (sin red ni reloj).

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

// classList observable (Set) para afirmar visible/oculto del toast.
function elStub() {
  const classes = new Set();
  return {
    textContent: '',
    innerHTML: '',
    offsetWidth: 0,
    width: 0,
    height: 0,
    style: {},
    classList: {
      add(...cs) {
        for (const c of cs) classes.add(String(c));
      },
      remove(...cs) {
        for (const c of cs) classes.delete(String(c));
      },
      toggle(c, force) {
        c = String(c);
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c);
          else classes.add(c);
        } else if (force) {
          classes.add(c);
        } else {
          classes.delete(c);
        }
        return classes.has(c);
      },
      contains(c) {
        return classes.has(String(c));
      },
    },
    addEventListener() {},
    getContext: () => ctxStub(),
  };
}

function documentStub() {
  const els = new Map();
  return {
    getElementById(id) {
      if (!els.has(id)) {
        const el = elStub();
        // El markup trae el toast oculto: <div id="record-toast" class="hidden">.
        if (id === 'record-toast') el.classList.add('hidden');
        els.set(id, el);
      }
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

// Arranca el game.js real con timers falsos (capturan fn + ms, sin reloj).
function boot({ seed } = {}) {
  const logicPath = require.resolve('../logic.js');
  delete require.cache[logicPath];
  const L = require('../logic.js');
  const store = new FakeStorage(seed);
  const doc = documentStub();
  const timers = [];
  const cleared = [];
  const win = {
    Nibbo: L,
    localStorage: store,
    addEventListener() {},
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
    setTimeout(fn, ms) {
      const id = timers.length + 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
    },
  };
  new Function('window', 'document', GAME_SRC)(win, doc);
  return { L, store, doc, win, timers, cleared, nibbo: win.__nibbo };
}

function toast(doc) {
  return doc.getElementById('record-toast');
}

function isHidden(doc) {
  return toast(doc).classList.contains('hidden');
}

// Supera el nivel por el camino real: una sola semilla bajo Nibbo y un
// frame en play (eatAt -> beginClear). levelTimeSecs fija el tiempo final.
function clearLevel(nibbo, levelTimeSecs) {
  const S = nibbo.state;
  S.phase = 'play';
  S.paused = false;
  S.levelTime = levelTimeSecs;
  S.nibbo.t = 1;
  S.dots = new Map([[S.nibbo.tx + ',' + S.nibbo.ty, 'dot']]);
  nibbo.update(0);
  return S;
}

describe("aviso '¡Récord!' al batir el mejor tiempo", () => {
  test('el markup trae el toast oculto con rol de estado', () => {
    assert.ok(INDEX_SRC.includes('id="record-toast"'));
    assert.ok(INDEX_SRC.includes('id="record-toast" class="hidden"'));
    assert.ok(INDEX_SRC.includes('role="status"'));
  });

  test('al batir el récord muestra el toast con el tiempo formateado', () => {
    const { L, doc, timers, nibbo } = boot({ seed: { 'nibbo-best-time-1': '95000' } });
    nibbo.start();
    assert.equal(isHidden(doc), true);
    const S = clearLevel(nibbo, 60);
    assert.equal(S.phase, 'clear');
    assert.equal(S.newRecord, true);
    assert.equal(S.lastTimeMs, 60000);
    assert.equal(L.getRecord(1), 60000);
    assert.equal(isHidden(doc), false);
    assert.equal(toast(doc).textContent, '¡Récord! 1:00.0');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 2500);
  });

  test('la primera marca del nivel también avisa', () => {
    const { L, doc, timers, store, nibbo } = boot({});
    nibbo.start();
    const S = clearLevel(nibbo, 95);
    assert.equal(S.phase, 'clear');
    assert.equal(S.newRecord, true);
    assert.equal(isHidden(doc), false);
    assert.equal(toast(doc).textContent, '¡Récord! 1:35.0');
    assert.equal(L.getRecord(1), 95000);
    assert.equal(store.getItem('nibbo-best-time-1'), '95000');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 2500);
  });

  test('el aviso se oculta solo a los 2500 ms', () => {
    const { doc, timers, nibbo } = boot({});
    assert.ok(GAME_SRC.includes('RECORD_TOAST_MS = 2500'));
    assert.ok(GAME_SRC.includes('typeof window.setTimeout'));
    nibbo.start();
    clearLevel(nibbo, 95);
    assert.equal(isHidden(doc), false);
    assert.equal(timers.length, 1);
    assert.equal(typeof timers[0].fn, 'function');
    timers[0].fn(); // dispara el auto-hide sin reloj real
    assert.equal(isHidden(doc), true);
  });

  test('el empate no avisa (< estricto)', () => {
    const { L, doc, timers, store, nibbo } = boot({ seed: { 'nibbo-best-time-1': '95000' } });
    nibbo.start();
    const S = clearLevel(nibbo, 95); // 95000 ms == récord vigente
    assert.equal(S.phase, 'clear');
    assert.equal(S.newRecord, false);
    assert.equal(isHidden(doc), true);
    assert.equal(toast(doc).textContent, '');
    assert.equal(timers.length, 0);
    assert.equal(L.getRecord(1), 95000);
    assert.equal(store.getItem('nibbo-best-time-1'), '95000');
  });

  test('un peor tiempo no avisa', () => {
    const { L, doc, timers, store, nibbo } = boot({ seed: { 'nibbo-best-time-1': '95000' } });
    nibbo.start();
    const S = clearLevel(nibbo, 100); // 100000 ms > récord vigente
    assert.equal(S.phase, 'clear');
    assert.equal(S.newRecord, false);
    assert.equal(isHidden(doc), true);
    assert.equal(toast(doc).textContent, '');
    assert.equal(timers.length, 0);
    assert.equal(L.getRecord(1), 95000);
    assert.equal(store.getItem('nibbo-best-time-1'), '95000');
  });

  test('el toast se oculta al cambiar de nivel', () => {
    const { doc, timers, cleared, nibbo } = boot({});
    nibbo.start();
    clearLevel(nibbo, 60);
    assert.equal(isHidden(doc), false);
    assert.equal(timers.length, 1);
    nibbo.update(6); // agota clearT (5 s) -> nivel 2 por el camino real
    assert.equal(nibbo.state.level, 2);
    assert.equal(nibbo.state.phase, 'ready');
    assert.equal(isHidden(doc), true);
    assert.ok(cleared.length >= 1, 'el timer pendiente se cancela');
  });

  test('un solo call site: beginClear tras updateOverlay/startClearCount', () => {
    const all = GAME_SRC.match(/flashRecordToast\(/g) || [];
    assert.equal(all.length, 2, 'definición + una llamada, sin más ganchos');
    const beat = GAME_SRC.match(/flashRecordToast\(elapsedMs\)/g) || [];
    assert.equal(beat.length, 1);
    assert.ok(GAME_SRC.includes('if (S.newRecord) flashRecordToast(elapsedMs)'));
    assert.ok(
      GAME_SRC.includes(
        'updateOverlay();\n    startClearCount();\n    if (S.newRecord) flashRecordToast(elapsedMs);'
      )
    );
  });
});
