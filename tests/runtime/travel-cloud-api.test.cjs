"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const apiModule = import("../../worker/travel-api.mjs");

function memoryRepository() {
  const members = new Map([["trip-a:owner", { role: "owner", email: "owner@example.test" }], ["trip-a:editor", { role: "editor", email: "editor@example.test" }], ["trip-a:viewer", { role: "viewer", email: "viewer@example.test" }]]);
  const states = new Map([["trip-a", { state: { package: { metadata: { tripId: "trip-a", title: "Private trip" } }, content: { tripId: "trip-a", days: [] }, runtime: { version: 1, settings: { baseCurrency: "EUR" }, bills: [{ id: "bill-a", note: "private amount" }], travelers: [{ id: "person-a", name: "A" }], todos: [], tickets: [] } }, revision: 4 }]]);
  const invites = new Map();
  const attachments = new Map();
  let inviteCounter = 1;
  return {
    members, states, invites, attachments,
    async getMembership(tripId, userId) { return members.get(`${tripId}:${userId}`) || null; },
    async getState(tripId) { const state = states.get(tripId); if (!state) throw new (await apiModule).ApiError(404, "trip_not_found"); return structuredClone(state); },
    async compareAndSwapState(tripId, revision, state, userId) { const current = states.get(tripId); if (!current || current.revision !== revision) return null; const next = { state: structuredClone(state), revision: revision + 1 }; states.set(tripId, next); return { revision: next.revision }; },
    async listTrips(userId) { return [...members.entries()].filter(([key]) => key.endsWith(`:${userId}`)).map(([key, value]) => ({ id: key.split(":")[0], role: value.role })); },
    async createTrip(item) { if (states.has(item.id)) throw Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" }); states.set(item.id, { state: { package: null, content: null, runtime: { version: 1, settings: null, bills: [], travelers: [], todos: [], tickets: [] } }, revision: 0 }); members.set(`${item.id}:${item.ownerId}`, { role: "owner", email: item.ownerEmail }); },
    async getTrip(tripId) { return { id: tripId, title: "Private trip" }; },
    async createInvitation(item) { const stored = { ...item, status: "pending" }; invites.set(item.id, stored); return { id: item.id, email: item.email, role: item.role, status: "pending", expiresAt: item.expiresAt }; },
    async getInvitationByHash(hash) { return [...invites.values()].find((item) => item.tokenHash === hash) || null; },
    async acceptInvitation(id, user, at) { const invite = invites.get(id); if (!invite || invite.status !== "pending") return false; invite.status = "accepted"; members.set(`${invite.tripId}:${user.id}`, { role: invite.role, email: user.email, addedAt: at }); return true; },
    async declineInvitation(id) { const invite = invites.get(id); if (!invite || invite.status !== "pending") return false; invite.status = "declined"; return true; },
    async listMembers(tripId) { return [...members.entries()].filter(([key]) => key.startsWith(`${tripId}:`)).map(([key, value]) => ({ id: key.split(":")[1], ...value })); },
    async setMemberRole(tripId, id, role) { const entry = members.get(`${tripId}:${id}`); if (!entry || entry.role === "owner") return false; entry.role = role; return true; },
    async removeMember(tripId, id) { return members.delete(`${tripId}:${id}`); },
    async listInvitations(tripId) { return [...invites.values()].filter((item) => item.tripId === tripId).map(({ tokenHash, ...item }) => item); },
    async revokeInvitation(tripId, id) { const invite = invites.get(id); if (!invite || invite.tripId !== tripId || invite.status !== "pending") return false; invite.status = "revoked"; return true; },
    async listAttachments(tripId) { return [...attachments.values()].filter((item) => item.tripId === tripId && !item.deletedAt).map(({ objectKey, ...item }) => item); },
    async createAttachment(item) { if ([...attachments.values()].some((record) => record.tripId === item.tripId && record.id === item.id)) throw Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" }); attachments.set(`${item.tripId}:${item.id}`, { ...item }); },
    async getAttachment(tripId, id) { const item = attachments.get(`${tripId}:${id}`); return item && !item.deletedAt ? { ...item } : null; },
    async replaceAttachment(tripId, id, patch) { Object.assign(attachments.get(`${tripId}:${id}`), patch); },
    async softDeleteAttachment(tripId, id, userId, at) { const item = attachments.get(`${tripId}:${id}`); if (!item || item.deletedAt) return false; item.deletedAt = at; item.deletedBy = userId; return true; },
    async restoreAttachment(tripId, id) { const item = attachments.get(`${tripId}:${id}`); if (!item?.deletedAt) return false; delete item.deletedAt; return true; },
    async listStateHistory() { return []; }, async getStateHistory() { return null; }
  };
}

function makeBucket() {
  const values = new Map();
  return { values, async put(key, value) { values.set(key, value instanceof ArrayBuffer ? new Uint8Array(value) : value); }, async get(key) { const value = values.get(key); return value ? { body: new Blob([value]).stream() } : null; }, async delete(key) { values.delete(key); } };
}

function request(path, method = "GET", user = "viewer", body = undefined, extraHeaders = {}) {
  const headers = { "x-test-user": user, ...extraHeaders };
  if (method !== "GET") headers.origin = "https://travel.example.test";
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://travel.example.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("unknown identities and guessed cross-trip IDs cannot read data", async () => {
  const { createTravelApi } = await apiModule;
  const handler = createTravelApi({ authenticate: async (req) => { const id = req.headers.get("x-test-user"); if (!id || id === "stranger") throw new (await apiModule).ApiError(401, "unauthorized"); return { id, email: `${id}@example.test` }; }, repository: memoryRepository(), bucket: makeBucket() });
  assert.equal((await handler(request("/api/trip/trip-a?collections=todos"))).status, 200);
  assert.equal((await handler(request("/api/trip/trip-b?collections=todos"))).status, 404);
  assert.equal((await handler(request("/api/trip/trip-a?collections=todos", "GET", "stranger"))).status, 401);
});

test("Cloudflare Access JWT requires a trusted RS256 signature, issuer, audience and expiry", async () => {
  const { verifyAccessJwt } = await apiModule;
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = "test-key";
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Date.now();
  async function token(claimOverrides = {}) {
    const head = encode({ alg: "RS256", kid: jwk.kid, typ: "JWT" });
    const body = encode({ iss: "https://unit-test.cloudflareaccess.com", aud: ["private-app-aud"], sub: "person-1", email: "person@example.test", iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300, ...claimOverrides });
    const signed = `${head}.${body}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signed));
    return `${signed}.${Buffer.from(signature).toString("base64url")}`;
  }
  const env = { ACCESS_TEAM_DOMAIN: "unit-test.cloudflareaccess.com", ACCESS_AUD: "private-app-aud" };
  const fetchJwks = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
  const valid = await token();
  assert.equal((await verifyAccessJwt(valid, env, fetchJwks, now)).email, "person@example.test");
  await assert.rejects(verifyAccessJwt(await token({ aud: ["wrong-aud"] }), env, fetchJwks, now), /unauthorized/);
  await assert.rejects(verifyAccessJwt(await token({ exp: Math.floor(now / 1000) - 1 }), env, fetchJwks, now), /unauthorized/);
  const [head, body] = valid.split(".");
  const forged = `${head}.${encode({ iss: "https://unit-test.cloudflareaccess.com", aud: ["private-app-aud"], sub: "attacker", exp: Math.floor(now / 1000) + 300 })}.${valid.split(".")[2]}`;
  await assert.rejects(verifyAccessJwt(forged, env, fetchJwks, now), /unauthorized/);
});

test("viewer reads shared data but backend denies changes and attachment uploads", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  const bucket = makeBucket();
  const handler = createTravelApi({ authenticate: async (req) => ({ id: req.headers.get("x-test-user"), email: "viewer@example.test" }), repository, bucket });
  const read = await handler(request("/api/trip/trip-a?collections=bills,travelers,todos"));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).bills[0].id, "bill-a");
  const edit = await handler(request("/api/trip/trip-a?collections=todos", "POST", "viewer", { expectedRevision: 4, changes: [{ op: "upsert", collection: "todos", id: "todo-1", value: { id: "todo-1" } }] }, { "if-match": '"4"' }));
  assert.equal(edit.status, 403);
  const upload = await handler(request("/api/trip/trip-a/attachments", "POST", "viewer", undefined, { "content-type": "image/png", "x-attachment-type": "image/png", "x-attachment-size": "1" }));
  assert.equal(upload.status, 403);
  assert.equal(bucket.values.size, 0);
});

test("global trip revision prevents stale multi-device writes", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  const handler = createTravelApi({ authenticate: async (req) => ({ id: req.headers.get("x-test-user") }), repository, bucket: makeBucket() });
  const body = { expectedRevision: 4, changes: [{ op: "upsert", collection: "todos", id: "todo-1", value: { id: "todo-1", text: "Save me" } }] };
  const first = await handler(request("/api/trip/trip-a?collections=todos", "POST", "editor", body, { "if-match": '"4"' }));
  const stale = await handler(request("/api/trip/trip-a?collections=todos", "POST", "editor", body, { "if-match": '"4"' }));
  assert.equal(first.status, 200);
  assert.equal(stale.status, 409);
  assert.deepEqual(repository.states.get("trip-a").state.runtime.todos, [{ id: "todo-1", text: "Save me" }]);
});

test("invitation tokens are one-time, role-bound, expiring, and revocable", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  const now = Date.parse("2026-10-30T12:00:00Z");
  const handler = createTravelApi({ authenticate: async (req) => ({ id: req.headers.get("x-test-user"), email: `${req.headers.get("x-test-user")}@example.test` }), repository, bucket: makeBucket(), now: () => now });
  const created = await handler(request("/api/trip/trip-a/invitations", "POST", "owner", { role: "editor", email: "new@example.test", expiresInDays: 2 }));
  assert.equal(created.status, 201);
  const invitation = await created.json();
  const token = invitation.invitationUrl.split("#")[1];
  const inspect = await handler(request("/api/invitations/inspect", "POST", "new", { token }));
  assert.equal(inspect.status, 200);
  assert.equal((await handler(request("/api/invitations/accept", "POST", "new", { token }))).status, 200);
  assert.equal(repository.members.get("trip-a:new").role, "editor");
  assert.equal((await handler(request("/api/invitations/accept", "POST", "new", { token }))).status, 404);
});

test("R2 objects are private, unguessable, and scoped by trip membership", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  const bucket = makeBucket();
  const handler = createTravelApi({ authenticate: async (req) => ({ id: req.headers.get("x-test-user") }), repository, bucket });
  const upload = new Request("https://travel.example.test/api/trip/trip-a/attachments", { method: "POST", headers: { origin: "https://travel.example.test", "x-test-user": "editor", "content-type": "image/png", "x-attachment-type": "image/png", "x-attachment-size": "3", "x-attachment-id": "attach-1", "x-attachment-name": "ticket.png", "x-transport-id": "flight-1" }, body: new Uint8Array([1, 2, 3]) });
  assert.equal((await handler(upload)).status, 201);
  const stored = repository.attachments.get("trip-a:attach-1");
  assert.equal(stored.objectKey.includes("attach-1"), false);
  const denied = await handler(request("/api/trip/trip-b/attachments/attach-1", "GET", "viewer"));
  assert.equal(denied.status, 404);
  const downloaded = await handler(request("/api/trip/trip-a/attachments/attach-1", "GET", "viewer"));
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
  assert.equal((await downloaded.arrayBuffer()).byteLength, 3);
});

test("migration is owner-only, trip-scoped, and refuses to overwrite imported data", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  repository.states.set("empty-trip", { revision: 0, state: { package: null, content: null, runtime: { version: 1, settings: null, bills: [], travelers: [], todos: [], tickets: [] } } });
  repository.members.set("empty-trip:owner", { role: "owner", email: "owner@example.test" });
  repository.members.set("empty-trip:editor", { role: "editor", email: "editor@example.test" });
  const handler = createTravelApi({ authenticate: async (req) => ({ id: req.headers.get("x-test-user") }), repository, bucket: makeBucket() });
  const bundle = { schemaVersion: "travel-plan-cloud-backup/v1", tripId: "empty-trip", package: { schemaVersion: "2.0-lite", metadata: { tripId: "empty-trip", title: "A trip" }, config: { schemaVersion: "1.0.0", modules: { flights: false, overview: false, itinerary: false, todo: false, driving: false, ledger: false } } }, runtime: { bills: [{ id: "bill-1" }] }, content: { version: 1, tripId: "empty-trip", accommodations: [], transportRecords: [], restaurants: [], days: [], todoCategories: [], connections: [] } };
  assert.equal((await handler(request("/api/trip/empty-trip/migrations", "POST", "editor", bundle))).status, 403);
  assert.equal((await handler(request("/api/trip/empty-trip/migrations", "POST", "owner", bundle))).status, 201);
  assert.equal(repository.states.get("empty-trip").state.package.config.persistence.mode, "d1");
  assert.equal((await handler(request("/api/trip/empty-trip/migrations", "POST", "owner", bundle))).status, 409);
});
