import { handleApi } from "../../worker/travel-api.mjs";

export async function onRequest(context) {
  return handleApi(context.request, context.env);
}
