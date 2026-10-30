const COLLECTIONS = new Set(["settings", "todos", "tickets", "bills", "travelers"]);
const ATTACHMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ROLES = new Set(["owner", "editor", "viewer"]);
const INVITE_ROLES = new Set(["editor", "viewer"]);
const DEFAULT_STATE = Object.freeze({
  package: null,
  content: null,
  runtime: { version: 1, settings: null, bills: [], travelers: [], todos: [], tickets: [], updatedAt: "" }
});

export class ApiError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff", ...headers } });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

let jwksCache = { uri: "", expiresAt: 0, keys: [] };

async function accessJwks(teamDomain, fetchImpl = fetch) {
  const uri = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (jwksCache.uri === uri && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetchImpl(uri, { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new ApiError(503, "identity_provider_unavailable");
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new ApiError(503, "identity_provider_unavailable");
  jwksCache = { uri, expiresAt: Date.now() + 5 * 60 * 1000, keys: body.keys };
  return body.keys;
}

export async function verifyAccessJwt(token, env, fetchImpl = fetch, now = Date.now()) {
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https:\/\//, "").replace(/\/$/, "");
  const audience = String(env.ACCESS_AUD || "").trim();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain) || !audience) throw new ApiError(503, "access_auth_not_configured");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new ApiError(401, "unauthorized");
  let header;
  let claims;
  try { header = decodeJwtPart(parts[0]); claims = decodeJwtPart(parts[1]); }
  catch { throw new ApiError(401, "unauthorized"); }
  if (header.alg !== "RS256" || !header.kid || claims.iss !== `https://${teamDomain}`) throw new ApiError(401, "unauthorized");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const seconds = Math.floor(now / 1000);
  if (!audiences.includes(audience) || typeof claims.sub !== "string" || !claims.sub
      || !Number.isFinite(claims.exp) || claims.exp <= seconds
      || (Number.isFinite(claims.nbf) && claims.nbf > seconds + 30)
      || (Number.isFinite(claims.iat) && claims.iat > seconds + 30)) throw new ApiError(401, "unauthorized");
  const key = (await accessJwks(teamDomain, fetchImpl)).find((item) => item.kid === header.kid && item.kty === "RSA");
  if (!key) throw new ApiError(401, "unauthorized");
  let verified = false;
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { verified = false; }
  if (!verified) throw new ApiError(401, "unauthorized");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  return { id: claims.sub, email };
}

function accessToken(request) {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
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

function roleAllows(role, required) {
  if (required === "viewer") return ROLES.has(role);
  if (required === "editor") return role === "editor" || role === "owner";
  return role === "owner";
}

export function assertRole(role, required) {
  if (!roleAllows(role, required)) throw new ApiError(403, "forbidden");
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

async function requireMembership(repository, tripId, user, required = "viewer") {
  const membership = await repository.getMembership(tripId, user.id);
  if (!membership) throw new ApiError(404, "trip_not_found");
  assertRole(membership.role, required);
  return membership;
}

async function casState(repository, tripId, current, next, expected, user) {
  if (current.revision !== expected) throw new ApiError(409, "revision_conflict", "旅行资料已在其他设备更新，请重新载入后合并修改。");
  const saved = await repository.compareAndSwapState(tripId, expected, next, user.id);
  if (!saved) throw new ApiError(409, "revision_conflict", "旅行资料已在其他设备更新，请重新载入后合并修改。");
  return saved;
}

export function createTravelApi({ authenticate, repository, bucket, now = Date.now }) {
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method.toUpperCase();
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") requireSameOrigin(request);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET,POST,PUT,PATCH,DELETE,OPTIONS" } });
      const user = await authenticate(request);
      if (path === "/api/session" && method === "GET") {
        const tripId = url.searchParams.get("tripId");
        if (!tripId) return json({ id: user.id, email: user.email || "" });
        const member = await requireMembership(repository, cleanTripId(tripId), user, "viewer");
        return json({ id: user.id, email: user.email || "", role: member.role });
      }
      if (path === "/api/trips" && method === "GET") return json({ trips: await repository.listTrips(user.id) });
      if (path === "/api/trips" && method === "POST") {
        const input = await readJson(request);
        const id = cleanTripId(input.id || uuid());
        const title = String(input.title || "旅行计划").trim().slice(0, 160) || "旅行计划";
        await repository.createTrip({ id, title, ownerId: user.id, ownerEmail: user.email || "", createdAt: nowIso(now) });
        return json({ id, title, role: "owner", revision: 0 }, 201);
      }

      const inviteDecision = path === "/api/invitations/accept" || path === "/api/invitations/decline";
      if (inviteDecision && method === "POST") {
        const input = await readJson(request);
        const token = String(input.token || "");
        if (!/^[a-f0-9]{64}$/i.test(token)) throw new ApiError(400, "invalid_invitation");
        const invitation = await repository.getInvitationByHash(await sha256(token));
        if (!invitation || invitation.status !== "pending") throw new ApiError(404, "invitation_not_found");
        if (Date.parse(invitation.expiresAt) <= now()) { await repository.expireInvitation?.(invitation.id, nowIso(now)); throw new ApiError(410, "invitation_expired"); }
        if (invitation.email && invitation.email !== (user.email || "")) throw new ApiError(403, "invitation_email_mismatch");
        if (path.endsWith("/decline")) {
          await repository.declineInvitation(invitation.id, user.id, nowIso(now));
          return json({ status: "declined" });
        }
        const accepted = await repository.acceptInvitation(invitation.id, user, nowIso(now));
        if (!accepted) throw new ApiError(409, "invitation_already_used");
        return json({ status: "accepted", tripId: invitation.tripId, role: invitation.role });
      }

      const invitationInspect = path === "/api/invitations/inspect" && method === "POST";
      if (invitationInspect) {
        const input = await readJson(request);
        const token = String(input.token || "");
        if (!/^[a-f0-9]{64}$/i.test(token)) throw new ApiError(400, "invalid_invitation");
        const invitation = await repository.getInvitationByHash(await sha256(token));
        if (!invitation || invitation.status !== "pending") throw new ApiError(404, "invitation_not_found");
        if (Date.parse(invitation.expiresAt) <= now()) { await repository.expireInvitation?.(invitation.id, nowIso(now)); throw new ApiError(410, "invitation_expired"); }
        if (invitation.email && invitation.email !== (user.email || "")) throw new ApiError(403, "invitation_email_mismatch");
        const trip = await repository.getTrip(invitation.tripId);
        return json({ trip: { id: trip.id, title: trip.title }, role: invitation.role, expiresAt: invitation.expiresAt });
      }

      const tripRoute = path.match(/^\/api\/trip\/([^/]+)(?:\/(.*))?$/);
      if (!tripRoute) throw new ApiError(404, "not_found");
      const tripId = cleanTripId(decodeURIComponent(tripRoute[1]));
      const suffix = tripRoute[2] || "";
      const membership = await requireMembership(repository, tripId, user, "viewer");

      if (suffix === "" && method === "GET") {
        const requested = url.searchParams.get("collections")?.split(",").filter(Boolean) || [...COLLECTIONS];
        if (!requested.length || requested.some((name) => !COLLECTIONS.has(name))) throw new ApiError(400, "invalid_collections");
        const current = await repository.getState(tripId);
        return json(snapshotFor(normalizeState(current.state), current.revision, requested));
      }

      if (suffix === "" && method === "POST") {
        assertRole(membership.role, "editor");
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
        assertRole(membership.role, "editor");
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
        assertRole(membership.role, "editor");
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
        assertRole(membership.role, "owner");
        const current = await repository.getState(tripId);
        const trip = await repository.getTrip(tripId);
        return json({ schemaVersion: "travel-plan-cloud-backup/v1", tripId, title: trip.title, revision: current.revision, ...normalizeState(current.state), attachments: await repository.listAttachments(tripId) });
      }
      if (suffix === "revisions" && method === "GET") {
        assertRole(membership.role, "owner");
        return json({ revisions: await repository.listStateHistory(tripId) });
      }
      const restoreRoute = suffix.match(/^revisions\/(\d+)\/restore$/);
      if (restoreRoute && method === "POST") {
        assertRole(membership.role, "owner");
        const input = await readJson(request);
        const expected = expectedRevision(request, input);
        const sourceRevision = Number(restoreRoute[1]);
        const historical = await repository.getStateHistory(tripId, sourceRevision);
        if (!historical) throw new ApiError(404, "revision_not_found");
        const current = await repository.getState(tripId);
        const saved = await casState(repository, tripId, current, normalizeState(historical.state), expected, user);
        return json({ status: "restored", restoredFrom: sourceRevision, revision: saved.revision });
      }

      if (suffix === "migrations" && method === "POST") {
        assertRole(membership.role, "owner");
        const input = await readJson(request);
        if (input.schemaVersion !== "travel-plan-cloud-backup/v1" || input.tripId !== tripId) throw new ApiError(400, "invalid_backup_bundle");
        assertTripPackage(input.package, tripId);
        if (input.content) assertTripContent(input.content, tripId);
        assertRuntime(input.runtime);
        const current = await repository.getState(tripId);
        const currentState = normalizeState(current.state);
        if (current.revision !== 0 || currentState.package || currentState.content
            || Object.values(currentState.runtime).some((value) => Array.isArray(value) ? value.length : value && typeof value === "object")) {
          throw new ApiError(409, "migration_target_not_empty");
        }
        const migratedPackage = structuredClone(input.package);
        migratedPackage.config ||= {};
        migratedPackage.config.persistence = { mode: "d1", apiBase: "/api/trip", sharedCollections: ["todos", "tickets", "ledger"] };
        const next = normalizeState({ package: migratedPackage, content: input.content || null, runtime: input.runtime || {} });
        const saved = await casState(repository, tripId, current, next, 0, user);
        return json({ status: "imported", revision: saved.revision, localDataRetained: true, attachments: Array.isArray(input.attachmentManifest) ? input.attachmentManifest.length : 0 }, 201);
      }

      const memberRoute = suffix.match(/^members(?:\/([^/]+))?$/);
      if (memberRoute && method === "GET" && !memberRoute[1]) {
        assertRole(membership.role, "owner");
        return json({ members: await repository.listMembers(tripId) });
      }
      if (memberRoute?.[1] && method === "PATCH") {
        assertRole(membership.role, "owner");
        const input = await readJson(request);
        if (!INVITE_ROLES.has(input.role)) throw new ApiError(400, "invalid_member_role");
        if (!(await repository.setMemberRole(tripId, decodeURIComponent(memberRoute[1]), input.role, user.id, nowIso(now)))) throw new ApiError(404, "member_not_found");
        return json({ status: "updated" });
      }
      if (memberRoute?.[1] && method === "DELETE") {
        assertRole(membership.role, "owner");
        const target = decodeURIComponent(memberRoute[1]);
        if (target === user.id) throw new ApiError(400, "owner_cannot_remove_self");
        if (!(await repository.removeMember(tripId, target, user.id, nowIso(now)))) throw new ApiError(404, "member_not_found");
        return json({ status: "removed" });
      }

      const invitesRoute = suffix.match(/^invitations(?:\/([^/]+))?$/);
      if (invitesRoute && method === "GET" && !invitesRoute[1]) {
        assertRole(membership.role, "owner");
        return json({ invitations: await repository.listInvitations(tripId) });
      }
      if (suffix === "invitations" && method === "POST") {
        assertRole(membership.role, "owner");
        const input = await readJson(request);
        const role = String(input.role || "viewer");
        if (!INVITE_ROLES.has(role)) throw new ApiError(400, "invalid_invitation_role");
        const email = input.email == null || input.email === "" ? null : String(input.email).trim().toLowerCase();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "invalid_email");
        const days = Math.min(30, Math.max(1, Number.isInteger(input.expiresInDays) ? input.expiresInDays : 7));
        const token = randomInviteToken();
        const expiresAt = new Date(now() + days * 86400000).toISOString();
        const created = await repository.createInvitation({ id: uuid(), tripId, tokenHash: await sha256(token), email, role, inviterId: user.id, createdAt: nowIso(now), expiresAt });
        return json({ ...created, invitationUrl: `${url.origin}/invite.html#${token}` }, 201);
      }
      if (invitesRoute?.[1] && method === "DELETE") {
        assertRole(membership.role, "owner");
        if (!(await repository.revokeInvitation(tripId, decodeURIComponent(invitesRoute[1]), user.id, nowIso(now)))) throw new ApiError(404, "invitation_not_found");
        return json({ status: "revoked" });
      }

      const attachmentRoute = suffix.match(/^attachments(?:\/([^/]+)(?:\/(restore))?)?$/);
      if (attachmentRoute) {
        const id = attachmentRoute[1] ? decodeURIComponent(attachmentRoute[1]) : "";
        if (method === "POST" && !id) {
          assertRole(membership.role, "editor");
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
          assertRole(membership.role, "editor");
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
          assertRole(membership.role, "editor");
          if (!(await repository.softDeleteAttachment(tripId, id, user.id, nowIso(now)))) throw new ApiError(404, "attachment_not_found");
          return json({ status: "deleted", recoverable: true });
        }
        if (method === "POST" && id && attachmentRoute[2] === "restore") {
          assertRole(membership.role, "owner");
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
    async createTrip({ id, title, ownerId, ownerEmail, createdAt }) {
      await db.batch([
        db.prepare("INSERT INTO trips (id,title,owner_id,created_at) VALUES (?,?,?,?)").bind(id, title, ownerId, createdAt),
        db.prepare("INSERT INTO trip_members (trip_id,user_id,email,role,added_at) VALUES (?,?,?,'owner',?)").bind(id, ownerId, ownerEmail, createdAt),
        db.prepare("INSERT INTO trip_state (trip_id,state_json,revision,updated_at,updated_by) VALUES (?,? ,0,?,?)").bind(id, JSON.stringify(DEFAULT_STATE), createdAt, ownerId),
        db.prepare("INSERT INTO trip_state_history (trip_id,revision,state_json,updated_at,updated_by) VALUES (?,0,?,?,?)").bind(id, JSON.stringify(DEFAULT_STATE), createdAt, ownerId)
      ]);
    },
    listTrips(userId) {
      return db.prepare("SELECT t.id,t.title,m.role,m.added_at AS addedAt,s.revision FROM trips t JOIN trip_members m ON m.trip_id=t.id AND m.user_id=? AND m.removed_at IS NULL JOIN trip_state s ON s.trip_id=t.id ORDER BY t.created_at DESC").bind(userId).all().then((result) => result.results || []);
    },
    getTrip(id) { return first("SELECT id,title,owner_id AS ownerId FROM trips WHERE id=?", id); },
    async getMembership(tripId, userId) { return first("SELECT role,email FROM trip_members WHERE trip_id=? AND user_id=? AND removed_at IS NULL", tripId, userId); },
    async listMembers(tripId) { return (await db.prepare("SELECT user_id AS id,email,role,added_at AS addedAt FROM trip_members WHERE trip_id=? AND removed_at IS NULL ORDER BY added_at").bind(tripId).all()).results || []; },
    async setMemberRole(tripId, targetId, role, actorId, updatedAt) {
      const result = await run("UPDATE trip_members SET role=?,updated_at=? WHERE trip_id=? AND user_id=? AND removed_at IS NULL AND role<>'owner' AND user_id<>?", role, updatedAt, tripId, targetId, actorId);
      return resultChanged(result);
    },
    async removeMember(tripId, targetId, actorId, removedAt) {
      const result = await run("UPDATE trip_members SET removed_at=?,updated_at=?,removed_by=? WHERE trip_id=? AND user_id=? AND removed_at IS NULL AND role<>'owner' AND user_id<>?", removedAt, removedAt, actorId, tripId, targetId, actorId);
      return resultChanged(result);
    },
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
    async createInvitation(item) {
      await run("INSERT INTO trip_invitations (id,trip_id,token_hash,email,role,status,inviter_id,created_at,expires_at) VALUES (?,?,?,?,?,'pending',?,?,?)", item.id, item.tripId, item.tokenHash, item.email, item.role, item.inviterId, item.createdAt, item.expiresAt);
      return { id: item.id, email: item.email, role: item.role, status: "pending", expiresAt: item.expiresAt };
    },
    async getInvitationByHash(hash) {
      return first("SELECT id,trip_id AS tripId,email,role,status,expires_at AS expiresAt FROM trip_invitations WHERE token_hash=?", hash);
    },
    async listInvitations(tripId) {
      return (await db.prepare("SELECT id,email,role,status,created_at AS createdAt,expires_at AS expiresAt FROM trip_invitations WHERE trip_id=? ORDER BY created_at DESC").bind(tripId).all()).results || [];
    },
    async revokeInvitation(tripId, id, actorId, at) {
      const result = await run("UPDATE trip_invitations SET status='revoked',revoked_at=?,revoked_by=? WHERE trip_id=? AND id=? AND status='pending'", at, actorId, tripId, id);
      return resultChanged(result);
    },
    async expireInvitation(id, at) {
      await run("UPDATE trip_invitations SET status='expired' WHERE id=? AND status='pending' AND expires_at<=?", id, at);
    },
    async declineInvitation(id, userId, at) {
      await run("UPDATE trip_invitations SET status='declined',accepted_by=?,accepted_at=? WHERE id=? AND status='pending'", userId, at, id);
    },
    async acceptInvitation(id, user, at) {
      const row = await first("SELECT trip_id AS tripId,role,email,status,expires_at AS expiresAt FROM trip_invitations WHERE id=?", id);
      if (!row || row.status !== "pending" || Date.parse(row.expiresAt) <= Date.parse(at) || (row.email && row.email !== user.email)) return false;
      const results = await db.batch([
        db.prepare("UPDATE trip_invitations SET status='accepted',accepted_by=?,accepted_at=? WHERE id=? AND status='pending' AND expires_at>?").bind(user.id, at, id, at),
        db.prepare("INSERT INTO trip_members (trip_id,user_id,email,role,added_at) SELECT trip_id,?,?,role,? FROM trip_invitations WHERE id=? AND status='accepted' AND accepted_by=? ON CONFLICT(trip_id,user_id) DO UPDATE SET email=excluded.email,role=excluded.role,added_at=excluded.added_at,removed_at=NULL,updated_at=NULL").bind(user.id, user.email || "", at, id, user.id)
      ]);
      return resultChanged(results[0]);
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
    authenticate: async (req) => {
      const token = accessToken(req);
      if (!token) throw new ApiError(401, "unauthorized");
      return verifyAccessJwt(token, env);
    },
    repository: createD1Repository(env.TRAVEL_DB),
    bucket: env.TRAVEL_ATTACHMENTS
  });
  return api(request);
}
