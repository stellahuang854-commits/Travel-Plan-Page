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
  assert.match(app, /TravelRouteUI\?\.renderItineraryDayMap\?\.\(day\)/);
  assert.match(app, /DAY \$\{String\(dayIndex \+ 1\)\.padStart\(2, "0"\)\}/);
  assert.match(app, /function dayRegionLabel\(day\)/);
  assert.match(app, /尚未设置地区/);
  assert.match(app, /function renderDayOverviewCard\(/);
  assert.match(app, /function renderTripOverview\(/);
  assert.match(app, /TravelContentEditor\?\.openDay\?\.\(day\.id\)/);
  assert.match(fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8"), /id="day-index-list"/);
});

test("homepage Day cards render empty date routes without guessing city or schedule values", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  const esc = (value) => String(value).replace(/[&<>\'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const functions = ["dayRegionLabel", "dayCardDateLabel", "renderDayOverviewCard"].map(functionSource).join("\n");
  const render = new Function("window", "state", "escapeHtml", `${functions}\nreturn renderDayOverviewCard;`)(
    { TravelContentEditor: { getContent: () => ({ connections: [] }) } },
    { data: { groundTransport: { publicTransitAndRail: [] } } },
    esc
  );
  const markup = render({ id: "calendar-day-2026-12-21", date: "2026-12-21", day: 2, schedule: [] }, 1);
  assert.match(html, /id="day-index"/);
  assert.match(markup, /DAY 02/);
  assert.match(markup, /12\.21/);
  assert.match(markup, /尚未设置地区/);
  assert.match(markup, /尚未安排行程/);
  assert.match(markup, /href="#day\/2026-12-21"/);
  assert.doesNotMatch(markup, /Firenze|Milano|09:00/);
});

test("Day page has its own readable Day Tag, interactive map controls and per-location inspiration links", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  const routeUi = fs.readFileSync(path.resolve(__dirname, "../../route-ui.js"), "utf8");
  assert.match(html, /class="day-page-tag"/);
  assert.match(html, /id="day-page-kicker"/);
  assert.match(html, /id="day-page-title"/);
  assert.match(routeUi, /data-day-map-zoom="in"/);
  assert.match(routeUi, /data-day-map-zoom="out"/);
  assert.match(routeUi, /pointermove/);
  assert.match(app, /href="#inspiration\?item=/);
  assert.match(app, /打开地图|查看 \$\{escapeHtml\(destination\.label\)\} 的地图/);
  assert.match(html, /href="#day-index">← 返回每日行程总览/);
  assert.match(app, /这一天还没有可显示在地图上的地点/);
});

test("home exposes the Day index after the overview map and before later travel sections", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  const overview = html.indexOf('id="trip-overview"');
  const route = html.indexOf('id="route"');
  const dayIndex = html.indexOf('id="day-index"');
  const itinerary = html.indexOf('id="itinerary"');
  assert.ok(overview >= 0 && overview < route && route < dayIndex && dayIndex < itinerary);
  assert.match(html.slice(dayIndex, itinerary), /id="day-index-list"/);
  assert.match(app, /renderTimeline\(\);\s*renderTripOverview\(\);\s*renderPageRoute\(\);/);
});

test("narrow Day cards and Day pages do not introduce a horizontal scroller", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../../styles.css"), "utf8");
  const inspirationCss = fs.readFileSync(path.resolve(__dirname, "../../travel-inspiration.css"), "utf8");
  assert.match(css, /\.day-index-list\s*\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.day-overview-card\s*\{[^}]*min-width:0/);
  assert.match(css, /\.day-overview-card__summary\s*\{[^}]*overflow-wrap:anywhere/);
  assert.match(inspirationCss, /\.inspiration-day-option\s*\{[^}]*min-width:0/);
  assert.match(inspirationCss, /\.inspiration-day-option strong,.inspiration-day-option small\s*\{\s*overflow-wrap:anywhere/);
  assert.match(inspirationCss, /@media\(max-width:640px\)\s*\{[\s\S]*?\.inspiration-day-option/);
  assert.match(css, /\.day-overview-card\s*\{[^}]*display:flex;\s*flex-direction:column/s);
  assert.match(css, /\.day-overview-card__arrow\s*\{[^}]*position:static/s);
  assert.match(css, /\.day-overview-card__arrow\s*\{[^}]*transform:none/s);
  assert.doesNotMatch(css, /\.day-overview-card__arrow\s*\{[^}]*position:absolute/s);
  assert.doesNotMatch(css, /@media\(min-width:700px\)\s*\{[^}]*\.day-overview-card\s*\{[^}]*grid-template-columns/s);
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
