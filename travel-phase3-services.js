(() => {
  "use strict";

  const PROVIDERS = Object.freeze({ google: "Google Maps", apple: "Apple Maps", openstreetmap: "OpenStreetMap", amap: "高德地图 Amap" });
  const MODE_LABELS = Object.freeze({ walking: "步行", bicycle: "自行车", taxi: "出租车 / 网约车", driving: "自驾", metro: "地铁", bus: "公交车", train: "火车", ferry: "轮渡", other: "其他" });

  function clean(value) { return String(value || "").trim(); }
  function allowedMapUrl(value, mapProvider) {
    const raw = clean(value);
    if (!raw) return false;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:") return false;
      const host = url.hostname.toLowerCase();
      if (mapProvider === "google") return ["maps.app.goo.gl", "goo.gl", "maps.google.com", "www.google.com"].includes(host) && (host !== "goo.gl" || url.pathname.startsWith("/maps")) && (host !== "www.google.com" || url.pathname.startsWith("/maps"));
      if (mapProvider === "apple") return host === "maps.apple.com";
      if (mapProvider === "openstreetmap") return host === "openstreetmap.org" || host === "www.openstreetmap.org";
      if (mapProvider === "amap") return host === "uri.amap.com" || host === "ditu.amap.com";
    } catch { return false; }
    return false;
  }
  function point(value) {
    if (!value || typeof value !== "object") return null;
    const rawLat = value.lat ?? value.latitude;
    const rawLng = value.lng ?? value.lon ?? value.longitude;
    if (rawLat === "" || rawLng === "" || rawLat == null || rawLng == null) return null;
    const lat = Number(rawLat); const lng = Number(rawLng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng, system: String(value.system || value.coordinateSystem || "").toLowerCase().replace(/[-_\s]/g, "") }
      : null;
  }

  function modeTravelMode(mode) {
    return ({ walking: "walking", bicycle: "bicycling", taxi: "driving", driving: "driving", metro: "transit", bus: "transit", train: "transit", ferry: "transit", other: "transit" })[mode] || "driving";
  }

  function directionsUrl({ mapProvider = "google", mode = "driving", fromLabel = "", toLabel = "", fromCoordinates, toCoordinates }) {
    const from = point(fromCoordinates); const to = point(toCoordinates);
    const fromWgs84 = from && (!from.system || from.system === "wgs84");
    const toWgs84 = to && (!to.system || to.system === "wgs84");
    const origin = fromWgs84 ? `${from.lat},${from.lng}` : clean(fromLabel);
    const destination = toWgs84 ? `${to.lat},${to.lng}` : clean(toLabel);
    if (!origin || !destination) return "";
    const provider = PROVIDERS[mapProvider] ? mapProvider : "google";
    const travelMode = modeTravelMode(mode);
    if (provider === "google") {
      const url = new URL("https://www.google.com/maps/dir/");
      url.searchParams.set("api", "1"); url.searchParams.set("origin", origin); url.searchParams.set("destination", destination); url.searchParams.set("travelmode", travelMode);
      return url.href;
    }
    if (provider === "apple") {
      const url = new URL("https://maps.apple.com/");
      url.searchParams.set("saddr", origin); url.searchParams.set("daddr", destination);
      url.searchParams.set("dirflg", travelMode === "walking" ? "w" : travelMode === "transit" ? "r" : mode === "bicycle" ? "c" : "d");
      return url.href;
    }
    if (provider === "openstreetmap") {
      if (!fromWgs84 || !toWgs84) return "";
      const engine = mode === "walking" ? "fossgis_osrm_foot" : mode === "bicycle" ? "fossgis_osrm_bike" : "fossgis_osrm_car";
      const url = new URL("https://www.openstreetmap.org/directions");
      url.searchParams.set("engine", engine); url.searchParams.set("route", `${from.lat},${from.lng};${to.lat},${to.lng}`);
      return url.href;
    }
    // Amap URI navigation accepts GCJ-02 coordinate pairs. Do not send WGS-84 as if it were GCJ-02.
    if (provider === "amap") {
      if (!from || !to || from.system !== "gcj02" || to.system !== "gcj02") return "";
      const url = new URL("https://uri.amap.com/navigation");
      url.searchParams.set("from", `${from.lng},${from.lat},${clean(fromLabel)}`);
      url.searchParams.set("to", `${to.lng},${to.lat},${clean(toLabel)}`);
      url.searchParams.set("mode", mode === "walking" ? "walk" : mode === "bicycle" ? "ride" : ["metro", "bus", "train", "ferry"].includes(mode) ? "bus" : "car");
      url.searchParams.set("src", "travel-plan");
      return url.href;
    }
    return "";
  }

  function placeUrl(mapProvider, { label = "", query = "", coordinates } = {}) {
    const provider = PROVIDERS[mapProvider] ? mapProvider : "google";
    const p = point(coordinates); const target = p ? `${p.lat},${p.lng}` : clean(query || label);
    if (!target) return "";
    if (provider === "google") {
      const url = new URL("https://www.google.com/maps/search/"); url.searchParams.set("api", "1"); url.searchParams.set("query", target); return url.href;
    }
    if (provider === "apple") { const url = new URL("https://maps.apple.com/"); url.searchParams.set("q", target); return url.href; }
    if (provider === "openstreetmap") { const url = new URL("https://www.openstreetmap.org/search"); url.searchParams.set("query", target); return url.href; }
    if (provider === "amap") { const url = new URL("https://uri.amap.com/search"); url.searchParams.set("keyword", clean(query || label)); url.searchParams.set("src", "travel-plan"); return url.href; }
    return "";
  }

  async function estimateRoute({ mode, fromCoordinates, toCoordinates, fetchImpl = globalThis.fetch }) {
    const from = point(fromCoordinates); const to = point(toCoordinates);
    if (!from || !to) throw new Error("需要有效的起点和终点坐标。可以手动填写预计时间，不需要联网。");
    if ((from.system && from.system !== "wgs84") || (to.system && to.system !== "wgs84")) throw new Error("OSRM 估算需要 WGS-84 坐标；当前坐标系不兼容。可手动填写时间，或使用所选地图服务导航。");
    const profile = ({ walking: "foot", bicycle: "bike", taxi: "driving", driving: "driving" })[mode];
    if (!profile) throw new Error("OSRM 当前只尝试步行、自行车和道路驾驶路线；此方式请手动填写预计时间，或打开所选地图服务。");
    if (typeof fetchImpl !== "function") throw new Error("当前浏览器无法连接 OSRM 路线服务。可继续手动填写预计时间。");
    // This explicit user action sends only the two coordinate pairs and selected profile.
    const url = `https://router.project-osrm.org/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`OSRM 暂不可用（HTTP ${response.status}）。可手动填写预计时间。`);
    const result = await response.json();
    const route = result.routes?.[0];
    if (result.code !== "Ok" || !route || !Number.isFinite(route.duration) || !Number.isFinite(route.distance)) throw new Error("OSRM 没有返回这类交通方式的路线；可手动填写预计时间。");
    return {
      estimatedMinutes: Math.max(1, Math.round(route.duration / 60)),
      distance: route.distance >= 1000 ? `${(route.distance / 1000).toFixed(1)} km` : `${Math.round(route.distance)} m`,
      timeSource: "route", source: "OSRM public routing service",
      note: "路线网络估算，不含实时交通；不是实际行程耗时。"
    };
  }

  function mergeRouteEstimate(current, estimate, allowReplaceManual = false) {
    const hasManualMinutes = current.timeSource === "manual" && current.estimatedMinutes !== "" && current.estimatedMinutes != null;
    if (hasManualMinutes && !allowReplaceManual) return { ...current, applied: false, suggestion: estimate };
    return {
      ...current,
      estimatedMinutes: estimate.estimatedMinutes,
      distance: current.distance || estimate.distance,
      timeSource: "route", applied: true, suggestion: estimate
    };
  }

  const WEATHER_CODES = new Map([[0,"晴"],[1,"大致晴朗"],[2,"局部多云"],[3,"阴"],[45,"雾"],[48,"雾凇"],[51,"毛毛雨"],[53,"毛毛雨"],[55,"毛毛雨"],[56,"冻毛毛雨"],[57,"冻毛毛雨"],[61,"小雨"],[63,"中雨"],[65,"大雨"],[66,"冻雨"],[67,"冻雨"],[71,"小雪"],[73,"中雪"],[75,"大雪"],[77,"雪粒"],[80,"阵雨"],[81,"阵雨"],[82,"强阵雨"],[85,"阵雪"],[86,"强阵雪"],[95,"雷暴"],[96,"雷暴伴冰雹"],[99,"强雷暴伴冰雹"]]);

  function dayDistance(date, now) {
    const [year, month, day] = String(date || "").split("-").map(Number);
    if (![year, month, day].every(Number.isFinite)) return NaN;
    return Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  }

  async function getWeather({ date, location = "", coordinates, fetchImpl = globalThis.fetch, now = new Date() }) {
    const selectedDate = String(date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate) || Number.isNaN(Date.parse(`${selectedDate}T00:00:00Z`)) || new Date(`${selectedDate}T00:00:00Z`).toISOString().slice(0, 10) !== selectedDate) throw new Error("这一天没有有效日期，无法查询天气。");
    const offset = dayDistance(date, now);
    if (!Number.isFinite(offset)) return { available: false, date, message: "所选日期无效；没有查询天气。", source: "Open-Meteo" };
    if (offset < 0) return { available: false, date, message: "所选日期已过去；当前预报服务不提供本页面所需的历史天气。", source: "Open-Meteo" };
    if (offset > 15) return { available: false, date, message: "天气预报将在日期临近时提供。Open-Meteo 当前通常覆盖今天至未来 16 天；没有查询或展示替代天气。", source: "Open-Meteo" };
    let coords = point(coordinates); let place = clean(location);
    if (coords?.system && coords.system !== "wgs84") coords = null;
    if (!coords) {
      if (!place) throw new Error("这一天没有可用地点；补充地点后即可查询天气。");
      const geocodingUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
      geocodingUrl.searchParams.set("name", place); geocodingUrl.searchParams.set("count", "1"); geocodingUrl.searchParams.set("language", "zh"); geocodingUrl.searchParams.set("format", "json");
      const geocodingResponse = await fetchImpl(geocodingUrl.href, { headers: { Accept: "application/json" } });
      if (!geocodingResponse.ok) throw new Error(`Open-Meteo 地名查询失败（HTTP ${geocodingResponse.status}）。`);
      const match = (await geocodingResponse.json()).results?.[0];
      if (!match) throw new Error("Open-Meteo 未找到该地点。请填写更具体的城市名称或坐标。");
      coords = point(match); place = [match.name, match.admin1, match.country].filter(Boolean).join(" · ");
    }
    if (!coords) throw new Error("无法识别地点坐标；没有请求天气数据。");
    const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
    weatherUrl.searchParams.set("latitude", String(coords.lat)); weatherUrl.searchParams.set("longitude", String(coords.lng));
    weatherUrl.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max");
    weatherUrl.searchParams.set("wind_speed_unit", "kmh");
    weatherUrl.searchParams.set("timezone", "auto"); weatherUrl.searchParams.set("start_date", date); weatherUrl.searchParams.set("end_date", date);
    const response = await fetchImpl(weatherUrl.href, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Open-Meteo 天气查询失败（HTTP ${response.status}）。`);
    const payload = await response.json();
    const daily = payload.daily || {};
    const index = (daily.time || []).indexOf(date);
    if (index < 0) return { available: false, date, place, source: "Open-Meteo", message: "服务未返回所选日期的预报；没有使用其他日期或估算值替代。" };
    const hasData = [daily.weather_code?.[index], daily.temperature_2m_max?.[index], daily.temperature_2m_min?.[index], daily.precipitation_probability_max?.[index], daily.wind_speed_10m_max?.[index]].some((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
    if (!hasData) return { available: false, date, place, source: "Open-Meteo", message: "Open-Meteo 暂未返回这一天的可用天气数据；没有使用其他日期或估算值替代。" };
    return {
      available: true, source: "Open-Meteo", date, place,
      condition: WEATHER_CODES.get(daily.weather_code?.[index]) || "天气状况未知",
      high: daily.temperature_2m_max?.[index], low: daily.temperature_2m_min?.[index],
      rainProbability: daily.precipitation_probability_max?.[index],
      windSpeed: daily.wind_speed_10m_max?.[index],
      timezone: payload.timezone || "",
      note: "模型预报会随时效变化，不是实际天气保证。"
    };
  }

  const api = Object.freeze({ PROVIDERS, MODE_LABELS, point, allowedMapUrl, directionsUrl, placeUrl, estimateRoute, mergeRouteEstimate, getWeather });
  if (typeof window !== "undefined") window.TravelPhase3 = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
