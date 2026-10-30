"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.resolve(__dirname, "../../travel-phase3-services.js"), "utf8");
const moduleForServices = { exports: {} };
const service = new Function("module", "exports", `${source}\nreturn module.exports;`)(moduleForServices, moduleForServices.exports);

test("map navigation URLs use only the selected provider and chosen route endpoints", () => {
  const base = { mode: "walking", fromLabel: "Origin", toLabel: "Destination", fromCoordinates: { lat: 1, lng: 2 }, toCoordinates: { lat: 3, lng: 4 } };
  const google = new URL(service.directionsUrl({ ...base, mapProvider: "google" }));
  assert.equal(google.hostname, "www.google.com");
  assert.equal(google.searchParams.get("origin"), "1,2");
  assert.equal(google.searchParams.get("destination"), "3,4");
  assert.equal(google.searchParams.get("travelmode"), "walking");
  assert.equal(new URL(service.directionsUrl({ ...base, mapProvider: "apple" })).hostname, "maps.apple.com");
  assert.equal(new URL(service.directionsUrl({ ...base, mapProvider: "openstreetmap" })).hostname, "www.openstreetmap.org");
  assert.equal(service.directionsUrl({ ...base, mapProvider: "amap" }), "");
  assert.match(service.directionsUrl({ ...base, mapProvider: "amap", fromCoordinates: { lat: 1, lng: 2, system: "GCJ-02" }, toCoordinates: { lat: 3, lng: 4, system: "GCJ-02" } }), /^https:\/\/uri\.amap\.com\/navigation/);
});

test("map links are restricted to the explicitly selected and allowlisted provider", () => {
  assert.equal(service.allowedMapUrl("https://www.google.com/maps/dir/?api=1", "google"), true);
  assert.equal(service.allowedMapUrl("https://maps.apple.com/?q=Rome", "apple"), true);
  assert.equal(service.allowedMapUrl("https://www.openstreetmap.org/search?query=Rome", "openstreetmap"), true);
  assert.equal(service.allowedMapUrl("https://uri.amap.com/search?keyword=Shanghai", "amap"), true);
  assert.equal(service.allowedMapUrl("https://attacker.example/maps", "google"), false);
  assert.equal(service.allowedMapUrl("https://maps.google.com.evil.example/maps", "google"), false);
  assert.equal(service.allowedMapUrl("http://maps.apple.com/?q=Rome", "apple"), false);
  assert.equal(service.allowedMapUrl("https://www.google.com/maps/dir/", "apple"), false);
});

test("OSRM estimate sends only coordinates/profile and returns route-derived duration and distance", async () => {
  let requestUrl = "";
  const fetchImpl = async (url) => {
    requestUrl = url;
    return { ok: true, json: async () => ({ code: "Ok", routes: [{ duration: 751, distance: 1520 }] }) };
  };
  const result = await service.estimateRoute({ mode: "walking", fromCoordinates: { lat: 31.2, lng: 121.4 }, toCoordinates: { lat: 31.21, lng: 121.42 }, fetchImpl });
  assert.match(requestUrl, /^https:\/\/router\.project-osrm\.org\/route\/v1\/foot\/121\.4,31\.2;121\.42,31\.21/);
  assert.equal(requestUrl.includes("Origin"), false);
  assert.equal(result.estimatedMinutes, 13);
  assert.equal(result.distance, "1.5 km");
  assert.equal(result.timeSource, "route");
  await assert.rejects(service.estimateRoute({ mode: "metro", fromCoordinates: { lat: 1, lng: 2 }, toCoordinates: { lat: 3, lng: 4 }, fetchImpl }), /手动填写/);
  await assert.rejects(service.estimateRoute({ mode: "walking", fromCoordinates: { lat: 1, lng: 2, system: "gcj02" }, toCoordinates: { lat: 3, lng: 4, system: "wgs84" }, fetchImpl }), /WGS-84/);
});

test("a route refresh never overwrites a manual travel time unless the user explicitly applies it", () => {
  const current = { estimatedMinutes: "12", distance: "manual distance", timeSource: "manual" };
  const route = { estimatedMinutes: 7, distance: "900 m", timeSource: "route" };
  const suggested = service.mergeRouteEstimate(current, route);
  assert.equal(suggested.applied, false);
  assert.equal(suggested.estimatedMinutes, "12");
  assert.equal(suggested.distance, "manual distance");
  const applied = service.mergeRouteEstimate(current, route, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.estimatedMinutes, 7);
  assert.equal(applied.distance, "manual distance");
  assert.equal(applied.timeSource, "route");
});

test("weather query sends only the selected location and date, with forecasts limited to the selected day", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    if (calls.length === 1) return { ok: true, json: async () => ({ results: [{ name: "Sample City", admin1: "Region", country: "Country", latitude: 10, longitude: 20 }] }) };
    return { ok: true, json: async () => ({ timezone: "Etc/GMT-1", daily: { time: ["2030-01-03"], weather_code: [2], temperature_2m_max: [22.4], temperature_2m_min: [12.2], precipitation_probability_max: [30] } }) };
  };
  const result = await service.getWeather({ date: "2030-01-03", location: "Sample City", fetchImpl, now: new Date("2030-01-01T10:00:00") });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].hostname, "geocoding-api.open-meteo.com");
  assert.equal(calls[0].searchParams.get("name"), "Sample City");
  assert.equal(calls[1].hostname, "api.open-meteo.com");
  assert.equal(calls[1].searchParams.get("start_date"), "2030-01-03");
  assert.equal(calls[1].searchParams.get("end_date"), "2030-01-03");
  assert.deepEqual([calls[1].searchParams.get("latitude"), calls[1].searchParams.get("longitude")], ["10", "20"]);
  assert.equal(result.condition, "局部多云");
  assert.equal(result.rainProbability, 30);
});

test("weather beyond 16-day range makes no external request", async () => {
  let called = false;
  const result = await service.getWeather({ date: "2030-02-01", location: "Private place", fetchImpl: async () => { called = true; }, now: new Date("2030-01-01T10:00:00") });
  assert.equal(called, false);
  assert.equal(result.available, false);
  assert.match(result.message, /未来 16 天/);
});

test("weather geocodes a named location instead of sending non-WGS coordinates", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    if (calls.length === 1) return { ok: true, json: async () => ({ results: [{ name: "Place", latitude: 10, longitude: 20 }] }) };
    return { ok: true, json: async () => ({ daily: { time: ["2030-01-02"], weather_code: [0] } }) };
  };
  await service.getWeather({ date: "2030-01-02", location: "Place", coordinates: { lat: 10.1, lng: 20.1, system: "gcj02" }, fetchImpl, now: new Date("2030-01-01T10:00:00") });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].hostname, "geocoding-api.open-meteo.com");
  assert.equal(calls[0].searchParams.get("name"), "Place");
  assert.equal(calls[1].searchParams.get("latitude"), "10");
  assert.equal(calls[1].searchParams.get("longitude"), "20");
});
