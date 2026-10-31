"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8");
function functionSource(name) {
  const match = app.match(new RegExp(`function ${name}[^\\n]*\\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(match, `expected ${name} helper to exist`);
  return match[0];
}
const dates = new Function(`${functionSource("calendarDayNumber")}\n${functionSource("browserCalendarDate")}\n${functionSource("currentTripStatus")}\nreturn { calendarDayNumber, browserCalendarDate, currentTripStatus };`)();

test("trip status handles before, during, after, and missing dates using calendar days", () => {
  assert.equal(dates.currentTripStatus("2026-12-20", "2026-12-28", "2026-12-19"), "距离出发还有 1 天");
  assert.equal(dates.currentTripStatus("2026-12-20", "2026-12-28", "2026-12-20"), "旅行中 · Day 1");
  assert.equal(dates.currentTripStatus("2026-12-20", "2026-12-28", "2026-12-22"), "旅行中 · Day 3");
  assert.equal(dates.currentTripStatus("2026-12-20", "2026-12-28", "2026-12-29"), "旅行结束 · 1 天前");
  assert.equal(dates.currentTripStatus("", "", "2026-12-20"), "旅行日期尚未设置");
  assert.equal(dates.calendarDayNumber("2026-03-08") - dates.calendarDayNumber("2026-03-07"), 1);
  assert.equal(dates.browserCalendarDate(new Date(2026, 11, 20, 23, 59)), "2026-12-20");
});

test("homepage overview and each Day route derive their visible content from saved trip data", () => {
  assert.match(app, /const days = orderedTripDays\(\)/);
  assert.match(app, /day\.schedule \|\| \[\]/);
  assert.match(app, /day\.locations \|\| \[\]/);
  assert.match(app, /item\.date === routeKey/);
  assert.match(app, /item\.id === routeKey\.slice\(3\)/);
  assert.match(app, /TravelRouteUI\?\.renderDayMap\?\.\(day\.day\)/);
  assert.match(app, /function renderDayOverviewCard\(/);
  assert.match(app, /function renderTripOverview\(/);
  assert.match(app, /TravelContentEditor\?\.openDay\?\.\(day\.id\)/);
});

test("daily map filtering includes only locations named by that day's itinerary", () => {
  const routeUi = fs.readFileSync(path.resolve(__dirname, "../../route-ui.js"), "utf8");
  const api = new Function("window", `${routeUi}\nreturn window.TravelRouteUI;`)({});
  const layers = [
    { id: "hotel", label: "Hotel", lines: ["Hotel"] },
    { id: "museum", label: "Museo", lines: ["Museo"] },
    { id: "other-day", label: "Other city", lines: ["Other city"] }
  ];
  const layout = { places: ["hotel", "museum", "other-day"] };
  const day = { locations: [], schedule: [{ location: "Hotel" }, { placeName: "Museo" }] };
  assert.deepEqual(api.itineraryMapPlaceIds(day, layout, layers, () => null), ["hotel", "museum"]);
  assert.deepEqual(api.itineraryMapPlaceIds({ schedule: [] }, layout, layers, () => null), []);
});
