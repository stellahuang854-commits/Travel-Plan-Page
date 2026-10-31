/* Golden route interaction reused with frozen map templates. */
let mapRoutes = [];
let mapInstance = 0;
const transportNames = {
  drive: "自驾", train: "火车", rail: "火车", "cable-car": "缆车",
  hike: "步行", walk: "步行", return: "返程", "rental-car": "租车",
  boat: "游船", ferry: "渡轮", flight: "飞行", transfer: "接驳"
};

function mapRouteDefinitions(source) {
  return routeLayersFor(source).map(({ day, color }) => ({ day, color }));
}

function dailyMapLayoutFor(source, dayNumber) {
  const authored = source.dailyLayouts?.[String(dayNumber)];
  if (authored) return { places: [], labels: {}, transport: [], ...authored };
  const route = routeLayersFor(source).find((candidate) => candidate.day === dayNumber);
  if (!route) return null;
  return { places: route.placeIds || [], labels: {}, transport: [] };
}

function itineraryMapPlaceIds(day, layout, placeLayers, resolvePlace = canonicalPlaceFor) {
  const items = Array.isArray(day?.schedule) ? day.schedule : [];
  const labels = new Set([
    ...(day?.locations || []),
    ...items.flatMap((item) => [item.location, item.placeName].filter(Boolean)),
    ...items.flatMap((item) => [...(item.placeIds || []), ...(item.placeId ? [item.placeId] : [])].map((placeId) => {
      const place = resolvePlace(placeId);
      return place?.nameZh || place?.name || "";
    }).filter(Boolean))
  ].map((label) => String(label).trim().toLocaleLowerCase()).filter(Boolean));
  if (!labels.size) return [];
  return (layout?.places || []).filter((placeId) => {
    const entry = placeLayers.find((place) => place.id === placeId);
    if (!entry) return false;
    const canonical = resolvePlace(placeId);
    const names = [entry.lines?.at(-1), entry.label, canonical?.nameZh, canonical?.name].filter(Boolean).map((name) => String(name).trim().toLocaleLowerCase());
    return names.some((name) => labels.has(name));
  });
}

function placeOptions(source, placeId) {
  const place = placeLayersFor(source).find((item) => item.id === placeId);
  if (!place) return [[placeId, placeId]];
  if (Array.isArray(place.options) && place.options.length) return place.options.map((option) => [option.label, option.query]);
  return [[place.lines?.at(-1) || placeId, place.query || place.lines?.[0] || placeId]];
}

function scheduleItemsForPin(day, pin) {
  const references = Array.isArray(pin?.itemIds) && pin.itemIds.length ? pin.itemIds : pin?.items || [];
  return references.map((reference) => typeof reference === "number"
    ? day.schedule[reference]
    : day.schedule.find((item) => item.id === reference)
  ).filter(Boolean);
}

function dailyViewportFor(source) {
  const canvas = source.canvas || { width: 1448, height: 1086 };
  return { x: 0, y: 0, width: canvas.width, height: canvas.height };
}

function transportIcon(type) {
  const icons = {
    drive: '<path d="m5 9 2-5h10l2 5M4 9h16v9H4zM7 18v2m10-2v2M7 12h1m8 0h1"/>',
    "cable-car": '<path d="m2 4 20-2M12 3v5M6 9h12l2 9H4zM6 18v3h12v-3M9 9v9m6-9v9"/>',
    train: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 10h14M12 3v7m-4 5h1m6 0h1M8 18l-3 4m11-4 3 4M7 20h10"/>',
    hike: '<circle cx="14" cy="4" r="2"/><path d="m11 8 4 2 3 4m-7-6-3 6-4 1m7-3 3 4-1 6m-2-10-3 7-4 3M8 8l-2 3"/>',
    boat: '<path d="M12 3v11M5 7h14v6M3 14l9-3 9 3-3 6H6zM2 22q3-3 5 0 3-3 5 0 3-3 5 0 3-3 5 0"/>',
    "rental-car": '<path d="m3 10 2-5h9l2 5M2 10h15v8H2zM5 18v2m9-2v2M5 13h1m7 0h1M18 4h4m-2-2 2 2-2 2"/>',
    flight: '<path d="M3 16 21 8M9 13 5 6l2-1 6 5m2-1 1-6 2-1 1 5M8 15l-1 4 2-1 3-4"/>'
  };
  const key = type === "rail" ? "train" : type === "ferry" ? "boat" : type === "walk" ? "hike" : ["return", "transfer"].includes(type) ? "drive" : type;
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[key] || icons.drive}</svg>`;
}

function mapArtwork(source, selected, id, viewport) {
  if (!selected) return travelOverviewArtwork(state.data.days, source);
  const layout = dailyMapLayoutFor(source, selected.day);
  const day = state.data.days.find((item) => item.day === selected.day);
  const doc = new DOMParser().parseFromString(travelOverviewArtwork(state.data.days, source, { includeAllPlaces: true, useDetailedRoutes: true }), "image/svg+xml");
  const svg = doc.documentElement;
  svg.removeAttribute("data-overview-version");
  svg.setAttribute("data-daily-version", "3");
  svg.setAttribute("aria-label", day.title);
  svg.querySelector("title").textContent = day.title;
  svg.querySelector("desc").textContent = "仅显示当天路线；地点圆点打开地图，交通图标查看行程。";
  svg.querySelectorAll('[id^="overview-route-"]').forEach((group) => {
    if (group.id !== `overview-route-${selected.day}`) group.remove();
  });
  ["overview-date-legend", "overview-markers", "overview-geographic-names"].forEach((key) => svg.querySelector(`#${key}`)?.remove());
  svg.querySelectorAll('[id^="overview-label-"]').forEach((label) => {
    const placeId = label.id.replace("overview-label-", "");
    if (!layout?.places.includes(placeId)) { label.remove(); return; }
    const place = placeLayersFor(source).find((item) => item.id === placeId);
    const labelLayout = layout.labels?.[placeId] || { x: place?.tx, y: place?.ty, anchor: place?.anchor };
    if (!Number.isFinite(Number(labelLayout.x)) || !Number.isFinite(Number(labelLayout.y))) { label.remove(); return; }
    label.setAttribute("x", labelLayout.x);
    label.setAttribute("y", labelLayout.y);
    label.setAttribute("text-anchor", labelLayout.anchor || "start");
    label.querySelectorAll("tspan").forEach((line) => line.setAttribute("x", labelLayout.x));
  });
  svg.querySelectorAll("[id]").forEach((element) => { element.id = `${id}-${element.id}`; });
  return new XMLSerializer().serializeToString(svg);
}

function dailyPointRole(layout, placeId, index) {
  if (layout.roles?.[placeId]) return layout.roles[placeId];
  if (layout.places.length === 1) return "起点 / 终点";
  if (index === 0) return "起点";
  if (index === layout.places.length - 1) return "终点";
  return "途经点";
}

function travelMapMarkup(source, route) {
  const id = `travel-map-${++mapInstance}`;
  const day = route && state.data.days.find((item) => item.day === route.day);
  const layout = route && dailyMapLayoutFor(source, route.day);
  const canvas = source.canvas || { width: 1448, height: 1086 };
  const viewport = route ? dailyViewportFor(source, layout) : { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const position = (x, y) => `left:${(x - viewport.x) / viewport.width * 100}%;top:${(y - viewport.y) / viewport.height * 100}%`;
  const placeLayers = placeLayersFor(source);
  const places = route && layout ? layout.places.map((placeId, index) => {
    const place = placeLayers.find((item) => item.id === placeId);
    if (!place) return "";
    const role = dailyPointRole(layout, placeId, index);
    return `<button type="button" class="map-place-dot" style="${position(place.x, place.y)}" data-map-region="${escapeHtml(source.id)}" data-place-id="${placeId}" data-place-day="${day.day}" data-place-role="${role}" aria-label="${role}：${escapeHtml(placeOptions(source, placeId)[0][0])}，打开 Google Maps" aria-haspopup="dialog" aria-expanded="false"><span></span></button>`;
  }).join("") : "";
  const transport = route && layout ? layout.transport.map((pin, index) => {
    const item = scheduleItemsForPin(day, pin)[0];
    if (!item) return "";
    return `<button class="transport-pin" type="button" style="${position(pin.x, pin.y)}" data-map-region="${escapeHtml(source.id)}" data-transport-day="${day.day}" data-transport-group="${index}" aria-expanded="false" aria-haspopup="dialog" aria-label="查看${escapeHtml(transportNames[item.type] || "交通")}：${escapeHtml(item.text)}">${transportIcon(item.type)}</button>`;
  }).join("") : "";
  const mapNote = source.disclaimer || "本图为模板化行程示意图，仅表达地点的相对方位与路线顺序，不代表真实比例或精确地理边界。如需使用真实国家或城市地图，可在生成后自行调整。";
  return `<div class="travel-map-block ${route ? "is-daily" : "is-overview"}" ${route ? `style="--route-color:${route.color}"` : ""}>
    <div class="travel-map-scroll"><div class="travel-map-canvas" id="${id}">${mapArtwork(source, route, id, viewport)}${places}${transport}</div></div>
    <div class="map-utility"><span>${route ? "点圆点看地图 · 点图标看交通" : escapeHtml(mapNote)}</span><button type="button" data-expand-map="${id}">放大 ↗</button></div>
  </div>`;
}

function activateDayMaps(root) {
  $$(".is-daily .travel-map-scroll", root).forEach((view) => {
    if (view.dataset.positioned || !view.clientWidth) return;
    view.scrollLeft = 0;
    view.dataset.positioned = "true";
  });
}

function renderRoutePanel(regionId, dayNumber = 0) {
  const root = $("#route-explorer");
  const routeMap = state.data?.routeMap;
  const regions = travelMapRegions(routeMap);
  const source = travelMapSource(routeMap, regionId || routeMap?.defaultRegionId || root.dataset.region);
  root.dataset.region = source.id || "";
  mapRoutes = mapRouteDefinitions(source);
  const route = mapRoutes.find((item) => item.day === dayNumber);
  root.innerHTML = `<div class="route-region-tabs" aria-label="旅行国家">${regions.map((region) => `<button type="button" data-route-region="${escapeHtml(region.id)}" aria-pressed="${region.id === source.id}">${escapeHtml(region.label || region.heading?.text || region.id)}</button>`).join("")}</div>
  <div class="route-day-tabs" aria-label="${escapeHtml(source.label || "当前国家")}路线日期"><button type="button" data-route-day="0" aria-pressed="${!route}">总览</button>${mapRoutes.map((item) => { const day = state.data.days.find((candidate) => candidate.day === item.day); return day ? `<button type="button" data-route-day="${item.day}" style="--route-color:${item.color}" aria-pressed="${item === route}"><i></i>${day.date.slice(5).replace("-", "/")}</button>` : ""; }).join("")}</div>${travelMapMarkup(source, route)}`;
  if (route) activateDayMaps(root);
}

function setupRouteExplorer() {
  renderRoutePanel();
  let activePin = null;
  let popover = null;
  const closePopover = (restoreFocus = false) => {
    const opener = activePin;
    if (opener) { opener.setAttribute("aria-expanded", "false"); opener.removeAttribute("aria-controls"); }
    popover?.remove(); popover = null; activePin = null;
    if (restoreFocus) opener?.focus({ preventScroll: true });
  };
  const positionPopover = () => {
    if (!popover || !activePin) return;
    const point = activePin.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(innerWidth - popover.offsetWidth - 8, point.left + point.width / 2 - popover.offsetWidth / 2))}px`;
    popover.style.top = `${Math.max(8, Math.min(innerHeight - popover.offsetHeight - 8, point.top - popover.offsetHeight - 10))}px`;
  };
  const showPopover = (pin, content, map = false) => {
    const wasOpen = activePin === pin; closePopover(); if (wasOpen) return;
    activePin = pin; pin.setAttribute("aria-expanded", "true"); pin.setAttribute("aria-controls", "route-active-popover");
    popover = document.createElement("section"); popover.id = "route-active-popover"; popover.className = `route-popover ${map ? "route-place-popover" : "transport-popover"}`;
    popover.setAttribute("role", "dialog"); popover.setAttribute("aria-label", map ? "地点 Google Maps" : "交通信息");
    popover.innerHTML = `<button type="button" class="route-popover-close" data-close-route-popover aria-label="关闭">×</button>${content}`;
    (pin.closest("dialog") || document.body).append(popover); positionPopover();
    popover.querySelector("[data-close-route-popover]").focus({ preventScroll: true });
  };
  document.addEventListener("click", (event) => {
    const region = event.target.closest("[data-route-region]");
    const dayButton = event.target.closest("[data-route-day]");
    if (region || dayButton) {
      closePopover();
      const selectedRegionId = region?.dataset.routeRegion || $("#route-explorer").dataset.region;
      renderRoutePanel(selectedRegionId, region ? 0 : Number(dayButton?.dataset.routeDay || 0));
      return;
    }
    if (event.target.closest("[data-close-route-popover]")) { closePopover(true); return; }
    const placePin = event.target.closest("[data-place-id]");
    if (placePin) {
      const source = travelMapSource(state.data?.routeMap, placePin.dataset.mapRegion);
      const options = placeOptions(source, placePin.dataset.placeId);
      const [label, query] = options[0];
      showPopover(placePin, `<header><small>${escapeHtml(placePin.dataset.placeRole)}</small><strong data-popup-place-label>${escapeHtml(label)}</strong></header>
        ${options.length > 1 ? `<div class="popup-place-options">${options.map(([name, value], index) => `<button type="button" data-popup-query="${escapeHtml(value)}" data-popup-label="${escapeHtml(name)}" aria-pressed="${index === 0}">${escapeHtml(name)}</button>`).join("")}</div>` : ""}
        <iframe title="${escapeHtml(label)} Google Maps" src="https://maps.google.com/maps?q=${encodeURIComponent(query)}&output=embed" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
        <footer><a data-popup-external href="${mapsSearch(query)}" target="_blank" rel="noopener noreferrer">用 Google Maps 打开 ↗</a><small>页内地图供查看，实际导航以地图服务结果为准。</small></footer>`, true);
      return;
    }
    const pin = event.target.closest("[data-transport-day]");
    if (pin) {
      const day = state.data.days.find((item) => item.day === Number(pin.dataset.transportDay));
      const source = travelMapSource(state.data?.routeMap, pin.dataset.mapRegion);
      const group = dailyMapLayoutFor(source, day.day).transport[Number(pin.dataset.transportGroup)];
      showPopover(pin, scheduleItemsForPin(day, group).map((item) => `<div class="transport-leg"><strong>${escapeHtml(transportNames[item.type] || "交通")} · ${escapeHtml(item.time)}</strong><p>${escapeHtml(item.text)}</p></div>`).join(""));
      return;
    }
    const option = event.target.closest("[data-popup-query]");
    if (option && popover) {
      const query = option.dataset.popupQuery;
      const label = option.dataset.popupLabel;
      $$("[data-popup-query]", popover).forEach((button) => button.setAttribute("aria-pressed", String(button === option)));
      $("[data-popup-place-label]", popover).textContent = label;
      const frame = $("iframe", popover); frame.title = `${label} Google Maps`; frame.src = `https://maps.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
      $("[data-popup-external]", popover).href = mapsSearch(query);
      return;
    }
    if (event.target.closest(".route-popover")) return;
    closePopover();
    const zoom = event.target.closest("[data-expand-map]");
    if (zoom) {
      const dialog = $("#map-dialog");
      const source = document.getElementById(zoom.dataset.expandMap);
      const copy = source.cloneNode(true);
      const svg = copy.querySelector("svg");
      const ids = [...svg.querySelectorAll("[id]")].map((element) => element.id);
      for (const oldId of ids) svg.innerHTML = svg.innerHTML.replaceAll(`id="${oldId}"`, `id="${oldId}-zoom"`).replaceAll(`url(#${oldId})`, `url(#${oldId}-zoom)`);
      copy.removeAttribute("id"); copy.classList.toggle("daily-fullscreen", Boolean(source.closest(".is-daily")));
      copy.style.setProperty("--route-color", getComputedStyle(source).getPropertyValue("--route-color"));
      $("#map-dialog-content").replaceChildren(copy); dialog.showModal();
      const viewport = $("#map-dialog-content"); viewport.scrollLeft = Math.max(0, (copy.scrollWidth - viewport.clientWidth) / 2);
    }
    const link = event.target.closest("[data-open-day]");
    if (link) {
      event.preventDefault();
      const button = $(`[data-day="${Number(link.dataset.openDay)}"] .day-toggle`);
      if (button.getAttribute("aria-expanded") !== "true") button.click();
      button.scrollIntoView({ behavior: "smooth" });
    }
    const toggle = event.target.closest(".day-toggle");
    if (toggle && toggle.getAttribute("aria-expanded") === "true") activateDayMaps(toggle.closest(".day-card"));
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && activePin) { event.preventDefault(); event.stopPropagation(); closePopover(true); } });
  window.addEventListener("resize", positionPopover);
  document.addEventListener("scroll", (event) => { if (!event.target.closest?.(".route-popover")) positionPopover(); }, true);
  document.addEventListener("focusin", (event) => { if (popover && !popover.contains(event.target) && event.target !== activePin) closePopover(); });
  window.addEventListener("travel-view:shown", () => {
    const roots = [$("#route-explorer"), ...$$(".day-detail:not([hidden])")].filter(Boolean);
    roots.forEach((root) => {
      $$(".is-daily .travel-map-scroll", root).forEach((view) => view.removeAttribute("data-positioned"));
      activateDayMaps(root);
    });
  });
  $("#map-close").onclick = () => $("#map-dialog").close();
  $("#map-dialog").addEventListener("close", () => closePopover());
  $$(".day-detail:not([hidden])").forEach(activateDayMaps);
}

window.TravelRouteUI = Object.freeze({
  itineraryMapPlaceIds,
  dayMapPoints(day, data = state.data) {
    const places = Array.isArray(data?.places) ? data.places : [];
    return (day?.schedule || []).map((item, index) => {
      const place = places.find((entry) => entry.id === item.placeId);
      const geo = place?.geo || {};
      const rawLat = String(item.locationLatitude ?? "").trim() ? item.locationLatitude : item.latitude ?? geo.lat;
      const rawLng = String(item.locationLongitude ?? "").trim() ? item.locationLongitude : item.longitude ?? geo.lng;
      const lat = rawLat === "" || rawLat === undefined || rawLat === null ? NaN : Number(rawLat);
      const lng = rawLng === "" || rawLng === undefined || rawLng === null ? NaN : Number(rawLng);
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) return null;
      const label = String(item.location || item.placeName || place?.nameZh || place?.name || item.text || item.title || "").trim();
      return label ? { id: String(item.id || `day-${day.id}-${index + 1}`), label, lat, lng, coordinateSystem: item.coordinateSystem || geo.system || "", number: index + 1, time: item.time || "" } : null;
    }).filter(Boolean).map((point, index) => ({ ...point, number: index + 1 }));
  },
  renderItineraryDayMap(day) {
    const points = this.dayMapPoints(day);
    if (!points.length) return "";
    const width = 720; const height = 380; const padX = 58; const padY = 52;
    const meanLat = points.reduce((total, point) => total + point.lat, 0) / points.length;
    const projected = points.map((point) => ({ ...point, xGeo: point.lng * Math.cos(meanLat * Math.PI / 180), yGeo: -point.lat }));
    const minX = Math.min(...projected.map((point) => point.xGeo)); const maxX = Math.max(...projected.map((point) => point.xGeo));
    const minY = Math.min(...projected.map((point) => point.yGeo)); const maxY = Math.max(...projected.map((point) => point.yGeo));
    const spanX = Math.max(maxX - minX, 0.0001); const spanY = Math.max(maxY - minY, 0.0001);
    const scale = Math.min((width - padX * 2) / spanX, (height - padY * 2) / spanY);
    const plotted = projected.map((point) => ({ ...point, x: width / 2 + (point.xGeo - (minX + maxX) / 2) * scale, y: height / 2 + (point.yGeo - (minY + maxY) / 2) * scale }));
    const line = plotted.map((point) => `${point.x},${point.y}`).join(" ");
    const markers = plotted.map((point, index) => `<g class="day-map-marker" tabindex="0" role="button" aria-label="第 ${index + 1} 站：${escapeHtml(point.label)}" data-day-map-marker="${index}"><circle cx="${point.x}" cy="${point.y}" r="19"></circle><text x="${point.x}" y="${point.y + 5}">${index + 1}</text></g>`).join("");
    const stops = plotted.map((point) => `<li><span>${point.number}</span><strong>${escapeHtml(point.label)}</strong>${point.time ? `<small>${escapeHtml(point.time)}</small>` : ""}</li>`).join("");
    return `<div class="itinerary-map" data-map-day="${escapeHtml(day.id)}" data-map-count="${plotted.length}">
      <div class="itinerary-map__toolbar"><span>${plotted.length} 个已填写坐标的行程地点</span><div><button type="button" data-day-map-zoom="out" aria-label="缩小地图">−</button><button type="button" data-day-map-zoom="reset">适配</button><button type="button" data-day-map-zoom="in" aria-label="放大地图">＋</button></div></div>
      <div class="itinerary-map__viewport" data-day-map-viewport><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="当天实际坐标路线图"><g data-day-map-layer><polyline points="${line}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="8 8" opacity=".58"></polyline>${markers}</g></svg></div>
      <div class="itinerary-map__info" data-day-map-info role="status" aria-live="polite">点击数字标记查看地点名称；可拖动地图，路线位置按已填坐标绘制。</div>
      <ol class="itinerary-map__stops">${stops}</ol>
    </div>`;
  },
  activateItineraryDayMap(root) {
    if (!root || root.dataset.dayMapBound || !root.querySelector("[data-day-map-layer]") || !root.querySelector("[data-day-map-viewport]")) return;
    root.dataset.dayMapBound = "true";
    let zoom = 1; let x = 0; let y = 0; let pointer = null;
    const apply = () => { root.querySelector("[data-day-map-layer]")?.setAttribute("transform", `translate(${x} ${y}) translate(360 190) scale(${zoom}) translate(-360 -190)`); };
    root.addEventListener("click", (event) => {
      const zoomButton = event.target.closest("[data-day-map-zoom]");
      if (zoomButton) { const kind = zoomButton.dataset.dayMapZoom; zoom = kind === "reset" ? 1 : Math.max(.7, Math.min(3.5, zoom + (kind === "in" ? .25 : -.25))); if (kind === "reset") { x = 0; y = 0; } apply(); return; }
      const marker = event.target.closest("[data-day-map-marker]");
      if (marker) {
        const index = Number(marker.dataset.dayMapMarker); const point = window.TravelRouteUI.dayMapPoints(window.TravelContentEditor?.getContent?.()?.days.find((day) => day.id === root.querySelector(".itinerary-map")?.dataset.mapDay));
        const selected = point[index];
        const info = root.querySelector("[data-day-map-info]");
        if (selected && info) info.textContent = `${selected.number}. ${selected.label}${selected.time ? ` · ${selected.time}` : ""} · 坐标 ${selected.lat.toFixed(5)}, ${selected.lng.toFixed(5)}${selected.coordinateSystem ? ` (${selected.coordinateSystem})` : ""}`;
      }
    });
    root.addEventListener("pointerdown", (event) => { if (!event.target.closest("[data-day-map-viewport]") || event.target.closest("[data-day-map-marker]")) return; pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: x, originY: y }; event.target.closest("[data-day-map-viewport]")?.setPointerCapture?.(event.pointerId); });
    root.addEventListener("pointermove", (event) => { if (!pointer || pointer.id !== event.pointerId) return; x = pointer.originX + (event.clientX - pointer.x) * .7; y = pointer.originY + (event.clientY - pointer.y) * .7; apply(); });
    const finish = (event) => { if (pointer?.id === event.pointerId) pointer = null; };
    root.addEventListener("pointerup", finish); root.addEventListener("pointercancel", finish);
    root.addEventListener("keydown", (event) => { if (event.key !== "Enter" && event.key !== " ") return; const marker = event.target.closest("[data-day-map-marker]"); if (marker) { event.preventDefault(); marker.dispatchEvent(new MouseEvent("click", { bubbles: true })); } });
  },
  renderDayMap(dayNumber) {
    const day = state.data?.days?.find((item) => Number(item.day) === Number(dayNumber));
    if (!day) return "";
    const source = travelMapSourceForDay(state.data?.routeMap, Number(dayNumber));
    if (!source) return "";
    const layout = dailyMapLayoutFor(source, Number(dayNumber));
    const placeLayers = placeLayersFor(source);
    const includedPlaces = itineraryMapPlaceIds(day, layout, placeLayers);
    if (!includedPlaces.length) return "";
    const dailyLayouts = { ...(source.dailyLayouts || {}), [String(dayNumber)]: { ...layout, places: includedPlaces } };
    const routes = (source.routes || []).map((item) => Number(item.day) === Number(dayNumber) ? { ...item, placeIds: (item.placeIds || []).filter((placeId) => includedPlaces.includes(placeId)), paths: [], overviewPaths: [] } : item);
    const daySource = { ...source, dailyLayouts, routes };
    const route = mapRouteDefinitions(daySource).find((item) => Number(item.day) === Number(dayNumber));
    if (!route) return "";
    return travelMapMarkup(daySource, route);
  },
  activateDayMap(root) {
    if (!root) return;
    if (root.querySelector(".itinerary-map")) this.activateItineraryDayMap(root);
    else activateDayMaps(root);
  }
});
