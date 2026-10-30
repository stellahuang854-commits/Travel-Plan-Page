"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const scriptModule = import("../../scripts/initialize-public-trip.mjs");
const root = path.resolve(__dirname, "../..");

test("public trip initializer seeds only the existing template and uses insert-only idempotent SQL", async () => {
  const template = JSON.parse(await readFile(path.join(root, "trip-data.json"), "utf8"));
  const { createSeedSql } = await scriptModule;
  const sql = createSeedSql(template, "2026-10-30T12:00:00.000Z");
  assert.match(sql, /INSERT OR IGNORE INTO trips/);
  assert.match(sql, /INSERT OR IGNORE INTO trip_state /);
  assert.match(sql, /INSERT OR IGNORE INTO trip_state_history/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM trips WHERE id='unconfigured'\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM trip_state WHERE trip_id='unconfigured'\)/);
  assert.match(sql, /"tripId":"unconfigured"/);
  assert.match(sql, /"mode":"d1"/);
  assert.match(sql, /"days":\[\]/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|REPLACE)\s/i);
  assert.doesNotMatch(sql, /trip_members|trip_invitations|trip_attachments/);
});

test("public trip initializer rejects malformed templates without emitting SQL", async () => {
  const { createSeedSql } = await scriptModule;
  assert.throws(() => createSeedSql({ schemaVersion: "bad" }), /不是可初始化的旅行模板/);
  assert.throws(() => createSeedSql({ schemaVersion: "2.0-lite", config: { schemaVersion: "1.0.0" }, metadata: { tripId: "bad/id" } }), /tripId 无效/);
  const template = JSON.parse(await readFile(path.join(root, "trip-data.json"), "utf8"));
  assert.throws(() => createSeedSql({ ...template, days: [{ id: "real-data" }] }), /只允许初始化当前未配置的空白模板/);
});
