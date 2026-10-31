"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.resolve(__dirname, "../../travel-content-store.js"), "utf8");
const moduleForStore = { exports: {} };
const store = new Function("module", "exports", `${source}\nreturn module.exports;`)(moduleForStore, moduleForStore.exports);

function content(dayCount = 1) {
  const snapshot = store.createInitialContent({ metadata: { tripId: "inspiration-test", title: "Fixture" }, days: Array.from({ length: dayCount }, (_, index) => ({ id: `day-${index + 1}`, day: index + 1, date: `2026-12-${String(index + 1).padStart(2, "0")}`, title: `Fixture day ${index + 1}`, schedule: [] })) });
  snapshot.days = snapshot.days.map((day, index) => ({ ...day, id: `day-${index + 1}` }));
  snapshot.inspirations = [{ id: "spot-1", title: "Fixture spot", locationName: "Fixture location", sourcePlatform: "小红书", sourceUrl: "https://example.com/original", votes: [], status: "below_threshold" }];
  return snapshot;
}

function vote(snapshot, id, total, now = "2026-10-31T00:00:00Z") {
  const people = Array.from({ length: total }, (_, index) => `traveler-${index + 1}`);
  return (travelerId) => store.applyInspirationVote(snapshot, id, travelerId, people, now);
}

test("inspiration URLs allow only http(s), preserve the pasted URL and reject script schemes", () => {
  const original = "https://example.com/watch?id=original#clip";
  assert.equal(store.safeInspirationUrl(original), original);
  assert.equal(store.safeInspirationUrl(""), "");
  assert.throws(() => store.safeInspirationUrl("javascript:alert(1)"), /只允许 http 或 https/);
  assert.throws(() => store.safeInspirationUrl("data:text/html,hi"), /只允许 http 或 https/);
});

test("strict majority rules use unique stable traveler IDs for 2, 3 and 4 travelers", () => {
  const two = content(); const voteTwo = vote(two, "spot-1", 2);
  voteTwo("traveler-1"); assert.equal(two.inspirations[0].status, "below_threshold");
  voteTwo("traveler-2"); assert.equal(two.inspirations[0].status, "approved_pending_day");
  assert.equal((two.inspirations[0].votes || []).length, 2);

  const three = content(); const voteThree = vote(three, "spot-1", 3);
  voteThree("traveler-1"); voteThree("traveler-2"); assert.equal(three.inspirations[0].status, "approved_pending_day");

  const four = content(); const voteFour = vote(four, "spot-1", 4);
  voteFour("traveler-1"); voteFour("traveler-2"); assert.equal(four.inspirations[0].status, "below_threshold");
  voteFour("traveler-3"); assert.equal(four.inspirations[0].status, "approved_pending_day");
});

test("one traveler can vote once and cancel their own vote", () => {
  const snapshot = content(); const cast = vote(snapshot, "spot-1", 3);
  cast("traveler-1"); cast("traveler-1");
  assert.deepEqual(snapshot.inspirations[0].votes, []);
  assert.equal(snapshot.inspirations[0].status, "below_threshold");
});

test("a majority with a selected day appends one stable itinerary item and refreshes never duplicate it", () => {
  const snapshot = content(); snapshot.inspirations[0].targetDay = "day-1"; snapshot.inspirations[0].targetDate = "2026-12-01";
  const cast = vote(snapshot, "spot-1", 2);
  cast("traveler-1"); cast("traveler-2");
  const record = snapshot.inspirations[0]; const itemId = record.linkedItineraryItemId;
  assert.equal(record.status, "approved_added");
  assert.equal(snapshot.days[0].schedule.length, 1);
  assert.equal(snapshot.days[0].schedule[0].sourceInspirationId, "spot-1");
  assert.equal(snapshot.days[0].schedule[0].id, `inspiration-item-${record.id}`);
  assert.equal(store.updateInspirationApproval(snapshot, record, ["traveler-1", "traveler-2"]), false);
  assert.equal(snapshot.days[0].schedule.length, 1);
  assert.equal(record.linkedItineraryItemId, itemId);
});

test("no target day awaits a manual date; manual add works before majority", () => {
  const pending = content(); const cast = vote(pending, "spot-1", 3);
  cast("traveler-1"); cast("traveler-2");
  assert.equal(pending.inspirations[0].status, "approved_pending_day");
  assert.equal(pending.days[0].schedule.length, 0);
  const manual = content(2);
  assert.equal(store.manuallyAddInspiration(manual, "spot-1", "day-2"), true);
  assert.equal(manual.inspirations[0].status, "manual_added");
  assert.equal(manual.inspirations[0].targetDate, "2026-12-02");
  assert.equal(manual.days[1].schedule[0].id, manual.inspirations[0].linkedItineraryItemId);
  assert.equal(store.manuallyAddInspiration(manual, "spot-1", "day-1"), false);
  assert.equal(manual.days[0].schedule.length, 0);
});

test("dropping below majority updates status but never removes a linked or edited schedule item", () => {
  const snapshot = content(); snapshot.inspirations[0].targetDay = "day-1";
  const cast = vote(snapshot, "spot-1", 2);
  cast("traveler-1"); cast("traveler-2");
  snapshot.days[0].schedule[0].time = "15:30";
  cast("traveler-2");
  assert.equal(snapshot.inspirations[0].status, "below_threshold_linked");
  assert.equal(snapshot.days[0].schedule.length, 1);
  assert.equal(snapshot.days[0].schedule[0].time, "15:30");
});

test("old snapshots without inspirations remain readable and new records survive local reload", () => {
  const entries = new Map();
  const storage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)) };
  const local = store.createStore("inspiration-test", storage);
  const initial = content(); delete initial.inspirations;
  entries.set(local.storageKey, JSON.stringify(initial));
  const loaded = local.load({ metadata: { tripId: "inspiration-test", title: "Fixture" } });
  assert.deepEqual(loaded.inspirations, []);
  loaded.inspirations.push({ ...content().inspirations[0] });
  local.save(loaded);
  assert.equal(local.load().inspirations[0].sourcePlatform, "小红书");
  assert.equal(local.load().inspirations[0].sourceUrl, "https://example.com/original");
});

test("inspiration create, edit and delete persist by the same stable ID and allow multiple records per itinerary item", () => {
  const entries = new Map();
  const storage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)) };
  const local = store.createStore("inspiration-test", storage);
  const snapshot = content();
  snapshot.inspirations[0].linkedItineraryItemId = "existing-item";
  snapshot.inspirations.push({ id: "spot-2", title: "Another source", locationName: "Fixture location", sourcePlatform: "OtherSite", sourceUrl: "https://example.org/post", linkedItineraryItemId: "existing-item", votes: [], status: "linked_existing" });
  local.save(snapshot);
  const loaded = local.load();
  const stableId = loaded.inspirations[0].id;
  loaded.inspirations[0].title = "Edited title";
  loaded.inspirations[0].sourceUrl = "https://example.com/edited";
  local.save(loaded);
  const edited = local.load();
  assert.equal(edited.inspirations[0].id, stableId);
  assert.equal(edited.inspirations[0].title, "Edited title");
  assert.deepEqual(edited.inspirations.map((record) => record.linkedItineraryItemId), ["existing-item", "existing-item"]);
  edited.inspirations = edited.inspirations.filter((record) => record.id !== "spot-2");
  local.save(edited);
  assert.deepEqual(local.load().inspirations.map((record) => record.id), [stableId]);
});

test("D1 content snapshot round-trip preserves votes, status and linked day without a schema migration", async () => {
  const originalFetch = global.fetch;
  let snapshot = content(); snapshot.inspirations[0].targetDay = "day-1";
  let revision = 8;
  global.fetch = async (url, init = {}) => {
    if (init.method === "PUT") { snapshot = JSON.parse(init.body).content; revision += 1; return new Response(JSON.stringify({ revision }), { status: 200, headers: { "content-type": "application/json" } }); }
    return new Response(JSON.stringify({ revision, content: snapshot }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const first = store.createCloudStore("inspiration-test");
    const loaded = await first.load({ metadata: { tripId: "inspiration-test", title: "Fixture" } });
    store.applyInspirationVote(loaded, "spot-1", "traveler-1", ["traveler-1", "traveler-2"]);
    store.applyInspirationVote(loaded, "spot-1", "traveler-2", ["traveler-1", "traveler-2"]);
    await first.save(loaded);
    const second = store.createCloudStore("inspiration-test");
    const roundTrip = await second.load({ metadata: { tripId: "inspiration-test", title: "Fixture" } });
    assert.equal(roundTrip.inspirations[0].votes.length, 2);
    assert.equal(roundTrip.inspirations[0].status, "approved_added");
    assert.equal(roundTrip.inspirations[0].linkedItineraryItemId, "inspiration-item-spot-1");
    assert.equal(roundTrip.days[0].schedule.length, 1);
  } finally { global.fetch = originalFetch; }
});

test("day map only projects actual coordinates from the requested day's itinerary in sequence", () => {
  const routeSource = fs.readFileSync(path.resolve(__dirname, "../../route-ui.js"), "utf8");
  const sandboxWindow = {};
  const data = { places: [{ id: "place-a", name: "Stop A", geo: { lat: 43.77, lng: 11.25 } }] };
  const routeState = { data };
  const routeApi = new Function("window", "state", "escapeHtml", `${routeSource}\nreturn window.TravelRouteUI;`)(sandboxWindow, routeState, (text) => String(text).replace(/[&<>\'"]/g, ""));
  const day = { id: "day-a", schedule: [{ id: "item-a", placeId: "place-a", location: "Stop A" }, { id: "item-no-geo", location: "No coordinates", locationLatitude: "", locationLongitude: "" }, { id: "item-b", location: "Stop B", locationLatitude: 45, locationLongitude: 9 }] };
  const anotherDay = { id: "day-b", schedule: [{ location: "Elsewhere", locationLatitude: 0, locationLongitude: 0 }] };
  assert.deepEqual(routeApi.dayMapPoints(day, data).map((point) => [point.number, point.label]), [[1, "Stop A"], [2, "Stop B"]]);
  const markup = routeApi.renderItineraryDayMap.call(routeApi, day);
  assert.match(markup, /data-map-day="day-a"/);
  assert.match(markup, /data-day-map-zoom="in"/);
  assert.match(markup, /data-day-map-zoom="out"/);
  assert.match(markup, /data-day-map-marker="0"/);
  assert.match(markup, /data-day-map-marker="1"/);
  assert.doesNotMatch(markup, /Elsewhere/);
  assert.equal(routeApi.dayMapPoints(anotherDay, data)[0].label, "Elsewhere");
  assert.match(routeSource, /activateDayMap\(root\)[\s\S]*?activateItineraryDayMap\(root\)/);
});

test("inspiration and Day map layouts reflow under the mobile breakpoint and keep stable attachment owners", () => {
  const pageSource = fs.readFileSync(path.resolve(__dirname, "../../travel-inspiration.js"), "utf8");
  const css = fs.readFileSync(path.resolve(__dirname, "../../travel-inspiration.css"), "utf8");
  assert.match(pageSource, /`inspiration:\$\{record\.id\}`/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(css, /\.inspiration-grid\s*\{\s*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.inspiration-form-grid\s*\{\s*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.itinerary-map__viewport\s*\{[^}]*width:100%;/);
  assert.match(css, /\.itinerary-map__stops\s*\{\s*display:grid;\s*grid-template-columns:minmax\(0,1fr\)/);
});
