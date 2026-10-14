// LocalStore: single-user localStorage backend on a static host. Pins the
// behaviours that lose maps if they regress:
//  - save then get returns the same map with an updated timestamp;
//  - list metadata matches saved maps, newest first;
//  - remove clears map, history and index entry;
//  - snapshots use the 60 s refine window and prune on quota;
//  - history/version use the same {ts} contract as ServerStore;
//  - ?local=1 persists the mode choice and ?local=0 clears it.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFunction } from './helpers/load-app-fns.mjs';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Slice the source of `const NAME = <expr>;` like load-app-fns.mjs's
// extractConst, but return the raw expression so the test can evaluate it
// with injected dependencies. The start-of-line regex also has to reject a
// partial-name hit (LOCAL_INDEX_KEY appears INSIDE the LOCAL_PREFIX value):
// require the match to begin at column 0, not merely at a line boundary.
function constExpression(name) {
  const re = new RegExp(`(?:^|\\n)const\\s+${name}\\s*=\\s*`);
  const m = re.exec(SRC);
  if (!m) throw new Error('const ' + name + ' not found');
  const valueStart = m.index + m[0].length;
  // Bound the scan: the next top-level `const NAME` (or a blank line) ends the
  // declaration, so a ; inside an adjacent const can't extend the slice.
  const next = SRC.slice(valueStart).search(/\n(?:const|\/\*)/);
  const limit = next === -1 ? SRC.length : valueStart + next;
  for (let i = SRC.indexOf(';', valueStart); i !== -1 && i < limit; i = SRC.indexOf(';', i + 1)) {
    const candidate = SRC.slice(valueStart, i);
    try { new Function('return (' + candidate + ');'); return candidate; } catch { /* keep scanning */ }
  }
  throw new Error('could not evaluate const ' + name);
}
// Evaluate the LOCAL_* consts together in one scope: several reference
// LOCAL_PREFIX, so evaluating one alone throws ReferenceError.
const LOCAL_CONST_NAMES = ['LOCAL_PREFIX', 'LOCAL_INDEX_KEY', 'LOCAL_FLAG_KEY', 'LOCAL_MAX_VERSIONS', 'LOCAL_VERSION_WINDOW_MS'];
const LOCAL_CONSTS = (() => {
  const body = LOCAL_CONST_NAMES
    .map(n => 'const ' + n + ' = ' + constExpression(n) + ';')
    .join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body + '\nreturn { ' + LOCAL_CONST_NAMES.join(', ') + ' };')();
})();

function memStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    _data: m,
  };
}

function quotaStorage(limitChars) {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      const s = String(v);
      const others = [...m.entries()].filter(([kk]) => kk !== k).reduce((a, [, vv]) => a + vv.length, 0);
      if (others + s.length > limitChars) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      m.set(k, s);
    },
    removeItem: k => { m.delete(k); },
    _data: m,
  };
}

let NOW = 1000000;
function fakeDateClass() {
  return class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  };
}

function makeStore(storage) {
  const deps = {
    localStorage: storage,
    ...LOCAL_CONSTS,
    Date: fakeDateClass(),
  };
  deps._localRead = new Function(...Object.keys(deps),
    extractFunction('_localRead') + '\nreturn _localRead;')(...Object.values(deps));
  const keys = Object.keys(deps);
  return new Function(...keys, 'return (' + constExpression('LocalStore') + ');')(...keys.map(k => deps[k]));
}

function makeLocalModeRequested(storage, search) {
  const deps = {
    localStorage: storage,
    LOCAL_FLAG_KEY: LOCAL_CONSTS.LOCAL_FLAG_KEY,
    location: { search: search || '' },
    URLSearchParams,
  };
  return new Function(...Object.keys(deps),
    extractFunction('localModeRequested') + '\nreturn localModeRequested;')(...Object.values(deps));
}

let store, storage;
beforeEach(() => {
  NOW = 1000000;
  storage = memStorage();
  store = makeStore(storage);
});

const sampleMap = (id, title) => ({ id, title: title || 'T', color: '#abc', nodes: { r: { id: 'r', text: 'root', parent: null } }, rootId: 'r' });

describe('LocalStore maps', () => {
  test('empty list by default', async () => {
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get('nope'), null);
  });

  test('save stamps updated, get round-trips, list metadata newest first', async () => {
    await store.save(sampleMap('a', 'Alpha'));
    assert.equal((await store.get('a')).title, 'Alpha');
    assert.equal((await store.get('a')).updated, NOW);
    NOW += 5000;
    await store.save(sampleMap('b', 'Beta'));
    const list = await store.list();
    assert.deepEqual(list.map(x => x.id), ['b', 'a']);
    assert.deepEqual(list[1], { id: 'a', title: 'Alpha', color: '#abc', updated: 1000000 });
  });

  test('updating an existing map replaces its list entry, not duplicates it', async () => {
    await store.save(sampleMap('a'));
    NOW += 100000;
    const m2 = sampleMap('a', 'Alpha v2');
    await store.save(m2);
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Alpha v2');
    assert.equal((await store.get('a')).title, 'Alpha v2');
  });

  test('remove clears map, index and history', async () => {
    await store.save(sampleMap('a'));
    await store.remove('a');
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get('a'), null);
    assert.deepEqual(await store.history('a'), []);
  });

  test('corrupt JSON in a key is treated as absent, not thrown', async () => {
    storage.setItem('mindspark:local:map:x', '{not json');
    assert.equal(await store.get('x'), null);
    storage.setItem('mindspark:local:index', '[');
    assert.deepEqual(await store.list(), []);
  });
});

describe('LocalStore history', () => {
  test('first save creates one snapshot; no-op save adds none', async () => {
    await store.save(sampleMap('a'));
    await store.save(sampleMap('a'));
    const h = await store.history('a');
    assert.equal(h.length, 1);
    assert.deepEqual(h[0], { ts: NOW });
  });

  test('changed saves within 60 s refine the latest snapshot instead of adding', async () => {
    await store.save(sampleMap('a', 'v1'));
    NOW += 30000;
    await store.save(sampleMap('a', 'v2'));
    const h = await store.history('a');
    assert.equal(h.length, 1);
    assert.equal(h[0].ts, 1000000, 'kept original timestamp');
    assert.equal((await store.version('a', h[0].ts)).title, 'v2', 'content refined');
  });

  test('changed saves after 60 s add new snapshots, newest first', async () => {
    await store.save(sampleMap('a', 'v1'));
    NOW += 61000;
    await store.save(sampleMap('a', 'v2'));
    NOW += 61000;
    await store.save(sampleMap('a', 'v3'));
    const h = await store.history('a');
    assert.deepEqual(h.map(x => x.ts), [NOW, NOW - 61000, NOW - 122000]);
    assert.equal((await store.version('a', h[2].ts)).title, 'v1');
    assert.equal((await store.version('a', h[0].ts)).title, 'v3');
    assert.equal(await store.version('a', 999), null);
  });

  test('snapshot prune survives a quota limit without failing the map save', async () => {
    // Tight enough that the capped history list overflows first, while the
    // current map body and the index always fit.
    const q = quotaStorage(1500);
    const s = makeStore(q);
    let threw = false;
    for (let i = 0; i < 10; i++) {
      NOW += 90000;
      try { await s.save(sampleMap('a', 'version number ' + i)); } catch (e) { threw = true; }
    }
    assert.equal(threw, false, 'map saves never fail because of history quota');
    const cur = await s.get('a');
    assert.equal(cur.title, 'version number 9');
    assert.ok((await s.history('a')).length >= 1, 'at least one version survives');
  });
});

describe('localModeRequested', () => {
  test('off by default', () => {
    assert.equal(makeLocalModeRequested(memStorage(), '')(), false);
  });

  test('?local=1 enables and persists; subsequent plain loads stay enabled', () => {
    const s = memStorage();
    assert.equal(makeLocalModeRequested(s, '?local=1')(), true);
    assert.equal(s.getItem(LOCAL_CONSTS.LOCAL_FLAG_KEY), '1');
    assert.equal(makeLocalModeRequested(s, '')(), true);
  });

  test('?local=0 clears the persisted choice', () => {
    const s = memStorage({ [LOCAL_CONSTS.LOCAL_FLAG_KEY]: '1' });
    assert.equal(makeLocalModeRequested(s, '?local=0')(), false);
    assert.equal(s.getItem(LOCAL_CONSTS.LOCAL_FLAG_KEY), null);
  });
});
