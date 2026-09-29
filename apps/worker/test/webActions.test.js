import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../web/src/app.js", import.meta.url), "utf8");
const actions = source.slice(source.indexOf("function showActionStatus("), source.indexOf("function thumbnail("));
function harness(overrides = {}) {
  const nodes = new Map();
  const context = vm.createContext({
    $: (id) => { if (!nodes.has(id)) nodes.set(id, { disabled: false, textContent: "" }); return nodes.get(id); },
    state: { profiles: [] },
    loadProfiles: async () => {}, loadGroups: async () => {}, loadListings: async () => {},
    loadRuns: async () => {}, loadDeals: async () => {}, loadAlerts: async () => {},
    loadSearchDefaults: async () => {}, loadVehicleGenerations: async () => {},
    ...overrides
  });
  vm.runInContext(actions, context);
  return context;
}

test("refresh reports partial failure, preserves progress until requests settle, and re-enables button", async () => {
  let finish;
  const context = harness({ loadListings: () => new Promise((resolve) => { finish = resolve; }), loadDeals: async () => { throw new Error("Service unavailable"); } });
  const pending = context.refreshAll();
  assert.equal(context.$("#refreshButton").disabled, true);
  await context.refreshAll(); // A second click cannot start duplicate work.
  finish();
  await pending;
  assert.match(context.$("#refreshStatus").textContent, /Refresh incomplete: Service unavailable/);
  assert.equal(context.$("#refreshButton").disabled, false);
});

test("run all continues after one search fails, skips paused searches, and reloads results after each run", async () => {
  const calls = [];
  let reloads = 0;
  const context = harness({
    state: { profiles: [{ id: "a", name: "First", enabled: true }, { id: "b", enabled: false }, { id: "c", name: "Last", enabled: true }] },
    api: async (path) => { calls.push(path); if (path.includes("/a/")) throw new Error("Facebook unavailable"); return { run: { newItems: 3 } }; },
    loadListings: async () => { reloads++; }
  });
  await context.runAllSaved();
  assert.deepEqual(calls, ["/profiles/a/run", "/profiles/c/run"]);
  assert.equal(reloads, 2);
  assert.match(context.$("#syncStatus").textContent, /1 of 2 searches completed. 3 new listings/);
  assert.match(context.$("#syncStatus").textContent, /First: Facebook unavailable/);
  assert.equal(context.$("#syncAllButton").disabled, false);
});

test("run all explains empty and unavailable saved searches", async () => {
  const empty = harness();
  await empty.runAllSaved();
  assert.match(empty.$("#syncStatus").textContent, /No enabled saved searches/);
  const failed = harness({ loadProfiles: async () => { throw new Error("Unauthorized"); } });
  await failed.runAllSaved();
  assert.match(failed.$("#syncStatus").textContent, /Could not run saved searches: Unauthorized/);
  assert.equal(failed.$("#syncAllButton").disabled, false);
});

test("refresh confirms success and explains how to fetch new listings", async () => {
  const context = harness();
  await context.refreshAll();
  assert.match(context.$("#refreshStatus").textContent, /Saved data refreshed.*Run all saved/);
});
