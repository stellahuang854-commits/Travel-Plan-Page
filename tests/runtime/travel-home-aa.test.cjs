"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const editor = fs.readFileSync(path.join(root, "travel-content-editor.js"), "utf8");
const ledger = fs.readFileSync(path.join(root, "ledger.js"), "utf8");
const ledgerCss = fs.readFileSync(path.join(root, "ledger.css"), "utf8");

test("homepage order places the title first and outbound/return before every other travel section", () => {
  const title = html.indexOf("id=\"trip-title\"");
  const tripDate = html.indexOf("id=\"trip-date\"");
  const status = html.indexOf("id=\"trip-status\"");
  const flights = html.indexOf("id=\"flights\"");
  const overview = html.indexOf("id=\"trip-overview\"");
  const route = html.indexOf("id=\"route\"");
  const itinerary = html.indexOf("id=\"itinerary\"");
  const drive = html.indexOf("id=\"drive\"");
  const prep = html.indexOf("id=\"prep\"");
  assert.ok(title >= 0 && title < tripDate && tripDate < status && status < flights);
  assert.ok(flights < overview && overview < route && route < itinerary && itinerary < drive && drive < prep);
  assert.match(html.slice(flights, route), /去程与回程交通/);
});

test("homepage shows title, dates and status before the home modules and uses independent swipeable passenger journey cards", () => {
  assert.match(html, /id="day-page"[^>]*hidden/);
  assert.match(app, /function renderTripOverview\(/);
  assert.match(app, /function renderDayOverviewCard\(/);
  assert.match(app, /function currentTripStatus\(/);
  assert.match(app, /startNumber - todayNumber/);
  assert.match(app, /旅行中 · Day/);
  assert.match(app, /function renderPageRoute\(/);
  assert.match(app, /const routeKey = day\.date \|\| `id=\$\{day\.id\}`/);
  assert.match(app, /location\.hash\.match\(\/\^#day\\\/\(\.\+\)\$\/\)/);
  assert.match(editor, /旅行开始日期", "startDate"/);
  assert.match(editor, /旅行结束日期", "endDate"/);
  assert.match(fs.readFileSync(path.join(root, "travel-content-view.js"), "utf8"), /mini-boarding-pass--journey/);
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(css, /\.flight-carousel\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /scroll-snap-type:\s*x\s+mandatory/);
  assert.match(css, /#day-page\[hidden\]/);
});

test("day page uses a per-day hash route and exposes edit and map hosts for that day's timeline", () => {
  assert.match(html, /id="day-page-edit"/);
  assert.match(html, /id="day-route-map"/);
  assert.match(html, /id="day-timeline"/);
  assert.match(app, /window\.addEventListener\("hashchange", renderPageRoute\)/);
  assert.match(app, /TravelContentEditor\?\.openDay/);
  assert.match(app, /TravelContentEditor\?\.openDayItem/);
  assert.match(editor, /function openDayItem\(dayId, itemId = ""\)/);
  const routeUi = fs.readFileSync(path.join(root, "route-ui.js"), "utf8");
  assert.match(routeUi, /renderDayMap\(dayNumber\)/);
  assert.match(routeUi, /travelMapSourceForDay\(state\.data\?\.routeMap/);
  assert.match(app, /dayCard\(day, \{ includeWeather: false \}\)/);
});

test("home always shows two empty add prompts without inventing transport, and each prompt opens a role-specific editor", () => {
  assert.match(app, /if \(element\.id === "flights" \|\| element\.id === "ledger-navigation-link"\)\s*\{\s*element\.hidden = false/s);
  assert.match(app, /openTransportForRole\?\.\(addTransport\.dataset\.addTransport\)/);
  assert.match(editor, /function openTransportForRole\(role\)/);
  assert.match(editor, /openForm\("transportRecords", \{ type: "other", journeyRole \}\)/);
  const view = fs.readFileSync(path.join(root, "travel-content-view.js"), "utf8");
  assert.match(view, /尚未添加 · 添加\$\{label\}交通/);
  assert.match(view, /data-add-transport="\$\{role\}"/);
});

test("AA navigation is always available and cloud mode is explicitly passed to the existing ledger", () => {
  assert.match(html, /id="ledger-navigation-link"[^>]*>AA \/ 账本/);
  assert.match(html, /id="ledger-root"/);
  assert.match(app, /if \(name === "ledger"\) return true/);
  assert.match(app, /sharedCollections: \["ledger"\]/);
  assert.match(ledger, /function createD1Adapter\(/);
  assert.match(ledger, /function calculateStats\(/);
  assert.match(ledger, /function calculateBillShares\(/);
  assert.match(ledger, /data-ledger-action="edit-bill"/);
  assert.match(ledger, /data-ledger-action="delete-bill"/);
  assert.match(ledger, /谁需要转给谁/);
});

test("AA narrow layouts constrain width and reflow forms and settlement details", () => {
  assert.match(ledgerCss, /\.ledger-app\s*\{[^}]*width:\s*min\(100%,\s*720px\)/s);
  assert.match(ledgerCss, /@media\s*\(max-width:\s*420px\)/);
  assert.match(ledgerCss, /\.ledger-split-mode-options\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(ledgerCss, /\.ledger-transfer-list|\.ledger-transfer/);
  assert.match(ledgerCss, /min-width:\s*0/);
});
