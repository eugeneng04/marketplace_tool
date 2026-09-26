import test from 'node:test';
import assert from 'node:assert/strict';
import { createDueSearchRunner } from '../src/scheduler.js';

function setup({ locked = true, fail = false } = {}) {
  const calls = [];
  const run = createDueSearchRunner({
    db: { pool: { connect: async () => ({ query: async () => ({ rows: [{ locked }] }), release: (destroy) => calls.push(['release', destroy]) }) } },
    listDueSearchGroups: async () => { calls.push(['due']); return [{ id: 'g1' }, { id: 'g2' }]; },
    listSearchGroups: async () => ['g1', 'g2'].map(id => ({ id, intervalMinutes: 60, profiles: [{ id: `${id}-p`, enabled: true }, { id: 'disabled', enabled: false }] })),
    getProfile: async (_db, id) => ({ id, enabled: true }),
    runProfile: async profile => { calls.push(['run', profile.id]); if (fail && profile.id === 'g1-p') throw new Error('connector offline'); },
    advanceSearchGroup: async (_db, id, minutes) => { assert.equal(minutes, 60); calls.push(['advance', id]); }
  });
  return { run, calls };
}

test('due searches execute enabled profiles and advance only after completion', async () => {
  const { run, calls } = setup();
  const result = await run();
  assert.equal(result.groupsCompleted, 2);
  assert.equal(result.profilesCompleted, 2);
  assert.deepEqual(calls, [['due'], ['run', 'g1-p'], ['advance', 'g1'], ['run', 'g2-p'], ['advance', 'g2'], ['release', true]]);
});

test('another scheduler holding the lock prevents duplicate work', async () => {
  const { run, calls } = setup({ locked: false });
  assert.equal((await run()).skipped, true);
  assert.deepEqual(calls, [['release', true]]);
});

test('failed groups remain due, later groups still run, and lock connection is released', async () => {
  const { run, calls } = setup({ fail: true });
  const result = await run();
  assert.equal(result.errors.length, 1);
  assert.equal(result.groupsCompleted, 1);
  assert.ok(!calls.some(call => call[0] === 'advance' && call[1] === 'g1'));
  assert.deepEqual(calls.at(-1), ['release', true]);
});
