import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "travel-plan-private-db";
const databaseId = "0f21ffd7-f9a7-4de8-b93a-ec95a497c61b";
const publicActor = "public-single-trip-site";

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function createSeedSql(template, createdAt = new Date().toISOString()) {
  if (!template || template.schemaVersion !== "2.0-lite" || template.config?.schemaVersion !== "1.0.0") {
    throw new Error("trip-data.json 不是可初始化的旅行模板。");
  }
  const tripId = String(template.metadata?.tripId || "").trim();
  if (!tripId || tripId.length > 128 || !/^[\p{L}\p{N}._:-]+$/u.test(tripId)) throw new Error("模板 tripId 无效。");
  const emptyArrays = [
    template.flightJourneys, template.flights, template.accommodations, template.days, template.places,
    template.restaurants, template.bookingsAndTickets, template.ticketPlanning?.items,
    template.preTrip?.packingItems, template.preTrip?.preparationsExplicitlyMentioned,
    template.groundTransport?.rentalChecklist, template.groundTransport?.drivingNotes,
    template.groundTransport?.drivingReferenceLinks, template.groundTransport?.plannedRoadLegs,
    template.groundTransport?.publicTransitAndRail, template.trip?.countries,
    template.trip?.primaryDestinationCountries, template.trip?.citiesAndAreas,
    template.map?.places, template.map?.routes, template.map?.dailyRoutes,
    template.mapLinks?.providedGoogleMapsLinks, template.mapLinks?.navigationPlaces,
    template.issuesAndUncertainties
  ];
  if (tripId !== "unconfigured" || template.trip?.status !== "uninitialized"
      || emptyArrays.some((items) => Array.isArray(items) && items.length > 0)
      || template.groundTransport?.rentalCar
      || template.trip?.startDate || template.trip?.endDate || template.trip?.routeSummary
      || template.config.modules && Object.values(template.config.modules).some(Boolean)) {
    throw new Error("只允许初始化当前未配置的空白模板；模板已有旅行资料时已停止。");
  }
  const tripPackage = structuredClone(template);
  tripPackage.config.persistence = { mode: "d1", apiBase: "/api/trip", sharedCollections: ["todos", "tickets", "ledger"] };

  const state = {
    package: tripPackage,
    content: null,
    runtime: { version: 1, settings: null, bills: [], travelers: [], todos: [], tickets: [], updatedAt: createdAt }
  };
  const stateJson = JSON.stringify(state);
  const tripTitle = String(tripPackage.metadata.title || "旅行计划").slice(0, 160);
  const id = sqlString(tripId);
  const stateValue = sqlString(stateJson);
  const title = sqlString(tripTitle);
  const actor = sqlString(publicActor);
  const timestamp = sqlString(createdAt);

  return [
    "PRAGMA foreign_keys = ON;",
    `INSERT OR IGNORE INTO trips (id,title,owner_id,created_at) SELECT ${id},${title},${actor},${timestamp} WHERE NOT EXISTS (SELECT 1 FROM trips WHERE id=${id}) AND NOT EXISTS (SELECT 1 FROM trip_state WHERE trip_id=${id}) AND NOT EXISTS (SELECT 1 FROM trips WHERE id <> ${id}) AND NOT EXISTS (SELECT 1 FROM trip_state WHERE json_valid(state_json) AND json_type(state_json,'$.package')='object');`,
    `INSERT OR IGNORE INTO trip_state (trip_id,state_json,revision,updated_at,updated_by) SELECT ${id},${stateValue},0,${timestamp},${actor} WHERE EXISTS (SELECT 1 FROM trips WHERE id=${id}) AND NOT EXISTS (SELECT 1 FROM trip_state WHERE trip_id=${id}) AND NOT EXISTS (SELECT 1 FROM trips WHERE id <> ${id}) AND NOT EXISTS (SELECT 1 FROM trip_state WHERE json_valid(state_json) AND json_type(state_json,'$.package')='object');`,
    `INSERT OR IGNORE INTO trip_state_history (trip_id,revision,state_json,updated_at,updated_by) SELECT trip_id,revision,state_json,updated_at,updated_by FROM trip_state WHERE trip_id=${id} AND revision=0 AND state_json=${stateValue};`,
    `SELECT trip_id,revision,json_extract(state_json,'$.package.metadata.tripId') AS package_trip_id,json_extract(state_json,'$.package.config.persistence.mode') AS persistence_mode,json_array_length(json_extract(state_json,'$.package.days')) AS day_count FROM trip_state WHERE trip_id=${id};`
  ].join("\n");
}

async function main() {
  const wranglerConfig = await readFile(path.join(root, "wrangler.toml"), "utf8");
  const d1Section = wranglerConfig.match(/\[\[d1_databases\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)/)?.[1] || "";
  if (!d1Section.includes(`binding = "TRAVEL_DB"`)
      || !d1Section.includes(`database_name = "${databaseName}"`)
      || !d1Section.includes(`database_id = "${databaseId}"`)) {
    throw new Error("wrangler.toml 的 TRAVEL_DB 配置与已确认数据库不匹配；已停止，没有执行远程命令。");
  }
  const template = JSON.parse(await readFile(path.join(root, "trip-data.json"), "utf8"));
  const sql = createSeedSql(template);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "travel-plan-d1-init-"));
  const sqlFile = path.join(tempDir, "initialize-public-trip.sql");
  try {
    await writeFile(sqlFile, sql, { encoding: "utf8", mode: 0o600 });
    console.log(`将以幂等方式初始化模板 tripId=${template.metadata.tripId} 到 D1 ${databaseName}。若目标 trip/state 已存在，INSERT OR IGNORE 不会覆盖。`);
    const result = spawnSync("npx", ["wrangler", "d1", "execute", databaseName, "--remote", `--file=${sqlFile}`], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message || "初始化失败。"); process.exitCode = 1; });
}
