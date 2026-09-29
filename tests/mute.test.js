const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Mute (KeyM / botón): estos tests ejercen el camino REAL de game.js
// (loadMute/saveMute/Sfx.toggleMute/tone) sin reimplementarlo. Cada
// arranque carga el game.js auténtico con un DOM/localStorage mínimos y
// una instancia fresca de logic.js. El estado de mute se observa por su
// contrato público: texto del botón #btn-mute + clave 'nibbo-muted'.

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
  const el = {
    textContent: '',
    innerHTML: '',
    offsetWidth: 0,
    width: 0,
    height: 0,
    style: {},
    attrs: {},
    classList: { toggle() {}, remove() {}, add() {} },
    _clicks: [],
    setAttribute(k, v) {
      this.attrs[String(k)] = String(v);
    },
    getAttribute(k) {
      return Object.hasOwn(this.attrs, String(k)) ? this.attrs[String(k)] : null;
    },
    addEventListener(type, fn) {
      if (type === 'click') this._clicks.push(fn);
    },
    getContext: () => ctxStub(),
  };
  return el;
}

function documentStub() {
  const els = new Map();
  const keys = [];
  const doc = {
    _keys: keys,
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
    addEventListener(type, fn) {
      if (type === 'keydown') keys.push(fn);
    },
    hidden: false,
  };
  return doc;
}

// WebAudio falso que cuenta osciladores creados (tono emitido).
function fakeAudioContextOn(list) {
  return class {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.oscs = 0;
      list.push(this);
    }
    resume() {}
    createOscillator() {
      this.oscs++;
      return {
        type: '',
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {
          return { connect() {} };
        },
        start() {},
        stop() {},
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {
          return { connect() {} };
        },
      };
    }
  };
}

// Arranca el game.js real y expone el gancho window.__nibbo más
// ayudantes para pulsar teclas y el botón de mute.
function boot({ seed, storage, noStorage } = {}) {
  const logicPath = require.resolve('../logic.js');
  delete require.cache[logicPath];
  const L = require('../logic.js');
  const store = storage !== undefined ? storage : new FakeStorage(seed);
  const doc = documentStub();
  const audioCtxs = [];
  const win = {
    Nibbo: L,
    AudioContext: fakeAudioContextOn(audioCtxs),
    addEventListener() {},
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
  };
  if (!noStorage) win.localStorage = store;
  new Function('window', 'document', GAME_SRC)(win, doc);
  const nibbo = win.__nibbo;
  const muteBtn = doc.getElementById('btn-mute');
  const pressM = () => {
    for (const fn of doc._keys) fn({ code: 'KeyM', preventDefault() {} });
  };
  const clickMute = () => {
    for (const fn of muteBtn._clicks) fn();
  };
  const muted = () => muteBtn.textContent !== 'Silenciar (M)';
  return { L, store, win, doc, nibbo, muteBtn, audioCtxs, pressM, clickMute, muted };
}

describe('mute (KeyM / botón, persistencia nibbo-muted)', () => {
  test('por defecto arranca con sonido (unmuted)', () => {
    const { muteBtn, store } = boot({});
    assert.equal(muteBtn.textContent, 'Silenciar (M)');
    assert.equal(muteBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(store.getItem('nibbo-muted'), null);
  });

  test("hidrata '1' como muted", () => {
    const { muteBtn } = boot({ seed: { 'nibbo-muted': '1' } });
    assert.equal(muteBtn.textContent, 'Activar sonido (M)');
    assert.equal(muteBtn.getAttribute('aria-pressed'), 'true');
  });

  test("hidrata '0', ausente o inválido como unmuted", () => {
    for (const seed of [{}, { 'nibbo-muted': '0' }, { 'nibbo-muted': 'yes' }, { 'nibbo-muted': '' }]) {
      const { muteBtn } = boot({ seed });
      assert.equal(muteBtn.textContent, 'Silenciar (M)');
      assert.equal(muteBtn.getAttribute('aria-pressed'), 'false');
    }
  });

  test('KeyM alterna mute y persiste 1/0', () => {
    const { store, pressM, muteBtn, muted } = boot({});
    pressM();
    assert.equal(muted(), true);
    assert.equal(muteBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(store.getItem('nibbo-muted'), '1');
    // Round-trip real: rearrancar con el mismo almacén hidrata muted.
    const again = boot({ storage: store });
    assert.equal(again.muted(), true);
    pressM();
    assert.equal(muted(), false);
    assert.equal(store.getItem('nibbo-muted'), '0');
    const last = boot({ storage: store });
    assert.equal(last.muted(), false);
  });

  test('el clic en el botón alterna y persiste igual que KeyM', () => {
    const { store, clickMute, muted } = boot({});
    clickMute();
    assert.equal(muted(), true);
    assert.equal(store.getItem('nibbo-muted'), '1');
    clickMute();
    assert.equal(muted(), false);
    assert.equal(store.getItem('nibbo-muted'), '0');
  });

  test('sobrevive sin localStorage al alternar', () => {
    const { pressM, muted, muteBtn } = boot({ noStorage: true });
    assert.equal(muted(), false);
    assert.doesNotThrow(pressM);
    assert.equal(muted(), true);
    assert.equal(muteBtn.getAttribute('aria-pressed'), 'true');
    assert.doesNotThrow(pressM);
    assert.equal(muted(), false);
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
    const { pressM, muted } = boot({ storage: throwing });
    assert.equal(muted(), false);
    assert.doesNotThrow(pressM);
    assert.equal(muted(), true);
  });

  test('tone() gateado: muted no crea osciladores, unmuted sí', () => {
    const { nibbo, audioCtxs, pressM } = boot({});
    nibbo.start(); // Sfx.start() emite 3 tonos con sonido activado
    assert.equal(audioCtxs.length, 1);
    assert.ok(audioCtxs[0].oscs > 0, 'con sonido debe crear osciladores');
    const before = audioCtxs[0].oscs;
    pressM(); // mutear
    nibbo.start(); // tonos gateados: cero osciladores nuevos
    assert.equal(audioCtxs[0].oscs, before);
    pressM(); // desmutear
    nibbo.start();
    assert.ok(audioCtxs[0].oscs > before, 'sin mute debe volver a sonar');
  });
});
