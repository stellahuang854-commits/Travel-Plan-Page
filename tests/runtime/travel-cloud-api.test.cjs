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
    async getPublicTripId() { return [...states.entries()].find(([, value]) => value.state.package)?.[0] || null; },
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

test("public single-trip API needs no Access identity and rejects guessed other trip IDs", async () => {
  const { createTravelApi } = await apiModule;
  const handler = createTravelApi({ repository: memoryRepository(), bucket: makeBucket() });
  assert.equal((await handler(request("/api/trip/trip-a?collections=todos"))).status, 200);
  assert.equal((await handler(request("/api/trip/trip-b?collections=todos"))).status, 404);
  assert.equal((await handler(request("/api/session"))).status, 404);
  assert.equal((await handler(request("/api/trip/trip-a/invitations"))).status, 404);
});

test("public API permits single-trip edits without fictitious role enforcement", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  const bucket = makeBucket();
  const handler = createTravelApi({ repository, bucket });
  const read = await handler(request("/api/trip/trip-a?collections=bills,travelers,todos"));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).bills[0].id, "bill-a");
  const edit = await handler(request("/api/trip/trip-a?collections=todos", "POST", "viewer", { expectedRevision: 4, changes: [{ op: "upsert", collection: "todos", id: "todo-1", value: { id: "todo-1" } }] }, { "if-match": '"4"' }));
  assert.equal(edit.status, 200);
  assert.equal(repository.states.get("trip-a").state.runtime.todos[0].id, "todo-1");
});

test("global trip revision prevents stale multi-device writes", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  const handler = createTravelApi({ repository, bucket: makeBucket() });
  const body = { expectedRevision: 4, changes: [{ op: "upsert", collection: "todos", id: "todo-1", value: { id: "todo-1", text: "Save me" } }] };
  const first = await handler(request("/api/trip/trip-a?collections=todos", "POST", "editor", body, { "if-match": '"4"' }));
  const stale = await handler(request("/api/trip/trip-a?collections=todos", "POST", "editor", body, { "if-match": '"4"' }));
  assert.equal(first.status, 200);
  assert.equal(stale.status, 409);
  assert.deepEqual(repository.states.get("trip-a").state.runtime.todos, [{ id: "todo-1", text: "Save me" }]);
});

test("R2 objects remain private and are only streamed through the single-trip function", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  const bucket = makeBucket();
  const handler = createTravelApi({ repository, bucket });
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

test("local data migration endpoint is disabled for the public single-trip site", async () => {
  const { createTravelApi } = await apiModule;
  const repository = memoryRepository();
  repository.states.set("empty-trip", { revision: 0, state: { package: null, content: null, runtime: { version: 1, settings: null, bills: [], travelers: [], todos: [], tickets: [] } } });
  const handler = createTravelApi({ repository, bucket: makeBucket() });
  const bundle = { schemaVersion: "travel-plan-cloud-backup/v1", tripId: "empty-trip", package: { schemaVersion: "2.0-lite", metadata: { tripId: "empty-trip", title: "A trip" }, config: { schemaVersion: "1.0.0", modules: { flights: false, overview: false, itinerary: false, todo: false, driving: false, ledger: false } } }, runtime: { bills: [{ id: "bill-1" }] }, content: { version: 1, tripId: "empty-trip", accommodations: [], transportRecords: [], restaurants: [], days: [], todoCategories: [], connections: [] } };
  assert.equal((await handler(request("/api/trip/trip-a/migrations", "POST", "owner", bundle))).status, 404);
});
