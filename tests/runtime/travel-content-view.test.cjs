"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../../travel-content-store.js"), "utf8");
const moduleForStore = { exports: {} };
const store = new Function("module", "exports", `${source}\nreturn module.exports;`)(moduleForStore, moduleForStore.exports);
global.window = { TravelContentStore: store };
const viewModule = { exports: {} };
const viewSource = fs.readFileSync(path.resolve(__dirname, "../../travel-content-view.js"), "utf8");
const view = new Function("module", "exports", `${viewSource}\nreturn module.exports;`)(viewModule, viewModule.exports);

function emptyContent(tripId = "view-trip") {
  return { version: 1, tripId, accommodations: [], transportRecords: [], restaurants: [], days: [], todoCategories: [{ id: "other", name: "Other" }], connections: [] };
}

test("normal browse view renders the newest saved content after a store reload", () => {
  const records = new Map();
  const storage = { getItem: (key) => records.get(key) ?? null, setItem: (key, value) => records.set(key, String(value)) };
  const contentStore = store.createStore("view-trip", storage);
  const content = contentStore.load({ metadata: { tripId: "view-trip" } });
  content.accommodations.push({ id: "stay-new", name: "Newest stay", address: "Latest address" });
  content.restaurants.push({ id: "restaurant-new", name: "Newest restaurant", date: "2030-08-01" });
  contentStore.save(content);
  const latest = contentStore.load();
  const html = view.renderPublicContent(latest);
  assert.match(html, /Newest stay/);
  assert.match(html, /Latest address/);
  assert.match(html, /Newest restaurant/);
});

test("D1 content endpoint snapshot, rather than the static trip package, feeds the normal view after reload", async () => {
  const previousFetch = global.fetch;
  let revision = 4;
  let remoteContent = emptyContent("cloud-trip");
  remoteContent.metadata = { title: "Initial cloud title" };
  remoteContent.restaurants.push({ id: "remote-restaurant", name: "Saved remotely" });
  global.fetch = async (_url, options = {}) => {
    if (options.method === "PUT") {
      remoteContent = JSON.parse(options.body).content;
      revision += 1;
      return new Response(JSON.stringify({ revision }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ revision, content: remoteContent }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const firstDevice = store.createCloudStore("cloud-trip");
    const packageTemplate = { metadata: { tripId: "cloud-trip" }, restaurants: [{ id: "static-old", name: "Old static package" }] };
    const loaded = await firstDevice.load(packageTemplate);
    assert.equal(loaded.restaurants[0].name, "Saved remotely");
    loaded.metadata.title = "Edited title from this device";
    loaded.accommodations.push({ id: "stay-cloud", name: "Saved in D1" });
    await firstDevice.save(loaded);
    const secondDevice = store.createCloudStore("cloud-trip");
    const afterReload = await secondDevice.load(packageTemplate);
    assert.equal(afterReload.metadata.title, "Edited title from this device");
    const html = view.renderPublicContent(afterReload);
    assert.match(html, /Saved in D1/);
    assert.match(html, /Saved remotely/);
    assert.doesNotMatch(html, /Old static package/);
  } finally { global.fetch = previousFetch; }
});

test("older D1 content without a title falls back to the existing package metadata title", async () => {
  const previousFetch = global.fetch;
  const legacy = emptyContent("cloud-legacy");
  delete legacy.metadata;
  global.fetch = async () => new Response(JSON.stringify({ revision: 1, content: legacy }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const cloudStore = store.createCloudStore("cloud-legacy");
    const loaded = await cloudStore.load({ metadata: { tripId: "cloud-legacy", title: "Original metadata name" } });
    assert.equal(loaded.metadata.title, "Original metadata name");
    assert.deepEqual(loaded.connections, []);
  } finally { global.fetch = previousFetch; }
});

test("homepage boarding passes show only explicit outbound and return passenger journeys", () => {
  const content = emptyContent();
  content.transportRecords.push(
    { id: "outbound-record", type: "high-speed-rail", journeyRole: "outbound", passengerJourneys: [
      { id: "out-a", type: "high-speed-rail", travelerIds: ["a"], serviceNumber: "G123", from: "上海虹桥", to: "杭州东", date: "2030-08-01", startTime: "09:00", endTime: "09:45" },
      { id: "out-b", type: "train", travelerIds: ["b"], serviceNumber: "G456", from: "南京南", to: "杭州东", date: "2030-08-01", startTime: "10:00", endTime: "11:10" }
    ] },
    { id: "return-record", type: "train", journeyRole: "return", passengerJourneys: [
      { id: "return-a", type: "train", travelerIds: ["a", "b"], serviceNumber: "G789", from: "杭州东", to: "上海虹桥", startTime: "15:00", endTime: "16:00" },
      { id: "return-b", type: "train", travelerIds: ["c"], serviceNumber: "G790", from: "杭州东", to: "南京南", startTime: "16:00", endTime: "17:10" }
    ] },
    { id: "other-record", type: "metro", journeyRole: "other", passengerJourneys: [{ id: "other-leg", type: "metro", serviceNumber: "M1" }] },
    { id: "legacy-unmarked", type: "flight", sourceType: "flight", sourceId: "old-flight", passengerJourneys: [{ id: "unmarked-leg", type: "flight", serviceNumber: "OLD1" }] }
  );
  const travelers = [{ id: "a", name: "同行者 A" }, { id: "b", name: "同行者 B" }, { id: "c", name: "同行者 C" }];
  const html = view.renderBoardingPasses(content, travelers);
  assert.match(html, /去程/);
  assert.match(html, /回程/);
  assert.match(html, /同行者 A/);
  assert.match(html, /同行者 B/);
  assert.match(html, /上海虹桥 → 杭州东/);
  assert.match(html, /南京南 → 杭州东/);
  assert.match(html, /杭州东 → 南京南/);
  assert.match(html, /G123/);
  assert.match(html, /G456/);
  assert.match(html, /G789/);
  assert.match(html, /同行者 A、同行者 B/);
  assert.equal((html.match(/mini-boarding-pass--groups/g) || []).length, 2);
  assert.doesNotMatch(html, /OLD1|M1/);
  assert.match(html, new RegExp(store.passengerJourneyAttachmentKey("outbound-record", "out-a")));
  assert.match(html, new RegExp(store.passengerJourneyAttachmentKey("return-record", "return-b")));
});

test("a legacy record without journeyRole does not create an outbound or return boarding pass", () => {
  const content = emptyContent();
  content.transportRecords.push({ id: "legacy", type: "flight", sourceType: "flight", sourceId: "legacy-flight", passengerJourneys: [{ id: "leg", type: "flight", serviceNumber: "F123" }] });
  const html = view.renderBoardingPasses(content);
  assert.equal((html.match(/mini-boarding-pass--empty/g) || []).length, 2);
  assert.doesNotMatch(html, /F123/);
});

test("unclassified original flight data remains available in the normal travel archive", () => {
  const content = emptyContent();
  const sourceData = {
    flights: [{ id: "legacy-flight-1", journeyId: "legacy-journey", flightNumber: "CA123", departure: { city: "上海", date: "2030-08-01", time: "09:00" }, arrival: { city: "杭州", time: "10:00" } }],
    flightJourneys: [{ id: "legacy-journey" }]
  };
  const html = view.renderPublicContent(content, [], {}, sourceData);
  assert.match(html, /航班资料（未分类）/);
  assert.match(html, /CA123/);
  assert.match(html, /上海 → 杭州/);
  assert.match(html, /未分类方向/);
  assert.match(html, /data-journey-detail="legacy-journey"/);
  assert.doesNotMatch(view.renderBoardingPasses(content, []), /CA123/);
});

test("mobile boarding pass layout stacks directions and preserves narrow content width", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../../styles.css"), "utf8");
  assert.match(css, /@media\s*\(max-width:\s*600px\)\s*\{[^}]*\.flight-carousel\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.mini-boarding-pass__traveler\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.mini-boarding-pass__traveler\s+small\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test("normal browse view keeps different passenger services and their attachment links separate", () => {
  const content = emptyContent();
  content.transportRecords.push({ id: "rail-day", type: "high-speed-rail", direction: "outbound", passengerJourneys: [
    { id: "leg-a", type: "high-speed-rail", travelerIds: ["a", "b"], serviceNumber: "G123", from: "上海虹桥", to: "杭州东", date: "2030-08-01", startTime: "09:00", endTime: "10:00" },
    { id: "leg-b", type: "train", travelerIds: ["c"], serviceNumber: "G456", from: "上海南", to: "杭州东", date: "2030-08-01", startTime: "09:30", endTime: "10:30" }
  ] });
  const firstAttachment = store.passengerJourneyAttachmentKey("rail-day", "leg-a");
  const secondAttachment = store.passengerJourneyAttachmentKey("rail-day", "leg-b");
  const html = view.renderPublicContent(content, [{ id: "a", name: "同行者 A" }, { id: "b", name: "同行者 B" }, { id: "c", name: "同行者 C" }], { [firstAttachment]: 1, [secondAttachment]: 2 });
  assert.match(html, /同行者 A、同行者 B/);
  assert.match(html, /G123/);
  assert.match(html, /同行者 C/);
  assert.match(html, /G456/);
  assert.match(html, new RegExp(firstAttachment));
  assert.match(html, new RegExp(secondAttachment));
  assert.match(html, /详情 \/ 票据（2）/);
});

test("legacy single passenger data remains visible and unsafe document protocols are not rendered", () => {
  const content = emptyContent();
  content.accommodations.push({ id: "stay-legacy", name: "Legacy inn", documentUrl: "javascript:alert(1)" });
  content.transportRecords.push({ id: "old-rail", type: "high-speed-rail", passenger: "旧同行者", serviceNumber: "G789", from: "出发站", to: "到达站", startTime: "08:00" });
  const html = view.renderPublicContent(content);
  assert.match(html, /Legacy inn/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.match(html, /旧同行者/);
  assert.match(html, /G789/);
});

test("normal archive attachment inventory can be loaded once and stays scoped to the selected trip", async () => {
  const previousFetch = global.fetch;
  global.window.TRAVEL_PLAN_CONFIG = { persistence: { mode: "d1", apiBase: "/api/trip" } };
  const source = fs.readFileSync(path.resolve(__dirname, "../../travel-attachment-store.js"), "utf8");
  new Function(source)();
  global.fetch = async () => new Response(JSON.stringify({ attachments: [
    { id: "a", tripId: "trip-a", transportId: "record-a" },
    { id: "b", tripId: "trip-a", transportId: "leg-a" },
    { id: "c", tripId: "trip-b", transportId: "leg-a" }
  ] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const all = await global.window.TravelAttachmentStore.list("trip-a");
    assert.deepEqual(all.map((item) => item.id), ["a", "b"]);
    const oneLeg = await global.window.TravelAttachmentStore.list("trip-a", "leg-a");
    assert.deepEqual(oneLeg.map((item) => item.id), ["b"]);
  } finally { global.fetch = previousFetch; }
});
