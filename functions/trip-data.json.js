import { handleApi } from "../worker/travel-api.mjs";

export async function onRequest(context) {
  const tripId = String(context.env.DEFAULT_TRIP_ID || "").trim();
  if (!tripId) return Response.json({ error: "private_trip_not_configured" }, { status: 503 });
  const target = new URL(`/api/trip/${encodeURIComponent(tripId)}/package`, context.request.url);
  const response = await handleApi(new Request(target, context.request), context.env);
  if (!response.ok) return response;
  const payload = await response.json();
  return Response.json(payload.package, { headers: { "cache-control": "private, no-store", etag: `"${payload.revision}"`, "x-content-type-options": "nosniff" } });
}
