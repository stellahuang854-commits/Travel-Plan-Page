const COLLECTIONS = new Set(["settings", "todos", "tickets", "bills", "travelers"]);
const ATTACHMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const PUBLIC_ACTOR_ID = "public-single-trip-site";
const DEFAULT_STATE = Object.freeze({
  package: null,
  content: null,
  runtime: { version: 1, settings: null, bills: [], travelers: [], todos: [], tickets: [], updatedAt: "" }
});

export class ApiError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}

function cleanTripId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 128 || !/^[\p{L}\p{N}._:-]+$/u.test(id)) throw new ApiError(400, "invalid_trip_id");
  return id;
}

function normalizeState(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const runtime = raw.runtime && typeof raw.runtime === "object" ? raw.runtime : {};
  return {
    package: raw.package && typeof raw.package === "object" ? raw.package : null,
    content: raw.content && typeof raw.content === "object" ? raw.content : null,
    runtime: {
      version: 1,
      settings: runtime.settings && typeof runtime.settings === "object" ? runtime.settings : null,
      bills: Array.isArray(runtime.bills) ? runtime.bills : [],
      travelers: Array.isArray(runtime.travelers) ? runtime.travelers : [],
      todos: Array.isArray(runtime.todos) ? runtime.todos : [],
      tickets: Array.isArray(runtime.tickets) ? runtime.tickets : [],
      updatedAt: typeof runtime.updatedAt === "string" ? runtime.updatedAt : new Date().toISOString()
    }
  };
}

function snapshotFor(state, revision, collections = COLLECTIONS) {
  const selected = new Set(collections);
  const runtime = state.runtime;
  return {
    version: runtime.version || 1,
    settings: selected.has("settings") ? runtime.settings : null,
    bills: selected.has("bills") ? runtime.bills : [],
    travelers: selected.has("travelers") ? runtime.travelers : [],
    todos: selected.has("todos") ? runtime.todos : [],
    tickets: selected.has("tickets") ? runtime.tickets : [],
    updatedAt: runtime.updatedAt,
    revision
  };
}

function assertTripPackage(value, tripId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.metadata?.tripId !== tripId || value.schemaVersion !== "2.0-lite"
      || value.config?.schemaVersion !== "1.0.0" || !value.config?.modules || typeof value.config.modules !== "object") {
    throw new ApiError(400, "invalid_trip_package");
  }
  for (const name of ["flights", "flightJourneys", "accommodations", "days", "restaurants", "bookingsAndTickets"]) {
    if (value[name] !== undefined && !Array.isArray(value[name])) throw new ApiError(400, "invalid_trip_package");
  }
  for (const enabled of Object.values(value.config.modules)) if (typeof enabled !== "boolean") throw new ApiError(400, "invalid_trip_package");
}

function assertTripContent(value, tripId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.tripId !== tripId || value.version !== 1) throw new ApiError(400, "invalid_trip_content");
  for (const collection of ["accommodations", "transportRecords", "restaurants", "days", "todoCategories", "connections"]) {
    if (!Array.isArray(value[collection])) throw new ApiError(400, "invalid_trip_content");
    const ids = new Set();
    for (const record of value[collection]) {
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string" || !record.id.trim() || ids.has(record.id)) throw new ApiError(400, "invalid_trip_content");
      ids.add(record.id);
    }
  }
}

function assertRuntime(value) {
  if (value == null) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_runtime_snapshot");
  for (const collection of ["bills", "travelers", "todos", "tickets"]) if (value[collection] !== undefined && !Array.isArray(value[collection])) throw new ApiError(400, "invalid_runtime_snapshot");
  if (value.settings !== undefined && value.settings !== null && (typeof value.settings !== "object" || Array.isArray(value.settings))) throw new ApiError(400, "invalid_runtime_snapshot");
}

function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new ApiError(403, "origin_not_allowed");
}

async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) throw new ApiError(415, "json_required");
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new ApiError(413, "request_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ApiError(413, "request_too_large");
  try { return JSON.parse(text); }
  catch { throw new ApiError(400, "invalid_json"); }
}

function expectedRevision(request, body = {}) {
  const header = request.headers.get("if-match")?.replace(/^W\//, "").replaceAll('"', "");
  const raw = header ?? body.expectedRevision;
  if (raw === undefined || raw === null || raw === "") throw new ApiError(428, "revision_required");
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new ApiError(400, "invalid_revision");
  return revision;
}

function applyRuntimeChanges(state, changes, allowed) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 100) throw new ApiError(400, "invalid_changes");
  const next = structuredClone(state);
  const collections = new Set(allowed);
  for (const change of changes) {
    const collection = String(change?.collection || "");
    if (!COLLECTIONS.has(collection) || !collections.has(collection)) throw new ApiError(403, "collection_not_allowed");
    if (!change || !["upsert", "delete"].includes(change.op)) throw new ApiError(400, "invalid_change");
    if (collection === "settings") {
      if (change.op === "delete") next.runtime.settings = null;
      else if (change.value && typeof change.value === "object" && !Array.isArray(change.value)) next.runtime.settings = structuredClone(change.value);
      else throw new ApiError(400, "invalid_record");
      continue;
    }
    const id = String(change.id || change.value?.id || "").trim();
    if (!id || id.length > 160) throw new ApiError(400, "invalid_record_id");
    const rows = next.runtime[collection];
    const index = rows.findIndex((record) => String(record?.id || "") === id);
    if (change.op === "delete") {
      if (index >= 0) rows.splice(index, 1);
    } else {
      if (!change.value || typeof change.value !== "object" || Array.isArray(change.value) || String(change.value.id || "") !== id) throw new ApiError(400, "invalid_record");
      if (index >= 0) rows[index] = structuredClone(change.value);
      else rows.push(structuredClone(change.value));
    }
  }
  next.runtime.updatedAt = new Date().toISOString();
  return next;
}

function uuid() { return crypto.randomUUID(); }

async function sha256(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomInviteToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requiredBucket(env) {
  if (!env.TRAVEL_ATTACHMENTS) throw new ApiError(503, "attachment_storage_not_configured");
  return env.TRAVEL_ATTACHMENTS;
}

function attachmentName(value) {
  const name = String(value || "attachment").replace(/[\r\n\\/\u0000-\u001f]/g, "_").trim().slice(0, 180);
  return name || "attachment";
}

function encodedDisposition(name) {
  return `inline; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function nowIso(now) { return new Date(now()).toISOString(); }

async function casState(repository, tripId, current, next, expected, user) {
  if (current.revision !== expected) throw new ApiError(409, "revision_conflict", "旅行资料已在其他设备更新，请重新载入后合并修改。");
  const saved = await repository.compareAndSwapState(tripId, expected, next, user.id);
  if (!saved) throw new ApiError(409, "revision_conflict", "旅行资料已在其他设备更新，请重新载入后合并修改。");
  return saved;
}

export function createTravelApi({ repository, bucket, now = Date.now }) {
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method.toUpperCase();
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") requireSameOrigin(request);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET,POST,PUT,PATCH,DELETE,OPTIONS" } });
      const tripRoute = path.match(/^\/api\/trip\/([^/]+)(?:\/(.*))?$/);
      if (!tripRoute) throw new ApiError(404, "not_found");
      const tripId = cleanTripId(decodeURIComponent(tripRoute[1]));
      const suffix = tripRoute[2] || "";
      const publicTripId = await repository.getPublicTripId();
      if (!publicTripId || tripId !== publicTripId) throw new ApiError(404, "trip_not_found");
      const user = { id: PUBLIC_ACTOR_ID };

      if (suffix === "" && method === "GET") {
        const requested = url.searchParams.get("collections")?.split(",").filter(Boolean) || [...COLLECTIONS];
        if (!requested.length || requested.some((name) => !COLLECTIONS.has(name))) throw new ApiError(400, "invalid_collections");
        const current = await repository.getState(tripId);
        return json(snapshotFor(normalizeState(current.state), current.revision, requested));
      }

      if (suffix === "" && method === "POST") {
        const input = await readJson(request);
        const expected = expectedRevision(request, input);
        const requested = url.searchParams.get("collections")?.split(",").filter(Boolean) || [...COLLECTIONS];
        if (!requested.length || requested.some((name) => !COLLECTIONS.has(name))) throw new ApiError(400, "invalid_collections");
        const current = await repository.getState(tripId);
        const next = applyRuntimeChanges(normalizeState(current.state), input.changes, requested);
        const saved = await casState(repository, tripId, current, next, expected, user);
        return json(snapshotFor(next, saved.revision, requested));
      }

      if (suffix === "package" && method === "GET") {
        const current = await repository.getState(tripId);
        if (!current.state.package) throw new ApiError(404, "trip_package_not_imported");
        return json({ package: current.state.package, revision: current.revision });
      }
      if (suffix === "package" && method === "PUT") {
        const input = await readJson(request);
        const expected = expectedRevision(request, input);
        const value = input.package;
        assertTripPackage(value, tripId);
        const current = await repository.getState(tripId);
        const next = normalizeState(current.state);
        next.package = value;
        const saved = await casState(repository, tripId, current, next, expected, user);
        return json({ revision: saved.revision });
      }
      if (suffix === "content" && method === "GET") {
        const current = await repository.getState(tripId);
        return json({ content: current.state.content, revision: current.revision });
      }
      if (suffix === "content" && method === "PUT") {
        const input = await readJson(request);
        const expected = expectedRevision(request, input);
        assertTripContent(input.content, tripId);
        const current = await repository.getState(tripId);
        const next = normalizeState(current.state);
        next.content = input.content;
        const saved = await casState(repository, tripId, current, next, expected, user);
        return json({ revision: saved.revision });
      }
      if (suffix === "backup" && method === "GET") {
        const current = await repository.getState(tripId);
        const trip = await repository.getTrip(tripId);
        return json({ schemaVersion: "travel-plan-cloud-backup/v1", tripId, title: trip.title, revision: current.revision, ...normalizeState(current.state), attachments: await repository.listAttachments(tripId) });
      }
      if (suffix === "revisions" && method === "GET") {
        return json({ revisions: await repository.listStateHistory(tripId) });
      }
      const restoreRoute = suffix.match(/^revisions\/(\d+)\/restore$/);
      if (restoreRoute && method === "POST") {
        const input = await readJson(request);
        const expected = expectedRevision(request, input);
        const sourceRevision = Number(restoreRoute[1]);
        const historical = await repository.getStateHistory(tripId, sourceRevision);
        if (!historical) throw new ApiError(404, "revision_not_found");
        const current = await repository.getState(tripId);
        const saved = await casState(repository, tripId, current, normalizeState(historical.state), expected, user);
        return json({ status: "restored", restoredFrom: sourceRevision, revision: saved.revision });
      }

      const attachmentRoute = suffix.match(/^attachments(?:\/([^/]+)(?:\/(restore))?)?$/);
      if (attachmentRoute) {
        const id = attachmentRoute[1] ? decodeURIComponent(attachmentRoute[1]) : "";
        if (method === "POST" && !id) {
          const type = String(request.headers.get("x-attachment-type") || request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
          if (!ATTACHMENT_TYPES.has(type)) throw new ApiError(415, "attachment_type_not_allowed");
          const advertisedSize = Number(request.headers.get("x-attachment-size") || request.headers.get("content-length") || 0);
          if (advertisedSize > MAX_ATTACHMENT_BYTES) throw new ApiError(413, "invalid_attachment_size");
          const bytes = await request.arrayBuffer();
          const length = bytes.byteLength;
          if (!length || length > MAX_ATTACHMENT_BYTES || (advertisedSize && advertisedSize !== length)) throw new ApiError(413, "invalid_attachment_size");
          const attachmentId = request.headers.get("x-attachment-id") || `attachment-${uuid()}`;
          if (!/^[\p{L}\p{N}._:-]{1,180}$/u.test(attachmentId)) throw new ApiError(400, "invalid_attachment_id");
          const name = attachmentName(decodeURIComponent(request.headers.get("x-attachment-name") || "attachment"));
          const transportId = String(request.headers.get("x-transport-id") || "").trim().slice(0, 180);
          const objectKey = `${tripId}/${uuid()}`;
          const storage = bucket || requiredBucket({ TRAVEL_ATTACHMENTS: null });
          await storage.put(objectKey, bytes, { httpMetadata: { contentType: type, contentDisposition: encodedDisposition(name), cacheControl: "private, no-store" } });
          try {
            await repository.createAttachment({ id: attachmentId, tripId, transportId, name, type, size: length, objectKey, uploadedBy: user.id, createdAt: nowIso(now) });
          } catch (error) {
            await storage.delete(objectKey).catch(() => {});
            throw error;
          }
          return json({ id: attachmentId, tripId, transportId, name, type, size: length }, 201);
        }
        if (method === "GET" && !id) {
          const attachments = await repository.listAttachments(tripId);
          return json({ attachments });
        }
        if (method === "GET" && id) {
          const record = await repository.getAttachment(tripId, id);
          if (!record) throw new ApiError(404, "attachment_not_found");
          const object = await (bucket || requiredBucket({ TRAVEL_ATTACHMENTS: null })).get(record.objectKey);
          if (!object) throw new ApiError(404, "attachment_not_found");
          return new Response(object.body, { headers: {
            "content-type": record.type,
            "content-disposition": encodedDisposition(record.name),
            "x-attachment-name": encodeURIComponent(record.name),
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox"
          } });
        }
        if (method === "PUT" && id) {
          const record = await repository.getAttachment(tripId, id);
          if (!record) throw new ApiError(404, "attachment_not_found");
          const advertisedSize = Number(request.headers.get("x-attachment-size") || request.headers.get("content-length") || 0);
          const type = String(request.headers.get("x-attachment-type") || request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
          if (!ATTACHMENT_TYPES.has(type) || advertisedSize > MAX_ATTACHMENT_BYTES) throw new ApiError(400, "invalid_attachment");
          const bytes = await request.arrayBuffer();
          const length = bytes.byteLength;
          if (!length || length > MAX_ATTACHMENT_BYTES || (advertisedSize && advertisedSize !== length)) throw new ApiError(400, "invalid_attachment");
          const name = attachmentName(decodeURIComponent(request.headers.get("x-attachment-name") || record.name));
          await (bucket || requiredBucket({ TRAVEL_ATTACHMENTS: null })).put(record.objectKey, bytes, { httpMetadata: { contentType: type, contentDisposition: encodedDisposition(name), cacheControl: "private, no-store" } });
          await repository.replaceAttachment(tripId, id, { name, type, size: length, updatedAt: nowIso(now) });
          return json({ id, name, type, size: length });
        }
        if (method === "DELETE" && id) {
          if (!(await repository.softDeleteAttachment(tripId, id, user.id, nowIso(now)))) throw new ApiError(404, "attachment_not_found");
          return json({ status: "deleted", recoverable: true });
        }
        if (method === "POST" && id && attachmentRoute[2] === "restore") {
          if (!(await repository.restoreAttachment(tripId, id, nowIso(now)))) throw new ApiError(404, "attachment_not_found");
          return json({ status: "restored" });
        }
      }
      throw new ApiError(404, "not_found");
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.code, message: error.message }, error.status);
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" || error?.message?.includes("UNIQUE constraint failed")) return json({ error: "already_exists" }, 409);
      return json({ error: "internal_error" }, 500);
    }
  };
}

export function createD1Repository(db) {
  if (!db) throw new Error("D1 database binding is missing.");
  const first = (sql, ...values) => db.prepare(sql).bind(...values).first();
  const run = (sql, ...values) => db.prepare(sql).bind(...values).run();
  const resultChanged = (result) => Number(result?.meta?.changes || 0) > 0;
  return {
    async getPublicTrip() {
      const result = await db.prepare("SELECT trip_id AS id,state_json,revision,json_extract(state_json,'$.package.metadata.tripId') AS packageTripId FROM trip_state WHERE json_valid(state_json) AND json_type(state_json,'$.package')='object'").all();
      const rows = (result.results || []).filter((row) => row.id === row.packageTripId);
      if (rows.length > 1) throw new ApiError(409, "multiple_public_trips", "数据库中存在多个旅行包，无法确定单旅行页面使用哪一个。");
      if (!rows.length) return null;
      let state;
      try { state = JSON.parse(rows[0].state_json); } catch { throw new ApiError(500, "trip_state_invalid"); }
      return { id: rows[0].id, package: state.package, revision: Number(rows[0].revision) };
    },
    async getPublicTripId() { return (await this.getPublicTrip())?.id || null; },
    getTrip(id) { return first("SELECT id,title,owner_id AS ownerId FROM trips WHERE id=?", id); },
    async getState(tripId) {
      const row = await first("SELECT state_json,revision FROM trip_state WHERE trip_id=?", tripId);
      if (!row) throw new ApiError(404, "trip_not_found");
      let state;
      try { state = JSON.parse(row.state_json); } catch { throw new ApiError(500, "trip_state_invalid"); }
      return { state, revision: Number(row.revision) };
    },
    async compareAndSwapState(tripId, revision, state, updatedBy) {
      const updatedAt = new Date().toISOString();
      const result = await db.batch([
        db.prepare("UPDATE trip_state SET state_json=?,revision=revision+1,updated_at=?,updated_by=? WHERE trip_id=? AND revision=?").bind(JSON.stringify(state), updatedAt, updatedBy, tripId, revision),
        db.prepare("INSERT INTO trip_state_history (trip_id,revision,state_json,updated_at,updated_by) SELECT trip_id,revision,state_json,updated_at,updated_by FROM trip_state WHERE trip_id=? AND revision=? AND updated_by=?").bind(tripId, revision + 1, updatedBy)
      ]);
      return resultChanged(result[0]) ? { revision: revision + 1, updatedAt } : null;
    },
    async listStateHistory(tripId) {
      return (await db.prepare("SELECT revision,updated_at AS updatedAt,updated_by AS updatedBy FROM trip_state_history WHERE trip_id=? ORDER BY revision DESC LIMIT 100").bind(tripId).all()).results || [];
    },
    async getStateHistory(tripId, revision) {
      const row = await first("SELECT state_json,revision,updated_at AS updatedAt FROM trip_state_history WHERE trip_id=? AND revision=?", tripId, revision);
      if (!row) return null;
      return { state: JSON.parse(row.state_json), revision: Number(row.revision), updatedAt: row.updatedAt };
    },
    async createAttachment(item) {
      await run("INSERT INTO trip_attachments (id,trip_id,transport_id,name,mime_type,size_bytes,object_key,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)", item.id, item.tripId, item.transportId, item.name, item.type, item.size, item.objectKey, item.uploadedBy, item.createdAt);
    },
    async listAttachments(tripId) {
      return (await db.prepare("SELECT id,trip_id AS tripId,transport_id AS transportId,name,mime_type AS type,size_bytes AS size,created_at AS createdAt FROM trip_attachments WHERE trip_id=? AND deleted_at IS NULL ORDER BY created_at").bind(tripId).all()).results || [];
    },
    async getAttachment(tripId, id, includeDeleted = false) {
      const suffix = includeDeleted ? "" : " AND deleted_at IS NULL";
      return first(`SELECT id,trip_id AS tripId,transport_id AS transportId,name,mime_type AS type,size_bytes AS size,object_key AS objectKey,created_at AS createdAt FROM trip_attachments WHERE trip_id=? AND id=?${suffix}`, tripId, id);
    },
    async replaceAttachment(tripId, id, value) {
      await run("UPDATE trip_attachments SET name=?,mime_type=?,size_bytes=?,updated_at=? WHERE trip_id=? AND id=? AND deleted_at IS NULL", value.name, value.type, value.size, value.updatedAt, tripId, id);
    },
    async softDeleteAttachment(tripId, id, userId, at) {
      const result = await run("UPDATE trip_attachments SET deleted_at=?,deleted_by=? WHERE trip_id=? AND id=? AND deleted_at IS NULL", at, userId, tripId, id);
      return resultChanged(result);
    },
    async restoreAttachment(tripId, id, at) {
      const result = await run("UPDATE trip_attachments SET deleted_at=NULL,deleted_by=NULL,updated_at=? WHERE trip_id=? AND id=? AND deleted_at IS NOT NULL", at, tripId, id);
      return resultChanged(result);
    }
  };
}

export async function handleApi(request, env) {
  const api = createTravelApi({
    repository: createD1Repository(env.TRAVEL_DB),
    bucket: env.TRAVEL_ATTACHMENTS
  });
  return api(request);
}
