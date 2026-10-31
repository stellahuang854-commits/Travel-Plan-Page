"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.resolve(__dirname, "../../travel-content-store.js"), "utf8");
const moduleForStore = { exports: {} };
const storeApi = new Function("module", "exports", `${source}\nreturn module.exports;`)(moduleForStore, moduleForStore.exports);

function memoryStorage() {
  const records = new Map();
  return {
    getItem(key) { return records.has(key) ? records.get(key) : null; },
    setItem(key, value) { records.set(key, String(value)); }
  };
}

test("initial snapshots copy existing trip content and assign stable ids without changing source", () => {
  const source = { metadata: { tripId: "trip-a", title: "Original Trip Title" }, accommodations: [{ name: "Stay" }], restaurants: [{ name: "Meal" }], days: [{ day: 1, schedule: [{ time: "09:00" }] }] };
  const before = JSON.stringify(source);
  const first = storeApi.createInitialContent(source);
  const second = storeApi.createInitialContent(source);
  assert.equal(JSON.stringify(source), before);
  assert.equal(first.accommodations[0].id, second.accommodations[0].id);
  assert.equal(first.days[0].schedule[0].id, second.days[0].schedule[0].id);
  assert.equal(first.todoCategories.length, 10);
  assert.equal(first.metadata.title, "Original Trip Title");
});

test("trip title persists across local reload and legacy snapshots use the existing metadata title", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("title-trip", storage);
  const initial = store.load({ metadata: { tripId: "title-trip", title: "Template title" }, accommodations: [{ id: "stay-1", name: "Keep me" }] });
  initial.metadata.title = "My updated trip";
  store.save(initial);
  const reloaded = store.load();
  assert.equal(reloaded.metadata.title, "My updated trip");
  assert.equal(reloaded.accommodations[0].name, "Keep me");

  const old = storeApi.createInitialContent({ metadata: { tripId: "old-title-trip", title: "Old template title" } });
  delete old.metadata;
  const oldStore = storeApi.createStore("old-title-trip", storage);
  storage.setItem(oldStore.storageKey, JSON.stringify(old));
  assert.equal(oldStore.load({ metadata: { tripId: "old-title-trip", title: "Old template title" } }).metadata.title, "Old template title");
});

test("snapshots persist per trip and preserve unknown records from other collections", () => {
  const storage = memoryStorage();
  storage.setItem("travel-plan:runtime:v1:trip-a", JSON.stringify({ bills: [{ id: "bill-1" }], tickets: [{ id: "ticket-1" }], travelers: [{ id: "person-1" }], settings: { keep: true } }));
  const first = storeApi.createStore("trip-a", storage);
  const content = first.load({ metadata: { tripId: "trip-a" } });
  content.restaurants.push({ id: "restaurant-1", name: "Cafe" });
  first.save(content);
  assert.equal(first.load().restaurants[0].name, "Cafe");
  assert.equal(storeApi.createStore("trip-b", storage).load({ metadata: { tripId: "trip-b" } }).restaurants.length, 0);
  assert.deepEqual(JSON.parse(storage.getItem("travel-plan:runtime:v1:trip-a")).bills, [{ id: "bill-1" }]);
});

test("invalid or corrupt snapshots fail without being overwritten", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("trip-a", storage);
  storage.setItem(store.storageKey, "{broken");
  assert.throws(() => store.load(), /无法解析/);
  assert.equal(storage.getItem(store.storageKey), "{broken");
  assert.throws(() => store.save({ version: 1, tripId: "other", todoCategories: [] }), /tripId/);
});

test("save errors are reported to the caller", () => {
  const storage = { getItem() { return null; }, setItem() { throw new Error("quota"); } };
  const store = storeApi.createStore("trip-a", storage);
  const content = store.load({ metadata: { tripId: "trip-a" } });
  assert.throws(() => store.save(content), /保存失败.*quota/);
});

test("lodging and restaurant records with optional fields survive edits, deletes, and reloads", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("trip-content", storage);
  const content = store.load({ metadata: { tripId: "trip-content" }, accommodations: [], restaurants: [], days: [] });
  content.accommodations.push({ id: "stay-1", name: "", address: "", checkInDate: "", checkOutDate: "", bookingReference: "", contact: "", notes: "", documentUrl: "" });
  content.restaurants.push({ id: "restaurant-1", name: "", address: "", date: "", reservationTime: "", partySize: "", contact: "", bookingUrl: "", notes: "" });
  store.save(content);
  const changed = store.load();
  changed.accommodations[0].notes = "optional note";
  changed.restaurants[0].partySize = 2;
  store.save(changed);
  const reloaded = store.load();
  assert.equal(reloaded.accommodations[0].notes, "optional note");
  assert.equal(reloaded.restaurants[0].partySize, 2);
  reloaded.accommodations = reloaded.accommodations.filter((item) => item.id !== "stay-1");
  store.save(reloaded);
  assert.equal(store.load().accommodations.length, 0);
});

test("all supported transport types and itinerary links persist without copying flight or rental source data", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("transport-trip", storage);
  const source = { metadata: { tripId: "transport-trip" }, flights: [{ id: "flight-source" }], groundTransport: { rentalCar: { company: "Source rental" } }, days: [{ id: "day-1", day: 1, date: "2030-01-01", schedule: [] }] };
  const content = store.load(source);
  assert.deepEqual(content.transportRecords, []);
  for (const [index, type] of storeApi.TRANSPORT_TYPES.entries()) content.transportRecords.push({ id: `transport-${index}`, type, date: "2030-01-01", from: "", to: "", startTime: "", endTime: "", note: "", ticketIds: [], dayIds: ["day-1"] });
  content.days[0].schedule.push({ id: "item-1", time: "", endTime: "", text: "", location: "", details: "", note: "", ticketIds: ["ticket-1"], documentUrls: [], transportIds: ["transport-0"] });
  store.save(content);
  const reloaded = store.load();
  assert.equal(reloaded.transportRecords.length, 11);
  assert.deepEqual(reloaded.days[0].schedule[0].ticketIds, ["ticket-1"]);
  assert.deepEqual(reloaded.days[0].schedule[0].transportIds, ["transport-0"]);
  assert.throws(() => store.save({ ...reloaded, transportRecords: [...reloaded.transportRecords, { id: "bad-type", type: "spaceship" }] }), /交通方式无效/);
});

test("legacy transport fields normalize to one compatible passenger journey without mutating the source", () => {
  const legacy = { id: "rail-old", type: "high-speed-rail", passenger: "同行者 A", serviceNumber: "G123", from: "上海虹桥", to: "杭州东", date: "2030-06-01", startTime: "09:00", endTime: "10:00", seat: "05A", note: "旧备注" };
  const before = JSON.stringify(legacy);
  const journeys = storeApi.normalizePassengerJourneys(legacy);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].serviceNumber, "G123");
  assert.equal(journeys[0].passenger, "同行者 A");
  assert.deepEqual(journeys[0].travelerIds, []);
  assert.equal(storeApi.passengerJourneyAttachmentKey(legacy.id, journeys[0].id), "transport:rail-old:passenger:rail-old-passenger-1");
  assert.ok(storeApi.passengerJourneyAttachmentKey("x".repeat(180), "y".repeat(180)).length <= 180);
});

test("multiple passenger journeys preserve shared riders and different services in one transport segment", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("multi-leg-trip", storage);
  const content = store.load({ metadata: { tripId: "multi-leg-trip" } });
  content.transportRecords.push({ id: "rail-day-1", type: "high-speed-rail", direction: "outbound", passengerJourneys: [
    { id: "rail-same", type: "high-speed-rail", travelerIds: ["person-a", "person-b"], serviceNumber: "G123", from: "上海虹桥", to: "杭州东", startTime: "09:00", seat: "05A" },
    { id: "rail-other", type: "train", travelerIds: ["person-c"], serviceNumber: "G456", from: "上海南", to: "杭州东", startTime: "09:30", seat: "02B" }
  ] });
  store.save(content);
  const reloaded = store.load().transportRecords[0];
  assert.deepEqual(reloaded.passengerJourneys.map((journey) => journey.travelerIds), [["person-a", "person-b"], ["person-c"]]);
  assert.deepEqual(reloaded.passengerJourneys.map((journey) => journey.serviceNumber), ["G123", "G456"]);
  assert.notEqual(storeApi.passengerJourneyAttachmentKey(reloaded.id, "rail-same"), storeApi.passengerJourneyAttachmentKey(reloaded.id, "rail-other"));
  assert.throws(() => store.save({ ...store.load(), transportRecords: [{ ...reloaded, passengerJourneys: [{ id: "dup" }, { id: "dup" }] }] }), /重复的乘客行程 ID/);
});

test("multiple passenger journeys survive a D1 content round trip with stable attachment owners", async () => {
  const previousFetch = global.fetch;
  let cloudContent = null;
  let revision = 3;
  global.fetch = async (_url, init = {}) => {
    if (init.method === "PUT") {
      cloudContent = structuredClone(JSON.parse(init.body).content);
      revision += 1;
    }
    return { ok: true, async json() { return { content: structuredClone(cloudContent), revision }; } };
  };
  try {
    const sourceTrip = { metadata: { tripId: "d1-passenger-trip", title: "Existing title" } };
    const writer = storeApi.createCloudStore("d1-passenger-trip");
    const content = await writer.load(sourceTrip);
    content.transportRecords.push({ id: "outbound", type: "train", journeyRole: "outbound", passengerJourneys: [
      { id: "leg-a", type: "train", travelerIds: ["traveler-a"], serviceNumber: "FR 9512", from: "Firenze", to: "Milano", ticketIds: ["ticket-a"] },
      { id: "leg-b", type: "train", travelerIds: ["traveler-b"], serviceNumber: "FR 9630", from: "Roma", to: "Milano", ticketIds: ["ticket-b"] }
    ] });
    storeApi.validate(content, "d1-passenger-trip");
    await writer.save(content);
    const reloaded = await storeApi.createCloudStore("d1-passenger-trip").load(sourceTrip);
    const journeys = reloaded.transportRecords[0].passengerJourneys;
    assert.deepEqual(journeys.map((journey) => journey.id), ["leg-a", "leg-b"]);
    assert.deepEqual(journeys.map((journey) => journey.travelerIds), [["traveler-a"], ["traveler-b"]]);
    assert.deepEqual(journeys.map((journey) => journey.serviceNumber), ["FR 9512", "FR 9630"]);
    assert.notEqual(storeApi.passengerJourneyAttachmentKey("outbound", journeys[0].id), storeApi.passengerJourneyAttachmentKey("outbound", journeys[1].id));
  } finally { global.fetch = previousFetch; }
});

test("deleting one passenger journey leaves every other group and its attachment owner intact", () => {
  const store = storeApi.createStore("journey-delete-trip", memoryStorage());
  const content = store.load({ metadata: { tripId: "journey-delete-trip" } });
  content.transportRecords.push({ id: "outbound", type: "train", passengerJourneys: [
    { id: "leg-first", travelerIds: ["a"], serviceNumber: "G123" },
    { id: "leg-second", travelerIds: ["b"], serviceNumber: "G456" }
  ] });
  store.save(content);
  const draft = store.load();
  const record = draft.transportRecords[0];
  const removedKey = storeApi.passengerJourneyAttachmentKey(record.id, "leg-second");
  record.passengerJourneys = record.passengerJourneys.filter((journey) => journey.id !== "leg-second");
  store.save(draft);
  const reloaded = store.load().transportRecords[0];
  assert.deepEqual(reloaded.passengerJourneys.map((journey) => journey.id), ["leg-first"]);
  assert.equal(reloaded.passengerJourneys[0].serviceNumber, "G123");
  assert.notEqual(removedKey, storeApi.passengerJourneyAttachmentKey(reloaded.id, reloaded.passengerJourneys[0].id));
});

test("explicit journey roles persist, legacy direction remains explicit, and unmarked legacy transport stays unclassified", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("journey-role-trip", storage);
  const content = store.load({ metadata: { tripId: "journey-role-trip" } });
  content.transportRecords.push(
    { id: "outbound", type: "high-speed-rail", journeyRole: "outbound", passengerJourneys: [{ id: "out-leg", type: "high-speed-rail", from: "上海虹桥", to: "杭州东" }] },
    { id: "return", type: "train", journeyRole: "return", passengerJourneys: [{ id: "return-leg", type: "train", from: "杭州东", to: "南京南" }] },
    { id: "other", type: "metro", journeyRole: "other" },
    { id: "legacy-explicit", type: "flight", direction: "outbound" },
    { id: "legacy-unmarked", type: "flight", sourceType: "flight", sourceId: "old-flight" }
  );
  const saved = store.save(content);
  assert.equal(saved.transportRecords.find((item) => item.id === "outbound").journeyRole, "outbound");
  assert.equal(storeApi.journeyRoleFor(saved.transportRecords.find((item) => item.id === "legacy-explicit")), "outbound");
  assert.equal(storeApi.journeyRoleFor(saved.transportRecords.find((item) => item.id === "legacy-unmarked")), "");
  assert.equal(storeApi.journeyRoleFor(saved.transportRecords.find((item) => item.id === "other")), "other");
  assert.throws(() => store.save({ ...saved, transportRecords: [{ id: "bad-role", type: "train", journeyRole: "maybe" }] }), /方向无效/);
});

test("existing public rail and transit records are surfaced without copying flights or rental cars", () => {
  const content = storeApi.createInitialContent({
    metadata: { tripId: "existing-transit" },
    groundTransport: {
      publicTransitAndRail: [{ mode: "High-speed rail", departure: { date: "2030-01-01", time: "09:00", station: "North" }, arrival: { time: "11:00", station: "South" } }, { mode: "Flight", flightNumber: "F1" }, { mode: "Rental car", company: "R1" }],
      rentalCar: { company: "R1" }
    },
    flights: [{ id: "flight-1" }]
  });
  assert.equal(content.transportRecords.length, 1);
  assert.equal(content.transportRecords[0].type, "high-speed-rail");
  assert.equal(content.transportRecords[0].from, "North");
  assert.equal(content.transportRecords[0].to, "South");
});

test("itinerary details, related tickets and files are preserved while a day is edited", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("day-trip", storage);
  const content = store.load({ metadata: { tripId: "day-trip" }, days: [{ day: 1, date: "2030-02-01", title: "", locations: [], schedule: [{ time: "", endTime: "", text: "", location: "", details: "", note: "", ticketIds: [], documentUrls: [] }] }] });
  content.days[0].schedule[0] = { ...content.days[0].schedule[0], text: "", ticketIds: ["ticket-a"], documentUrls: ["https://example.invalid/ticket.pdf"] };
  store.save(content);
  const reloaded = store.load();
  reloaded.days[0].date = "2030-02-02";
  store.save(reloaded);
  assert.equal(store.load().days[0].date, "2030-02-02");
  assert.deepEqual(store.load().days[0].schedule[0].documentUrls, ["https://example.invalid/ticket.pdf"]);
  assert.deepEqual(store.load().days[0].schedule[0].ticketIds, ["ticket-a"]);
});

test("legacy todos without categories migrate safely and deleting a used category moves tasks", () => {
  const categories = storeApi.DEFAULT_CATEGORIES.map(([id, name]) => ({ id, name }));
  const legacy = [{ id: "todo-1", text: "", completed: true }, { id: "todo-2", text: "", completed: false, categoryId: "documents" }];
  const normalized = storeApi.normalizeTodos(legacy, categories);
  assert.equal(normalized[0].categoryId, "other");
  assert.equal(normalized[0].completed, true);
  const moved = storeApi.moveTasksBeforeCategoryDelete(normalized, categories, "other", "packing");
  assert.equal(moved.length, 2);
  assert.equal(moved[0].categoryId, "packing");
  assert.equal(moved[0].text, "");
  assert.equal(moved[0].completed, true);
  assert.throws(() => storeApi.moveTasksBeforeCategoryDelete(normalized, [categories.find((item) => item.id === "other")], "other", "other"), /有效的目标分类/);
});

test("adjacent travel connections retain stable ids and reject invalid or duplicate links", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("connection-trip", storage);
  const content = store.load({ metadata: { tripId: "connection-trip" }, days: [{ day: 1, date: "2030-05-01", schedule: [{ id: "stop-a" }, { id: "stop-b" }] }] });
  content.connections.push({ id: "leg-a-b", dayId: content.days[0].id, fromItemId: "stop-a", toItemId: "stop-b", mode: "walking", estimatedMinutes: 12, timeSource: "manual", distance: "850 m" });
  store.save(content);
  assert.equal(store.load().connections[0].id, "leg-a-b");
  assert.equal(storeApi.createStore("other-trip", storage).load({ metadata: { tripId: "other-trip" } }).connections.length, 0);
  assert.throws(() => store.save({ ...store.load(), connections: [{ ...content.connections[0], estimatedMinutes: 0 }] }), /1 到 1440 分钟/);
  assert.throws(() => store.save({ ...store.load(), connections: [...content.connections, { ...content.connections[0], id: "duplicate" }] }), /重复交通衔接/);
});

test("existing Phase 2 snapshots without connections migrate without losing records", () => {
  const storage = memoryStorage();
  const store = storeApi.createStore("phase2-trip", storage);
  const old = store.load({ metadata: { tripId: "phase2-trip" } });
  delete old.connections;
  old.accommodations.push({ id: "stay-kept", name: "" });
  storage.setItem(store.storageKey, JSON.stringify(old));
  const migrated = store.load();
  assert.deepEqual(migrated.connections, []);
  assert.equal(migrated.accommodations[0].id, "stay-kept");
});
