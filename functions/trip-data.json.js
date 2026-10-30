import tripTemplateSource from "../trip-data.json";
import { createD1Repository } from "../worker/travel-api.mjs";

const tripTemplate = JSON.parse(tripTemplateSource);

export async function onRequest(context) {
  if (context.request.method !== "GET" && context.request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  let published = null;
  if (context.env.TRAVEL_DB) published = await createD1Repository(context.env.TRAVEL_DB).getPublicTrip();
  const data = published?.package || tripTemplate;
  return Response.json(data, { headers: { "cache-control": "no-store", ...(published ? { etag: `"${published.revision}"` } : {}), "x-content-type-options": "nosniff" } });
}
