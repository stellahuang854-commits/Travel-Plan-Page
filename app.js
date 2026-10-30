const state = {
  data: null,
  config: null,
  runtimeAdapters: {},
  expandedDay: null,
  countdownTimer: null,
  purchasedTickets: new Set(),
  todos: [],
  todoCategories: []
};

const MODULE_NAMES = Object.freeze(["flights", "overview", "itinerary", "todo", "driving", "ledger"]);
const SHARED_COLLECTIONS = Object.freeze(["todos", "tickets", "ledger"]);

function normalizeTripConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== "1.0.0") throw new Error("trip-data.json config.schemaVersion must be 1.0.0");
  if (!raw.modules || typeof raw.modules !== "object") throw new Error("trip-data.json config must contain confirmed module switches");
  const modules = Object.fromEntries(MODULE_NAMES.map((name) => {
    if (typeof raw.modules[name] !== "boolean") throw new Error(`trip-data.json config.modules.${name} must be boolean`);
    return [name, raw.modules[name]];
  }));
  const mode = raw?.persistence?.mode;
  if (mode !== "local" && mode !== "d1") throw new Error("trip-data.json config.persistence.mode must be local or d1");
  const sharedCollections = mode === "d1" ? [...new Set(raw.persistence.sharedCollections || [])] : [];
  if (mode === "d1" && (!sharedCollections.length || sharedCollections.some((name) => !SHARED_COLLECTIONS.includes(name)))) {
    throw new Error("D1 mode requires an explicit sharedCollections allowlist");
  }
  const apiBase = raw.persistence.apiBase || "/api/trip";
  if (mode === "d1" && (!/^\/(?!\/)/.test(apiBase) || apiBase.includes("\\") || /[?#]/.test(apiBase))) {
    throw new Error("D1 apiBase must be a same-origin path");
  }
  return {
    ...raw,
    modules,
    persistence: {
      ...(raw.persistence || {}),
      mode,
      ...(mode === "d1" ? { apiBase, sharedCollections } : {})
    }
  };
}

function moduleEnabled(name) {
  if (name === "ledger") return true;
  return Boolean(state.config && state.config.modules?.[name] === true);
}

function applyModuleConfig() {
  document.querySelectorAll("[data-module]").forEach((element) => {
    if (element.id === "ledger-view") return;
    if (element.id === "flights" || element.id === "ledger-navigation-link") {
      element.hidden = false;
      return;
    }
    element.hidden = !moduleEnabled(element.dataset.module);
  });
  const visibleTravelLinks = [...document.querySelectorAll(".travel-navigation-menu [data-module]")].filter((link) => !link.hidden);
  const travelNavigation = $("#travel-navigation");
  if (travelNavigation) travelNavigation.hidden = visibleTravelLinks.length === 0;
  document.documentElement.dataset.persistence = state.config.persistence.mode;

  const hashModules = {
    "#flights": "flights", "#route": "overview", "#itinerary": "itinerary",
    "#drive": "driving", "#prep": "todo", "#ledger": "ledger", "#ledger-stats": "ledger"
  };
  const requestedModule = hashModules[location.hash];
  if (requestedModule && !moduleEnabled(requestedModule)) {
    const firstVisible = visibleTravelLinks[0]?.getAttribute("href") || "#top";
    history.replaceState({ view: "travel" }, "", firstVisible);
  }
  window.dispatchEvent(new CustomEvent("travel-config:ready", { detail: { config: state.config } }));
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
})[character]);

const airportCity = (airport) => airport.city || airport.airportCode;

function localDateTime(date, time, _airportCode, utcOffset = "") {
  return new Date(`${date}T${time}:00${utcOffset || "+00:00"}`);
}

function countdownParts(target, now = new Date()) {
  const difference = target.getTime() - now.getTime();
  if (difference <= 0) return { difference, days: 0, hours: 0, minutes: 0 };
  const totalMinutes = Math.floor(difference / 60000);
  return {
    difference,
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60
  };
}

function countdownText(target, completionText = "已出发") {
  const value = countdownParts(target);
  if (value.difference <= 0) return completionText;
  if (value.days > 0) return `${value.days}天 ${String(value.hours).padStart(2, "0")}小时`;
  if (value.hours > 0) return `${value.hours}小时 ${String(value.minutes).padStart(2, "0")}分`;
  return `${Math.max(1, value.minutes)}分钟`;
}

function preciseCountdownText(target, completionText = "已出发") {
  const difference = target.getTime() - Date.now();
  if (difference <= 0) return completionText;
  const totalSeconds = Math.floor(difference / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `${days}天 ${clock}` : clock;
}

function formatDate(dateString, includeYear = false) {
  const date = new Date(`${dateString}T12:00:00`);
  const options = includeYear
    ? { year: "numeric", month: "long", day: "numeric" }
    : { month: "long", day: "numeric" };
  return new Intl.DateTimeFormat("zh-CN", options).format(date);
}

function formatCompactDate(dateString) {
  const [, month, day] = dateString.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function todayForTrip() {
  const timeZone = state.data?.metadata?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
}

function mapsSearch(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function heroDestinationFor(trip) {
  const destinations = (trip.countries || []).filter((country) => (trip.primaryDestinationCountries || []).includes(country.code));
  const isDomestic = destinations.length > 0 && destinations.every((country) => country.code === "CN");
  const customTitle = String(trip.heroTitle || "").trim();
  if (customTitle) {
    return { title: customTitle, eyebrow: String(trip.heroEyebrow || "").trim(), destinations, isDomestic };
  }
  if (isDomestic) {
    const destination = String(trip.primaryDestinationName || trip.primaryDestinationCity || trip.citiesAndAreas?.[0] || "目的地待补充").trim();
    return {
      title: destination,
      eyebrow: String(trip.primaryDestinationNameEn || trip.primaryDestinationCityEn || "DOMESTIC JOURNEY").trim(),
      destinations,
      isDomestic
    };
  }
  return {
    title: destinations.map((country) => country.nameZh || country.name).join(" × ") || "目的地待补充",
    eyebrow: destinations.map((country) => country.nameEn || country.name).filter(Boolean).join(" × "),
    destinations,
    isDomestic
  };
}

function renderHero() {
  const { trip } = state.data;
  if (trip.status === "uninitialized") {
    const title = String(state.data.metadata?.title || "旅行计划待生成");
    document.title = title;
    $("#trip-title").textContent = title;
    $("#trip-eyebrow").textContent = "READY FOR YOUR JOURNEY";
    $("#wordmark").innerHTML = "TRIP <span>· READY</span>";
    $("#footer-mark").textContent = "TRIP · READY";
    $("#route-day-count").textContent = "0 DAYS";
    $("#trip-date").textContent = "等待旅行资料";
    return;
  }
  const hero = heroDestinationFor(trip);
  const { destinations } = hero;
  const shortMark = destinations.map((country) => country.code).join(" / ");
  const startDate = typeof trip.startDate === "string" ? trip.startDate : "";
  const endDate = typeof trip.endDate === "string" ? trip.endDate : "";
  const year = startDate.slice(0, 4);
  const title = String(state.data.metadata?.title || hero.title);
  document.title = title;
  $("#trip-title").textContent = title;
  $("#trip-eyebrow").textContent = hero.eyebrow;
  $("#wordmark").innerHTML = `${escapeHtml(shortMark)}${year ? ` <span>· ${escapeHtml(year)}</span>` : ""}`;
  $("#footer-mark").textContent = [shortMark, year].filter(Boolean).join(" · ");
  $("#route-day-count").textContent = `${trip.dayCount} DAYS`;
  $("#trip-date").textContent = startDate && endDate
    ? `${formatCompactDate(startDate)} — ${formatCompactDate(endDate)} · ${trip.dayCount}天`
    : "日期待补充";
}

function journeyFlights(journeyId) {
  return state.data.flights
    .filter((flight) => flight.journeyId === journeyId)
    .sort((first, second) => first.sequence - second.sequence);
}

function journeyStatusAndTarget(flights) {
  const now = new Date();
  for (const flight of flights) {
    const departure = localDateTime(flight.departure.date, flight.departure.time, flight.departure.airportCode, flight.departure.utcOffset);
    const arrival = localDateTime(flight.arrival.date, flight.arrival.time, flight.arrival.airportCode, flight.arrival.utcOffset);
    if (now < departure) return { target: departure, label: flight === flights[0] ? "距离起飞还剩" : "距离下一程起飞还剩", complete: false };
    if (now < arrival) return { target: arrival, label: "飞行中 · 距抵达", complete: false };
  }
  return { target: null, label: "已抵达", complete: true };
}

function relativeFlightDate(date, journeyStartDate) {
  if (date === journeyStartDate) return formatCompactDate(date);
  const difference = Math.round((new Date(`${date}T12:00:00`) - new Date(`${journeyStartDate}T12:00:00`)) / 86400000);
  return difference === 1 ? "次日" : formatCompactDate(date);
}

function flightStopMarkup(stop, position, journeyStartDate) {
  let timing;
  if (position === 0) {
    timing = `<span>${escapeHtml(relativeFlightDate(stop.departure.date, journeyStartDate))}</span><b>${escapeHtml(stop.departure.time)} 出发</b>`;
  } else if (position === stop.totalStops - 1) {
    timing = `<span>${escapeHtml(relativeFlightDate(stop.arrival.date, journeyStartDate))}</span><b>${escapeHtml(stop.arrival.time)} 抵达</b>`;
  } else {
    const nextFlight = stop.nextFlight;
    const connection = nextFlight.connectionFromPrevious || {};
    const duration = connection.calculatedFromSchedule || connection.durationUsingTicketTimes || connection.plannedDurationText || "中转";
    timing = `
      <span>${escapeHtml(stop.arrival.time)} 抵达</span>
      <em>${escapeHtml(duration)}</em>
      <b>${escapeHtml(relativeFlightDate(nextFlight.departure.date, journeyStartDate))} ${escapeHtml(nextFlight.departure.time)}</b>
      <span>起飞</span>
    `;
  }
  return `
    <div class="flight-stop${position > 0 && position < stop.totalStops - 1 ? " is-transfer" : ""}">
      <span class="flight-stop__code">${escapeHtml(stop.airport.airportCode)}</span>
      <span class="flight-stop__city">${escapeHtml(airportCity(stop.airport))}</span>
      <span class="flight-stop__dot" aria-hidden="true"></span>
      <div class="flight-stop__timing">${timing}</div>
    </div>
  `;
}

function flightMissingFieldLabel(field) {
  return ({
    carrierId: "航空公司",
    flightNumber: "航班号",
    departure: "起飞信息",
    arrival: "抵达信息",
    departurePlace: "出发机场",
    arrivalPlace: "抵达机场",
    departureTime: "起飞时间",
    arrivalTime: "抵达时间",
    timeZone: "当地时区"
  })[field] || String(field || "待补充信息");
}

function flightPlaceholderCard(journey, index) {
  const missingFields = [...new Set(journey.missingFields || [])].map(flightMissingFieldLabel);
  return `
    <article class="flight-card flight-card--placeholder" data-journey="${escapeHtml(journey.id)}">
      <div class="flight-card__top">
        <span>FLIGHT ${String(index + 1).padStart(2, "0")} / ${String(state.data.flightJourneys.length).padStart(2, "0")}</span>
      </div>
      <div class="flight-placeholder">
        <span class="flight-placeholder__eyebrow">资料待补充</span>
        <h3>${escapeHtml(journey.title || "航班信息待补充")}</h3>
        <p>已按第二轮确认继续生成标准预览；系统没有猜测或伪造缺失的航班事实。</p>
        ${missingFields.length ? `<ul>${missingFields.map((field) => `<li>${escapeHtml(field)}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="flight-card__countdown-row">
        <div class="flight-countdown" data-countdown-journey="${escapeHtml(journey.id)}" data-placeholder="true">
          <span>当前状态</span>
          <strong>待补充</strong>
        </div>
      </div>
    </article>
  `;
}

function flightCard(journey, index) {
  const flights = journeyFlights(journey.id);
  if (journey.placeholder || journey.status === "missing" || journey.status === "pending" || !flights.length || flights.some((flight) => flight.placeholder)) {
    return flightPlaceholderCard(journey, index);
  }
  const first = flights[0];
  const last = flights[flights.length - 1];
  const status = journeyStatusAndTarget(flights);
  const countdown = status.complete ? "已完成" : preciseCountdownText(status.target, "即将出发");
  const stops = [
    { airport: first.departure, departure: first.departure },
    ...flights.map((flight, flightIndex) => ({
      airport: flight.arrival,
      arrival: flight.arrival,
      nextFlight: flights[flightIndex + 1]
    }))
  ];
  const routeItems = [];
  stops.forEach((stop, stopIndex) => {
    routeItems.push(flightStopMarkup({ ...stop, totalStops: stops.length }, stopIndex, first.departure.date));
    if (stopIndex < flights.length) {
      const flight = flights[stopIndex];
      routeItems.push(`
        <div class="flight-segment">
          <span>${escapeHtml(flight.flightNumber)}</span>
          <i aria-hidden="true">→</i>
        </div>
      `);
    }
  });
  return `
    <article class="flight-card" data-journey="${escapeHtml(journey.id)}">
      <div class="flight-card__top">
        <span>FLIGHT ${String(index + 1).padStart(2, "0")} / ${String(state.data.flightJourneys.length).padStart(2, "0")}</span>
      </div>
      <div class="flight-card__airlines">${escapeHtml([...new Set(flights.map((flight) => flight.airline.nameZh || flight.airline.name))].join(" · "))}</div>
      <div class="flight-flow" style="--route-columns: ${stops.map((_, stopIndex) => stopIndex < stops.length - 1 ? "minmax(0,1fr) minmax(34px,.5fr)" : "minmax(0,1fr)").join(" ")}">
        ${routeItems.join("")}
      </div>
      <div class="flight-card__countdown-row">
        <div class="flight-countdown" data-countdown-journey="${escapeHtml(journey.id)}">
          <span>${escapeHtml(status.label)}</span>
          <strong>${escapeHtml(countdown)}</strong>
        </div>
      </div>
    </article>
  `;
}

function renderFlights() {
  const currentContent = window.TravelContentEditor?.getContent();
  const transportRecords = currentContent?.transportRecords || [];
  const section = $("#flights");
  if (section) section.hidden = false;
  const navigationLink = document.querySelector('.travel-navigation-menu [data-module="flights"]');
  if (navigationLink) navigationLink.hidden = section?.hidden ?? true;
  const navigation = $("#travel-navigation");
  if (navigation) navigation.hidden = ![...document.querySelectorAll(".travel-navigation-menu [data-module]")].some((link) => !link.hidden);
  $("#flight-index").hidden = true;
  const carousel = $("#flight-carousel");
  const boardings = window.TravelContentView?.renderBoardingPasses(currentContent, window.TravelLedger?.getSnapshot()?.travelers || []) || "";
  carousel.innerHTML = boardings;
  carousel.classList.toggle("flight-carousel--single", (boardings.match(/mini-boarding-pass--groups/g) || []).length === 1);
}

function transportDirection(record) {
  return window.TravelContentStore?.journeyRoleFor(record) || "";
}

let travelContentDisplayRevision = 0;
function renderTravelContentDisplay() {
  const display = $("#travel-content-display");
  const content = window.TravelContentEditor?.getContent?.();
  if (!display || !content || !window.TravelContentView) return;
  const revision = ++travelContentDisplayRevision;
  const attachmentCounts = {};
  const render = () => {
    display.innerHTML = window.TravelContentView.renderPublicContent(content, window.TravelLedger?.getSnapshot?.()?.travelers || [], attachmentCounts, state.data);
    display.hidden = !display.innerHTML;
  };
  render();
  if (!window.TravelAttachmentStore) return;
  void window.TravelAttachmentStore.list(state.data.metadata.tripId).then((attachments) => {
    if (revision !== travelContentDisplayRevision) return;
    attachments.forEach((attachment) => { attachmentCounts[attachment.transportId] = (attachmentCounts[attachment.transportId] || 0) + 1; });
    render();
  }).catch((error) => console.warn("Travel archive attachments could not be listed", error));
}

function flightDetailLines(journey) {
  const flights = journeyFlights(journey.id);
  const first = flights[0] || {};
  const last = flights.at(-1) || {};
  const info = window.TravelContentEditor?.getSourceDetails("journey", journey.id) || {};
  const pieces = [
    ["出发机场", [first.departure?.airportCode, first.departure?.city, first.departure?.airportName].filter(Boolean).join(" · ")],
    ["到达机场", [last.arrival?.airportCode, last.arrival?.city, last.arrival?.airportName].filter(Boolean).join(" · ")],
    ["出发日期", first.departure?.date], ["到达日期", last.arrival?.date],
    ["出发时间", first.departure?.time], ["到达时间", last.arrival?.time],
    ["航班号", flights.map((item) => item.flightNumber).filter(Boolean).join(" · ")],
    ["航站楼", info.terminal || first.departure?.terminal], ["登机口", info.gate || first.departure?.gate],
    ["登机时间", info.boardingTime], ["座位号", info.seat], ["行李信息", info.baggage], ["乘客信息", info.passenger]
  ].filter(([, value]) => value);
  return { info, pieces };
}

function openTransportDetail({ transportId, sourceType = "record", sourceId = transportId, type = "other", title = "交通详情", transport = null, journey = null, attachmentOnly = false }) {
  const dialog = $("#transport-detail-dialog");
  if (!dialog) return;
  const detail = journey ? flightDetailLines(journey) : { info: transport || {}, pieces: transportDetailLines(transport || {}) };
  dialog.dataset.transportId = transportId;
  dialog.dataset.sourceType = sourceType;
  dialog.dataset.sourceId = sourceId;
  dialog.dataset.transportType = type;
  $("#transport-detail-title").textContent = title;
  const fields = detail.pieces.map(([label, value]) => `<div class="transport-detail-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  const isFlight = type === "flight";
  const optional = isFlight ? [
    ["terminal", "航站楼", detail.info.terminal || ""], ["gate", "登机口", detail.info.gate || ""], ["boardingTime", "登机时间", detail.info.boardingTime || "", "time"],
    ["seat", "座位号", detail.info.seat || ""], ["baggage", "行李信息", detail.info.baggage || ""], ["passenger", "乘客信息", detail.info.passenger || ""], ["note", "备注", detail.info.note || "", "textarea"]
  ] : [
    ["arrivalDate", "到达日期", detail.info.arrivalDate || "", "date"], ["serviceNumber", type === "ferry-boat" ? "船次 / 票号" : "车次 / 交通编号", detail.info.serviceNumber || ""],
    ["seat", "座位号", detail.info.seat || ""], ["baggage", "行李信息", detail.info.baggage || ""], ["passenger", "乘客信息", detail.info.passenger || ""], ["note", "备注", detail.info.note || "", "textarea"]
  ];
  const formFields = optional.map(([name, label, value, kind]) => kind === "textarea"
    ? `<label class="travel-editor-field"><span>${label}</span><textarea name="${name}" rows="2">${escapeHtml(value)}</textarea></label>`
    : `<label class="travel-editor-field"><span>${label}</span><input name="${name}" type="${kind || "text"}" value="${escapeHtml(value)}"></label>`).join("");
  $("#transport-detail-body").innerHTML = `<div class="transport-detail-ticket"><div class="transport-detail-summary"><span class="section-kicker">${isFlight ? "FLIGHT DETAILS" : "TRAVEL DETAILS"}</span><dl>${fields || `<p class="ticket-dialog__empty">尚未填写详情。</p>`}</dl></div>${attachmentOnly ? "" : `<form class="transport-detail-form"><h3>补充信息</h3><div class="transport-detail-fields">${formFields}</div><button type="submit">保存详情</button><p class="transport-detail-status" role="status" aria-live="polite"></p></form>`}<section class="transport-attachments"><div class="travel-content-list__heading"><h3>附件与凭证</h3><label class="transport-upload-button">上传 PDF / 图片<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif" multiple></label></div><p class="transport-attachment-hint">保留原始附件；单个文件最大 25 MB。${state.config.persistence.mode === "d1" ? "附件保存在受权限保护的私人云存储。" : "附件只保存在此浏览器的本地存储中。"}</p><div class="transport-attachment-list" aria-live="polite"></div></section></div>`;
  dialog.showModal();
  void refreshTransportAttachments(dialog);
}

function transportDetailLines(record) {
  const typeLabel = ({ "high-speed-rail": "High-speed rail", train: "Train", metro: "Metro", "bus-coach": "Bus/Coach", "ferry-boat": "Ferry/Boat", "taxi-ride-hailing": "Taxi/Ride-hailing", "rental-car-driving": "Rental car/Driving", walking: "Walking", bicycle: "Bicycle", flight: "Flight", other: "Other" })[record.type] || record.type;
  return [["交通方式", typeLabel], ["出发地点", record.from], ["到达地点", record.to], ["出发日期", record.date], ["到达日期", record.arrivalDate || record.date], ["出发时间", record.startTime], ["到达时间", record.endTime], ["车次 / 编号", record.serviceNumber], ["座位号", record.seat], ["行李信息", record.baggage], ["乘客信息", record.passenger], ["备注", record.note]].filter(([, value]) => value);
}

async function refreshTransportAttachments(dialog) {
  const list = $(".transport-attachment-list", dialog);
  try {
    const attachments = await window.TravelAttachmentStore.list(state.data.metadata.tripId, dialog.dataset.transportId);
    list.innerHTML = attachments.length ? attachments.map((file) => `<article class="transport-attachment" data-attachment-id="${escapeHtml(file.id)}"><div><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.type)} · ${(file.size / 1024 / 1024).toFixed(2)} MB</small></div><div><button type="button" data-attachment-open="${escapeHtml(file.id)}">预览</button><label>替换<input type="file" data-attachment-replace="${escapeHtml(file.id)}" accept="application/pdf,image/*"></label><button type="button" data-attachment-delete="${escapeHtml(file.id)}">删除</button></div></article>`).join("") : `<p class="ticket-dialog__empty">尚未上传凭证。可以添加航空公司、铁路或轮渡提供的原始 PDF / 图片。</p>`;
  } catch (error) { list.innerHTML = `<p class="transport-detail-status is-error">凭证读取失败：${escapeHtml(error.message || "本地存储不可用")}</p>`; }
}

function setAttachmentStatus(host, message, error = false) {
  const status = $(".transport-detail-status", host) || $(".transport-attachment-hint", host);
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", error);
}

function setupTransportDetailDialog() {
  const dialog = $("#transport-detail-dialog");
  if (!dialog) return;
  let previewUrls = [];
  const close = () => { previewUrls.forEach(URL.revokeObjectURL); previewUrls = []; dialog.close(); };
  $("#transport-detail-close").onclick = close;
  document.addEventListener("click", (event) => {
    const passengerButton = event.target.closest("[data-passenger-journey-detail]");
    if (passengerButton) {
      const recordId = passengerButton.dataset.passengerJourneyDetail;
      const journeyId = passengerButton.dataset.passengerJourneyId;
      const record = window.TravelContentEditor?.getContent()?.transportRecords.find((item) => item.id === recordId);
      const passengerJourney = record && window.TravelContentStore.normalizePassengerJourneys(record).find((item) => item.id === journeyId);
      if (record && passengerJourney) {
        const names = (window.TravelLedger?.getSnapshot?.()?.travelers || []).filter((person) => (passengerJourney.travelerIds || []).includes(String(person.id))).map((person) => person.name);
        const transport = { ...passengerJourney, passenger: [...new Set([...names, passengerJourney.passenger, passengerJourney.passengerName].filter(Boolean))].join("、") };
        const attachmentId = passengerButton.dataset.attachmentTransportId || window.TravelContentStore.passengerJourneyAttachmentKey(record.id, passengerJourney.id);
        openTransportDetail({ transportId: attachmentId, type: passengerJourney.type || record.type, title: [passengerJourney.serviceNumber || passengerJourney.flightNumber || "交通班次", transport.passenger].filter(Boolean).join(" · "), transport, attachmentOnly: true });
      } else if (!record && recordId.startsWith("source-")) {
        const journey = state.data.flightJourneys.find((item) => item.id === recordId.slice("source-".length));
        if (journey) openTransportDetail({ transportId: passengerButton.dataset.attachmentTransportId || `flight-journey:${journey.id}`, sourceType: "journey", sourceId: journey.id, type: "flight", title: "原始航班详情", journey });
      }
      return;
    }
    const archiveAttachment = event.target.closest("[data-archive-attachment]");
    if (archiveAttachment) {
      openTransportDetail({ transportId: archiveAttachment.dataset.archiveAttachment, type: "other", title: "旅行资料附件", attachmentOnly: true });
      return;
    }
    const journeyButton = event.target.closest("[data-journey-detail]");
    if (journeyButton) {
      const journey = state.data.flightJourneys.find((item) => item.id === journeyButton.dataset.journeyDetail);
      if (journey) openTransportDetail({ transportId: `flight-journey:${journey.id}`, sourceType: "journey", sourceId: journey.id, type: "flight", title: journey.title || "原有航班详情", journey });
      return;
    }
    const recordButton = event.target.closest("[data-record-detail]");
    if (recordButton) {
      const record = window.TravelContentEditor?.getContent()?.transportRecords.find((item) => item.id === recordButton.dataset.recordDetail);
      if (record) openTransportDetail({ transportId: record.id, sourceType: "record", sourceId: record.id, type: record.type, title: record.journeyRole === "return" ? "回程交通详情" : record.journeyRole === "outbound" ? "去程交通详情" : "交通详情", transport: record });
      return;
    }
    const addTransport = event.target.closest("[data-add-transport]");
    if (addTransport) { window.TravelContentEditor?.openTransportForRole?.(addTransport.dataset.addTransport); return; }
  });
  window.addEventListener("travel-transport-detail", (event) => {
    const record = event.detail;
    if (!record) return;
    let journey = null;
    if (record.sourceType === "journey") journey = state.data.flightJourneys.find((item) => item.id === record.sourceId);
    if (record.sourceType === "flight") {
      const flight = state.data.flights.find((item) => item.id === record.sourceId);
      journey = state.data.flightJourneys.find((item) => item.id === flight?.journeyId);
    }
    const flightSource = Boolean(journey || record.sourceType === "flight" || record.type === "flight");
    const sourceType = flightSource ? "journey" : "record";
    const sourceId = journey?.id || record.id;
    const transportId = journey ? `flight-journey:${journey.id}` : record.id;
    openTransportDetail({ transportId, sourceType, sourceId, type: record.type, title: record.title || record.type, transport: record, journey });
  });
  dialog.addEventListener("click", async (event) => {
    if (event.target === dialog) { close(); return; }
    const preview = event.target.closest("[data-attachment-open]");
    const remove = event.target.closest("[data-attachment-delete]");
    if (remove) {
      if (!confirm("确定删除这份交通凭证吗？")) return;
      try { await window.TravelAttachmentStore.remove(state.data.metadata.tripId, remove.dataset.attachmentDelete); await refreshTransportAttachments(dialog); renderTravelContentDisplay(); }
      catch (error) { setAttachmentStatus(dialog, `删除失败：${error.message || "本地存储不可用"}`, true); }
      return;
    }
    if (preview) { await openAttachmentPreview(preview.dataset.attachmentOpen, dialog); }
  });
  dialog.addEventListener("change", async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.files?.length) return;
    const status = $(".transport-detail-status", dialog) || $(".transport-attachment-hint", dialog);
    const replaceId = input.dataset.attachmentReplace;
    try {
      const added = await window.TravelAttachmentStore.add(state.data.metadata.tripId, dialog.dataset.transportId, input.files[0]);
      if (replaceId) await window.TravelAttachmentStore.remove(state.data.metadata.tripId, replaceId);
      status.textContent = replaceId ? "凭证已替换。" : `已保存 ${input.files.length} 份凭证。`;
      for (const file of [...input.files].slice(1)) await window.TravelAttachmentStore.add(state.data.metadata.tripId, dialog.dataset.transportId, file);
      await refreshTransportAttachments(dialog);
      renderTravelContentDisplay();
    } catch (error) { status.textContent = `附件保存失败：${error.message || "本地存储空间不足"}`; status.classList.add("is-error"); }
    finally { input.value = ""; }
  });
  dialog.addEventListener("submit", async (event) => {
    if (!event.target.matches(".transport-detail-form")) return;
    event.preventDefault();
    const form = event.target;
    const details = Object.fromEntries(new FormData(form).entries());
    const status = $(".transport-detail-status", form);
    try {
      const saved = await window.TravelContentEditor.saveSourceDetails(dialog.dataset.sourceType, dialog.dataset.sourceId, details);
      if (!saved) throw new Error("本地保存失败，请重试。");
      status.textContent = "交通详情已保存。";
    } catch (error) { status.textContent = `保存失败：${error.message || "本地存储不可用"}`; status.classList.add("is-error"); }
  });
  dialog.addEventListener("close", () => { previewUrls.forEach(URL.revokeObjectURL); previewUrls = []; });

  async function openAttachmentPreview(id, host) {
    const record = await window.TravelAttachmentStore.get(state.data.metadata.tripId, id);
    if (!record) { setAttachmentStatus(host, "找不到这份凭证。", true); return; }
    const url = URL.createObjectURL(record.blob); previewUrls.push(url);
    const content = record.type === "application/pdf"
      ? `<iframe class="ticket-dialog__preview ticket-dialog__preview--pdf" src="${url}#toolbar=1" title="${escapeHtml(record.name)}"></iframe><a class="transport-download" href="${url}" download="${escapeHtml(record.name)}">若无法预览，请下载或在新标签页打开</a>`
      : `<button type="button" class="transport-image-zoom" aria-label="放大查看二维码或凭证"><img class="ticket-dialog__preview" src="${url}" alt="${escapeHtml(record.name)}"></button><a class="transport-download" href="${url}" download="${escapeHtml(record.name)}">下载原始图片</a>`;
    const view = document.createElement("dialog");
    view.className = "ticket-dialog attachment-preview-dialog";
    view.innerHTML = `<header><div><span>ORIGINAL ATTACHMENT</span><h2>${escapeHtml(record.name)}</h2></div><button type="button">关闭</button></header><div class="ticket-dialog__body">${content}</div>`;
    document.body.append(view);
    view.querySelector("header button").onclick = () => { view.close(); view.remove(); };
    view.addEventListener("click", (e) => { if (e.target === view) { view.close(); view.remove(); } });
    view.showModal();
    view.querySelector(".transport-image-zoom")?.addEventListener("click", (e) => e.currentTarget.classList.toggle("is-zoomed"));
  }
}

function updateFlightCountdowns() {
  state.data.flightJourneys.forEach((journey) => {
    const target = $(`[data-countdown-journey="${journey.id}"]`);
    if (!target || target.dataset.placeholder === "true" || journey.placeholder) return;
    const status = journeyStatusAndTarget(journeyFlights(journey.id));
    const countdown = status.complete ? "已完成" : preciseCountdownText(status.target, "即将出发");
    if (target.classList.contains("mini-boarding-pass__status")) target.textContent = `${status.label} · ${countdown}`;
    else { $("strong", target).textContent = countdown; $("span", target).textContent = status.label; }
  });
}

function costText(cost) {
  if (cost.amount !== undefined) return `${cost.item} · ${cost.currency} ${cost.amount}`;
  if (cost.standard !== undefined && cost.standard !== null) return `${cost.item} · ${cost.currency} ${cost.standard}`;
  if (cost.discounted !== undefined && cost.discounted !== null) return `${cost.item} · ${cost.currency} ${cost.discounted}`;
  if (cost.amountOptions) return `${cost.item} · ${cost.currency} ${cost.amountOptions.join(" / ")}`;
  return cost.item;
}

function ticketsForDay(day) {
  if (!moduleEnabled("itinerary")) return [];
  return (state.data.ticketPlanning?.items || []).filter((ticket) =>
    ticket.dayId ? ticket.dayId === day.id : ticket.day === day.day
  );
}

function ticketsForSchedule(day, item) {
  if (!moduleEnabled("itinerary")) return [];
  const tickets = ticketsForDay(day);
  if (Array.isArray(item.ticketIds)) return tickets.filter((ticket) => item.ticketIds.includes(ticket.id));
  if (item.id) {
    const explicit = tickets.filter((ticket) => (ticket.scheduleItemIds || ticket.itemIds || []).includes(item.id));
    if (explicit.length) return explicit;
  }
  const lowerText = String(item.text || item.title || "").toLocaleLowerCase();
  return tickets.filter((ticket) => (ticket.scheduleMatchTerms || []).some((term) => lowerText.includes(term.toLocaleLowerCase())));
}

function isTicketPurchased(ticket) {
  return ticket.purchaseStatus === "purchased" || state.purchasedTickets.has(ticket.id);
}

function ticketRequirement(ticket) {
  return ({
    "advance-required": "需提前购票",
    "advance-recommended": "建议预约",
    "needs-confirmation": "购票方式待确认"
  })[ticket.requirement] || "门票信息";
}

function ticketTitle(ticket) {
  return ticket.name || ticket.attraction?.nameZh || ticket.attraction?.name || "门票详情";
}

function ticketGuidance(ticket) {
  const guidance = ticket.guidance || ticket.notes || [];
  return Array.isArray(guidance) ? guidance.join("·") : String(guidance || "");
}

function ticketDocument(ticket) {
  const document = ticket.document || ticket.booking?.document;
  if (document && typeof document === "object") {
    return { url: document.url || document.path || "", type: document.type || "", label: document.label || "查看票据" };
  }
  const url = ticket.documentUrl || ticket.booking?.documentUrl || "";
  return url ? { url, type: "", label: ticket.documentLabel || "查看票据" } : null;
}

function inlineTicketMarkup(ticket) {
  const purchased = isTicketPurchased(ticket);
  const title = ticketTitle(ticket);
  return `
    <div class="schedule-ticket ${purchased ? "is-purchased" : `is-${escapeHtml(ticket.requirement)}`}" data-inline-ticket="${escapeHtml(ticket.id)}">
      <label class="schedule-ticket__toggle">
        <input type="checkbox" value="${escapeHtml(ticket.id)}" ${purchased ? "checked" : ""} aria-label="${purchased ? "取消已购票" : "标记为已购票"}：${escapeHtml(title)}">
        <span class="schedule-ticket__check" aria-hidden="true">✓</span>
        <span class="schedule-ticket__content">
          <span class="schedule-ticket__status">${purchased ? "已购票" : escapeHtml(ticketRequirement(ticket))}</span>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(ticketGuidance(ticket))}</small>
        </span>
      </label>
      <button type="button" class="schedule-ticket__open" data-ticket-open="${escapeHtml(ticket.id)}" aria-haspopup="dialog" aria-controls="ticket-dialog">查看</button>
    </div>`;
}

const CONNECTION_LABELS = Object.freeze({ walking: ["🚶", "步行"], bicycle: ["🚲", "自行车"], taxi: ["🚕", "出租车 / 网约车"], driving: ["🚗", "自驾"], metro: ["🚇", "地铁"], bus: ["🚌", "公交车"], train: ["🚆", "火车"], ferry: ["⛴️", "轮渡"], other: ["⇢", "其他"] });

function scheduleLocation(item) {
  const place = item.placeId ? state.data.places.find((entry) => entry.id === item.placeId) : null;
  const label = String(item.location || item.placeName || place?.nameZh || place?.name || "").trim();
  const rawLatitude = item.locationLatitude === "" || item.locationLatitude === undefined ? place?.geo?.lat : item.locationLatitude;
  const rawLongitude = item.locationLongitude === "" || item.locationLongitude === undefined ? place?.geo?.lng : item.locationLongitude;
  const latitude = rawLatitude == null || rawLatitude === "" ? NaN : Number(rawLatitude);
  const longitude = rawLongitude == null || rawLongitude === "" ? NaN : Number(rawLongitude);
  const coordinateSystem = item.coordinateSystem || place?.geo?.system;
  const coordinates = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { lat: latitude, lng: longitude, ...(coordinateSystem ? { system: coordinateSystem } : {}) } : null;
  return { placeId: item.placeId || place?.id || "", label, coordinates };
}

function connectionForPair(day, first, second) {
  const connection = (window.TravelContentEditor?.getContent()?.connections || []).find((item) => item.dayId === day.id && item.fromItemId === first.id && item.toItemId === second.id);
  if (!connection) return null;
  const from = scheduleLocation(first); const to = scheduleLocation(second);
  const stale = connection.fromPlaceId !== from.placeId || connection.toPlaceId !== to.placeId || connection.fromLabel !== from.label || connection.toLabel !== to.label || JSON.stringify(connection.fromCoordinates || null) !== JSON.stringify(from.coordinates) || JSON.stringify(connection.toCoordinates || null) !== JSON.stringify(to.coordinates);
  return { ...connection, stale };
}

function connectionMarkup(day, first, second) {
  const connection = connectionForPair(day, first, second);
  if (!connection) return `<li class="timeline-connection"><span aria-hidden="true">↓</span><button type="button" data-connection-edit data-day-id="${escapeHtml(day.id)}" data-from-item="${escapeHtml(first.id)}" data-to-item="${escapeHtml(second.id)}">＋ 添加交通衔接</button></li>`;
  const [icon, label] = CONNECTION_LABELS[connection.mode] || CONNECTION_LABELS.other;
  const time = connection.estimatedMinutes ? `预计 ${connection.estimatedMinutes} 分钟` : "耗时待补充";
  const detail = connection.stale ? "行程顺序或地点已变更，请重新确认这段衔接" : `${connection.distance ? `${connection.distance} · ` : ""}${connection.timeSource === "route" ? "路线估算" : "手动预计"}${connection.note ? ` · ${connection.note}` : ""}`;
  const routeLink = !connection.stale ? safeMapUrl(connection.routeUrl, connection.mapProvider) : "";
  const navigationLink = !connection.stale ? safeMapUrl(connection.navigationUrl, connection.mapProvider) || window.TravelPhase3?.directionsUrl(connection) || "" : "";
  const provider = window.TravelPhase3?.PROVIDERS?.[connection.mapProvider] || "所选地图";
  const unavailableNote = !connection.stale && connection.mapProvider === "amap" && !navigationLink ? "需 GCJ-02 坐标" : "";
  return `<li class="timeline-connection${connection.stale ? " is-stale" : ""}"><span aria-hidden="true">↓</span><button type="button" data-connection-edit data-connection-id="${escapeHtml(connection.id)}" data-day-id="${escapeHtml(day.id)}" data-from-item="${escapeHtml(first.id)}" data-to-item="${escapeHtml(second.id)}"><b>${escapeHtml(icon)} ${escapeHtml(label)} · ${escapeHtml(time)}</b><small>${escapeHtml(detail)}</small></button>${routeLink ? `<a href="${escapeHtml(routeLink)}" target="_blank" rel="noopener noreferrer">地图路线 ↗</a>` : ""}${navigationLink ? `<a href="${escapeHtml(navigationLink)}" target="_blank" rel="noopener noreferrer" aria-label="发送此段路线到${escapeHtml(provider)}">${escapeHtml(provider)} 导航 ↗</a>` : unavailableNote ? `<small>${unavailableNote}</small>` : ""}</li>`;
}

function nonAdjacentConnections(day) {
  const schedule = day.schedule || [];
  const connections = window.TravelContentEditor?.getContent()?.connections || [];
  return connections.filter((connection) => {
    if (connection.dayId !== day.id) return false;
    const fromIndex = schedule.findIndex((item) => item.id === connection.fromItemId);
    const toIndex = schedule.findIndex((item) => item.id === connection.toItemId);
    return fromIndex >= 0 && toIndex >= 0 && toIndex !== fromIndex + 1;
  });
}

function openConnectionEditor(button) {
  const day = state.data.days.find((item) => item.id === button.dataset.dayId);
  const first = day?.schedule?.find((item) => item.id === button.dataset.fromItem);
  const second = day?.schedule?.find((item) => item.id === button.dataset.toItem);
  if (!day || !first || !second) return;
  const content = window.TravelContentEditor?.getContent();
  const connection = content?.connections.find((item) => item.id === button.dataset.connectionId || item.dayId === day.id && item.fromItemId === first.id && item.toItemId === second.id);
  const from = scheduleLocation(first); const to = scheduleLocation(second);
  const form = $("#connection-form");
  form.elements.dayId.value = day.id; form.elements.fromItemId.value = first.id; form.elements.toItemId.value = second.id; form.elements.id.value = connection?.id || "";
  form.elements.mode.value = connection?.mode || "walking";
  form.elements.timeSource.value = connection?.timeSource || "manual";
  form.elements.estimatedMinutes.value = connection?.estimatedMinutes ?? "";
  form.elements.distance.value = connection?.distance || "";
  form.elements.note.value = connection?.note || "";
  form.elements.mapProvider.value = connection?.mapProvider || first.mapProvider || "google";
  form.elements.routeUrl.value = connection?.routeUrl || "";
  form.elements.navigationUrl.value = connection?.navigationUrl || "";
  form.dataset.fromCoordinates = JSON.stringify(from.coordinates);
  form.dataset.toCoordinates = JSON.stringify(to.coordinates);
  $("#connection-route-label").textContent = `${from.label || "出发地点待补充"} → ${to.label || "目的地点待补充"}`;
  $("#connection-delete").hidden = !connection;
  const status = $("#connection-form .connection-status"); status.textContent = ""; status.classList.remove("is-error");
  updateConnectionEstimateAvailability(form);
  $("#connection-apply-estimate").hidden = true;
  $("#connection-apply-estimate").dataset.result = "";
  $("#connection-dialog").showModal();
}

function updateConnectionEstimateAvailability(form) {
  const button = $("#connection-estimate");
  let hasCoordinates = false;
  try { hasCoordinates = Boolean(JSON.parse(form.dataset.fromCoordinates || "null") && JSON.parse(form.dataset.toCoordinates || "null")); } catch { hasCoordinates = false; }
  const supportedMode = ["walking", "bicycle", "taxi", "driving"].includes(form.elements.mode.value);
  button.disabled = !hasCoordinates || !supportedMode;
  button.textContent = !hasCoordinates ? "补充两端坐标后可估算" : supportedMode ? "使用 OSRM 估算" : "此方式请手动填写时间";
}

function setupConnectionDialog() {
  const dialog = $("#connection-dialog");
  if (!dialog) return;
  $("#connection-dialog-close").onclick = () => dialog.close();
  $("#connection-estimate").onclick = async () => {
    const form = $("#connection-form");
    const status = $("#connection-form .connection-status");
    const button = $("#connection-estimate");
    button.disabled = true; status.classList.remove("is-error"); status.textContent = "正在向 OSRM 请求此段路线……";
    try {
      const result = await window.TravelPhase3.estimateRoute({ mode: form.elements.mode.value, fromCoordinates: JSON.parse(form.dataset.fromCoordinates || "null"), toCoordinates: JSON.parse(form.dataset.toCoordinates || "null") });
      const merged = window.TravelPhase3.mergeRouteEstimate({ estimatedMinutes: form.elements.estimatedMinutes.value, distance: form.elements.distance.value.trim(), timeSource: form.elements.timeSource.value }, result);
      if (!merged.applied) {
        $("#connection-apply-estimate").dataset.result = JSON.stringify(result);
        $("#connection-apply-estimate").hidden = false;
        status.textContent = `OSRM 路线估算：${result.estimatedMinutes} 分钟，${result.distance}。你已有的手动 ${form.elements.estimatedMinutes.value} 分钟已保留；如要替换，请另行点击“采用路线估算”。`;
      } else {
        form.elements.estimatedMinutes.value = String(merged.estimatedMinutes);
        form.elements.distance.value = merged.distance;
        form.elements.timeSource.value = merged.timeSource;
        status.textContent = `已填入 OSRM 路线估算：${result.estimatedMinutes} 分钟，${result.distance}。你可继续修改；估算不含实时交通。`;
      }
    } catch (error) { status.textContent = error.message || "路线估算失败；可手动填写预计时间。"; status.classList.add("is-error"); }
    finally { updateConnectionEstimateAvailability(form); }
  };
  $("#connection-apply-estimate").onclick = () => {
    const form = $("#connection-form"); const button = $("#connection-apply-estimate");
    try {
      const result = JSON.parse(button.dataset.result);
      const merged = window.TravelPhase3.mergeRouteEstimate({ estimatedMinutes: form.elements.estimatedMinutes.value, distance: form.elements.distance.value.trim(), timeSource: form.elements.timeSource.value }, result, true);
      form.elements.estimatedMinutes.value = String(merged.estimatedMinutes);
      form.elements.distance.value = merged.distance;
      form.elements.timeSource.value = merged.timeSource;
      $("#connection-form .connection-status").textContent = `已采用 OSRM 路线估算：${result.estimatedMinutes} 分钟，${result.distance}。`;
      button.hidden = true;
    } catch { $("#connection-form .connection-status").textContent = "路线估算结果已失效，请重新估算。"; }
  };
  $("#connection-form").elements.estimatedMinutes.addEventListener("input", () => {
    $("#connection-form").elements.timeSource.value = "manual";
    $("#connection-apply-estimate").hidden = true;
  });
  $("#connection-form").elements.mode.addEventListener("change", () => updateConnectionEstimateAvailability($("#connection-form")));
  $("#connection-delete").onclick = async () => {
    const id = $("#connection-form").elements.id.value;
    if (!id || !confirm("确定删除这段交通衔接吗？")) return;
    const saved = await window.TravelContentEditor.deleteConnection(id);
    if (saved) dialog.close();
    else { const status = $("#connection-form .connection-status"); status.textContent = "删除失败，请稍后重试。"; status.classList.add("is-error"); }
  };
  $("#connection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const day = state.data.days.find((item) => item.id === form.elements.dayId.value);
    const first = day?.schedule?.find((item) => item.id === form.elements.fromItemId.value);
    const second = day?.schedule?.find((item) => item.id === form.elements.toItemId.value);
    const status = $("#connection-form .connection-status");
    const provider = form.elements.mapProvider.value;
    if ((form.elements.routeUrl.value && !safeMapUrl(form.elements.routeUrl.value, provider)) || (form.elements.navigationUrl.value && !safeMapUrl(form.elements.navigationUrl.value, provider))) {
      status.textContent = `路线链接必须来自所选的 ${window.TravelPhase3.PROVIDERS[provider]} 服务。`; status.classList.add("is-error"); return;
    }
    if (!day || !first || !second || day.schedule.indexOf(second) !== day.schedule.indexOf(first) + 1) {
      status.textContent = "这两个项目已不再相邻。请从当前时间线位置重新建立衔接。"; status.classList.add("is-error"); return;
    }
    const minutesValue = form.elements.estimatedMinutes.value;
    const minutes = minutesValue === "" ? null : Number(minutesValue);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) { status.textContent = "预计耗时请输入 1 到 1440 的整数分钟。"; status.classList.add("is-error"); return; }
    const from = scheduleLocation(first); const to = scheduleLocation(second);
    const candidate = {
      id: form.elements.id.value || undefined, dayId: day.id,
      fromItemId: first.id, toItemId: second.id,
      fromPlaceId: from.placeId, toPlaceId: to.placeId, fromLabel: from.label, toLabel: to.label,
      fromCoordinates: from.coordinates, toCoordinates: to.coordinates,
      mode: form.elements.mode.value, estimatedMinutes: minutes,
      timeSource: form.elements.timeSource.value || "manual", distance: form.elements.distance.value.trim(), note: form.elements.note.value.trim(),
      mapProvider: form.elements.mapProvider.value, routeUrl: form.elements.routeUrl.value.trim(), navigationUrl: form.elements.navigationUrl.value.trim(), updatedAt: new Date().toISOString()
    };
    const saved = await window.TravelContentEditor.saveConnection(candidate);
    if (saved) dialog.close();
    else { status.textContent = "保存失败，交通衔接未更改。请检查本地存储空间后重试。"; status.classList.add("is-error"); }
  });
}

function dayCard(day) {
  const today = todayForTrip();
  const isToday = day.date === today;
  const expanded = state.expandedDay === day.day;
  const items = day.schedule || [];
  const schedule = items.map((item, itemIndex) => {
    const destinations = navigationDestinations(item);
    const mapLinks = destinations.map((destination) => `
      <button type="button" class="schedule-map-link" data-map-query="${escapeHtml(destination.query)}" data-map-url="${escapeHtml(destination.url || "")}" data-map-provider="${escapeHtml(destination.provider || "google")}" data-map-label="${escapeHtml(destination.label)}" aria-haspopup="dialog" aria-controls="place-map" aria-label="查看 ${escapeHtml(destination.label)} 的地图">📍 ${escapeHtml(destination.label)} · ${escapeHtml(window.TravelPhase3?.PROVIDERS?.[destination.provider || "google"] || "Google Maps")}</button>
    `).join("");
    const scheduleTickets = ticketsForSchedule(day, item).map(inlineTicketMarkup).join("");
    const scheduleMarkup = `
      <li class="schedule-item">
          <span class="schedule-time">${escapeHtml(item.time)}${item.endTime ? ` – ${escapeHtml(item.endTime)}` : ""}</span>
        <div class="schedule-content">
          <div class="schedule-text">${escapeHtml(item.text)}</div>
          ${item.details ? `<p class="detail-note">${escapeHtml(item.details)}</p>` : ""}
          ${item.note ? `<p class="detail-note">${escapeHtml(item.note)}</p>` : ""}
          ${(item.documentUrls || []).map((entry) => { const url = safeExternalUrl(typeof entry === "string" ? entry : entry.url); return url ? `<a class="schedule-map-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">查看相关文件 ↗</a>` : ""; }).join("")}
          <button type="button" class="schedule-map-link" data-schedule-attachments="${escapeHtml(item.id)}" data-day-id="${escapeHtml(day.id)}" aria-haspopup="dialog" aria-controls="transport-detail-dialog">附件 / 预约凭证</button>
          ${scheduleTickets}
          ${mapLinks ? `<div class="schedule-map-links">${mapLinks}</div>` : ""}
        </div>
      </li>
    `;
    const next = items[itemIndex + 1];
    return scheduleMarkup + (next ? connectionMarkup(day, item, next) : "");
  }).join("");
  const staleConnections = nonAdjacentConnections(day);
  const staleMarkup = staleConnections.map((connection) => `<li class="timeline-connection is-stale"><span aria-hidden="true">!</span><small>一段已保存的交通衔接不再对应相邻项目。<button type="button" data-connection-edit data-connection-id="${escapeHtml(connection.id)}" data-day-id="${escapeHtml(day.id)}" data-from-item="${escapeHtml(connection.fromItemId)}" data-to-item="${escapeHtml(connection.toItemId)}">检查 / 编辑</button></small></li>`).join("");
  const transportItems = window.TravelContentEditor?.transportsForDay(day.id) || [];
  const transportSchedule = transportItems.map((item) => `
    <li class="schedule-item schedule-item--transport">
      <span class="schedule-time">${escapeHtml(item.time)}</span>
      <div class="schedule-content"><div class="schedule-text">${escapeHtml(item.text)}</div></div>
    </li>`).join("");
  const notes = [...(day.notes || []), ...(day.sourceDateLabelConflict ? [day.sourceDateLabelConflict] : [])];
  const costs = (day.costReferences || []).map((cost) => `<span class="cost-tag">${escapeHtml(costText(cost))}</span>`).join("");
  const dayTickets = ticketsForDay(day);
  const pendingTicketCount = dayTickets.filter((ticket) => !isTicketPurchased(ticket)).length;
  const ticketSummary = dayTickets.length
    ? `<span class="day-ticket-summary ${pendingTicketCount ? "has-pending" : "is-complete"}">${pendingTicketCount ? `${pendingTicketCount} 项待购票` : "门票已准备"}</span>`
    : "";
  const weatherPlace = (day.schedule || []).map((item) => item.location || item.placeName || state.data.places.find((place) => place.id === item.placeId)?.nameZh || state.data.places.find((place) => place.id === item.placeId)?.name).find(Boolean) || (day.locations || []).find(Boolean) || "地点待补充";
  const weatherTarget = (day.schedule || []).map((item) => ({ item, place: scheduleLocation(item) })).find(({ place }) => place.label || place.coordinates);
  const weatherAvailable = Boolean(day.date && (weatherTarget?.place.label || weatherTarget?.place.coordinates || weatherPlace !== "地点待补充"));
  const weatherPlaceLabel = weatherPlace === "地点待补充" && weatherTarget?.place.coordinates ? `${weatherTarget.place.coordinates.lat}, ${weatherTarget.place.coordinates.lng}` : weatherPlace;
  return `
    <article class="day-card${isToday ? " is-today" : ""}" data-day="${day.day}">
      <span class="day-dot" aria-hidden="true"></span>
      <button class="day-toggle" type="button" aria-expanded="${expanded}" aria-controls="day-detail-${day.day}">
        <span>
          <span class="day-meta">DAY ${String(day.day).padStart(2, "0")} · ${escapeHtml(formatCompactDate(day.date))}${isToday ? " · 今天" : ""}</span>
          <span class="day-title">${escapeHtml(day.title)}</span>
          <span class="day-locations">${escapeHtml((day.locations || []).join(" → "))}</span>
          ${ticketSummary}
        </span>
        <span class="day-chevron" aria-hidden="true">+</span>
      </button>
      <div class="day-detail" id="day-detail-${day.day}" ${expanded ? "" : "hidden"}>
        <section class="day-weather" aria-label="每日天气" data-weather-panel="${escapeHtml(day.id)}"><div><strong>${escapeHtml(weatherPlaceLabel)}</strong><small>${escapeHtml(day.date || "日期待补充")}</small></div><button type="button" data-weather-day="${escapeHtml(day.id)}" ${weatherAvailable ? "" : "disabled"}>查询 Open-Meteo 天气</button><p>仅点击查询时发送此日地点和日期给 Open-Meteo；预报范围为未来 16 天。可不联网查看天气。</p><div class="day-weather-result" role="status" aria-live="polite"></div></section>
        <ol class="schedule">${schedule}${transportSchedule}${staleMarkup}</ol>
        ${costs ? `<div class="costs">${costs}</div>` : ""}
        ${notes.map((note) => `<p class="detail-note">${escapeHtml(note)}</p>`).join("")}
      </div>
    </article>
  `;
}

function navigationDestinations(item) {
  const policy = state.data.mapLinks?.navigationPolicy || { noNavigationTypes: [], selfNavigationTypes: [] };
  if (policy.noNavigationTypes.includes(item.type)) return [];
  const referencedPlaceIds = [...new Set([
    ...(Array.isArray(item.placeIds) ? item.placeIds : []),
    ...(item.placeId ? [item.placeId] : [])
  ])];
  if (referencedPlaceIds.length) {
    return referencedPlaceIds.map((placeId) => state.data.places.find((place) => place.id === placeId)).filter(Boolean).map((place) => ({
      id: place.id,
      label: place.nameZh || place.name,
      query: place.navigation?.query || place.googleMapsQuery || place.address || `${place.nameZh || place.name}${place.cityOrArea ? `, ${place.cityOrArea}` : ""}`,
      provider: item.mapProvider || place.mapProvider || "google",
      directUrl: Boolean(place.navigation?.url || place.googleMapsUrl),
      url: item.mapProvider && item.mapProvider !== "google" ? window.TravelPhase3?.placeUrl(item.mapProvider, { label: place.nameZh || place.name, query: place.navigation?.query || place.googleMapsQuery || place.address, coordinates: place.geo }) || "" : place.navigation?.url || place.googleMapsUrl || window.TravelPhase3?.placeUrl("google", { label: place.nameZh || place.name, query: place.address || place.nameZh || place.name, coordinates: place.geo }) || ""
    }));
  }
  const text = [item.text, item.title, item.location, item.placeName].filter(Boolean).join(" ");
  const lowerText = text.toLocaleLowerCase();
  const explicit = (state.data.mapLinks?.navigationPlaces || [])
    .filter((place) => place.matchTerms.some((term) => lowerText.includes(term.toLocaleLowerCase())))
    .map((place) => ({
      id: place.id,
      label: place.label,
      query: place.query,
      provider: item.mapProvider || "google",
      url: window.TravelPhase3?.placeUrl(item.mapProvider || "google", { label: place.label, query: place.query }) || "",
      priority: place.priority || 1,
      matchIndex: Math.max(...place.matchTerms.map((term) => lowerText.lastIndexOf(term.toLocaleLowerCase())))
    }));
  const highestExplicitPriority = explicit.reduce((highest, place) => Math.max(highest, place.priority), 0);
  const selectedExplicit = highestExplicitPriority > 1
    ? explicit.filter((place) => place.priority === highestExplicitPriority)
    : explicit;

  const catalogPlaces = state.data.places
    .filter((place) => [place.name, place.nameZh].filter(Boolean).some((name) => lowerText.includes(name.toLocaleLowerCase())))
    .map((place) => ({
      id: place.id,
      label: place.nameZh || place.name,
      query: place.googleMapsUrl || [place.name, place.cityOrArea].filter(Boolean).join(", "),
      provider: item.mapProvider || place.mapProvider || "google",
      url: window.TravelPhase3?.placeUrl(item.mapProvider || place.mapProvider || "google", { label: place.nameZh || place.name, query: place.address || place.name }) || "",
      directUrl: Boolean(place.googleMapsUrl),
      matchIndex: Math.max(...[place.name, place.nameZh].filter(Boolean).map((name) => lowerText.lastIndexOf(name.toLocaleLowerCase())))
    }));

  const restaurants = state.data.restaurants
    .filter((restaurant) => lowerText.includes(restaurant.name.toLocaleLowerCase()))
    .map((restaurant) => ({
      id: `restaurant-${restaurant.name}`,
      label: restaurant.name,
      query: restaurant.googleMapsUrl || `${restaurant.name}, ${restaurant.city}`,
      provider: item.mapProvider || "google",
      url: window.TravelPhase3?.placeUrl(item.mapProvider || "google", { label: restaurant.name, query: `${restaurant.name}, ${restaurant.city || ""}` }) || "",
      directUrl: Boolean(restaurant.googleMapsUrl),
      matchIndex: lowerText.lastIndexOf(restaurant.name.toLocaleLowerCase())
    }));

  const specificExplicit = selectedExplicit.filter((place) => place.priority > 1);
  let destinations = specificExplicit.length
    ? [...specificExplicit, ...restaurants]
    : catalogPlaces.length
      ? [...catalogPlaces, ...restaurants]
      : [...selectedExplicit, ...restaurants];
  destinations = destinations.filter((place, index, all) => all.findIndex((candidate) => candidate.id === place.id) === index);
  if (!destinations.length && item.location) {
    const place = scheduleLocation(item);
    const provider = item.mapProvider || "google";
    destinations = [{ id: item.id || item.location, label: item.location, query: item.location, provider, url: window.TravelPhase3?.placeUrl(provider, { label: item.location, query: item.location, coordinates: place.coordinates }) || "", matchIndex: 0 }];
  }

  if (policy.selfNavigationTypes.includes(item.type) && destinations.length > 1 && !specificExplicit.length) {
    destinations.sort((first, second) => second.matchIndex - first.matchIndex);
    return [destinations[0]];
  }
  return destinations;
}

function currentTripDay() {
  const today = todayForTrip();
  return state.data.days.find((day) => day.date === today)?.day || null;
}

function renderTimeline() {
  const today = currentTripDay();
  state.expandedDay = today;
  const orderedDays = [...state.data.days].sort((first, second) => String(first.date || "").localeCompare(String(second.date || "")) || (Number(first.day) || 0) - (Number(second.day) || 0));
  $("#day-count").textContent = `${orderedDays.length} DAYS`;
  $("#timeline").innerHTML = orderedDays.map(dayCard).join("");
  $("#timeline").onclick = (event) => {
    const weatherButton = event.target.closest("[data-weather-day]");
    if (weatherButton) { void queryDayWeather(weatherButton); return; }
    const connectionButton = event.target.closest("[data-connection-edit]");
    if (connectionButton) { openConnectionEditor(connectionButton); return; }
    const ticketButton = event.target.closest("[data-ticket-open]");
    if (ticketButton) {
      openTicketDialog(ticketButton.dataset.ticketOpen, ticketButton);
      return;
    }
    const attachmentButton = event.target.closest("[data-schedule-attachments]");
    if (attachmentButton) {
      const day = state.data.days.find((item) => item.id === attachmentButton.dataset.dayId);
      const item = day?.schedule?.find((entry) => entry.id === attachmentButton.dataset.scheduleAttachments);
      if (item) openTransportDetail({ transportId: `schedule:${item.id}`, sourceType: "schedule", sourceId: item.id, type: "other", title: item.text || item.title || "行程附件", transport: { date: day.date, from: item.location || item.placeName || "", note: item.note || "" }, attachmentOnly: true });
      return;
    }
    const toggle = event.target.closest(".day-toggle");
    if (!toggle) return;
    const card = toggle.closest(".day-card");
    const dayNumber = Number(card.dataset.day);
    const wasExpanded = toggle.getAttribute("aria-expanded") === "true";
    $$(".day-toggle", $("#timeline")).forEach((button) => button.setAttribute("aria-expanded", "false"));
    $$(".day-detail", $("#timeline")).forEach((detail) => { detail.hidden = true; });
    if (!wasExpanded) {
      toggle.setAttribute("aria-expanded", "true");
      $(`#day-detail-${dayNumber}`).hidden = false;
      state.expandedDay = dayNumber;
    } else {
      state.expandedDay = null;
    }
  };
  $("#timeline").onchange = (event) => {
    const checkbox = event.target.closest(".schedule-ticket input[type='checkbox']");
    if (!checkbox) return;
    if (checkbox.checked) state.purchasedTickets.add(checkbox.value);
    else state.purchasedTickets.delete(checkbox.value);
    saveTicketState(checkbox.value, checkbox.checked);
    updateInlineTicketState(checkbox.value, checkbox.checked);
  };
}

async function queryDayWeather(button) {
  const day = state.data.days.find((item) => item.id === button.dataset.weatherDay);
  const panel = button.closest("[data-weather-panel]");
  const output = $(".day-weather-result", panel);
  if (!day || !output || !window.TravelPhase3) return;
  const scheduleTarget = (day.schedule || []).map((item) => ({ item, place: scheduleLocation(item) })).find(({ place }) => place.label || place.coordinates);
  const coordinates = scheduleTarget?.place.coordinates || null;
  const location = scheduleTarget?.place.label || (day.locations || []).find(Boolean) || (coordinates ? `${coordinates.lat}, ${coordinates.lng}` : "");
  button.disabled = true; output.textContent = "正在向 Open-Meteo 请求此日期的天气预报……";
  try {
    const result = await window.TravelPhase3.getWeather({ date: day.date, location, coordinates });
    if (!result.available) {
      output.textContent = `${result.date || day.date} · ${result.message} 来源：${result.source || "Open-Meteo"}`;
      return;
    }
    const high = Number.isFinite(Number(result.high)) ? `${Math.round(result.high)}°` : "无数据";
    const low = Number.isFinite(Number(result.low)) ? `${Math.round(result.low)}°` : "无数据";
    const rain = Number.isFinite(Number(result.rainProbability)) ? `降雨概率 ${Math.round(result.rainProbability)}%` : "降雨概率无数据";
    output.textContent = `${result.date} · ${result.place || location} · ${result.condition} · ${low}–${high} · ${rain} · 来源 ${result.source} · ${result.note}`;
  } catch (error) { output.textContent = `天气查询失败：${error.message || "服务暂不可用"}。可稍后重试或不联网手动查看。`; }
  finally { button.disabled = false; }
}

function updateInlineTicketState(ticketId, purchased) {
  const ticketData = state.data.ticketPlanning.items.find((item) => item.id === ticketId);
  if (!ticketData) return;
  $$(`[data-inline-ticket="${ticketId}"]`).forEach((ticket) => {
    ticket.classList.toggle("is-purchased", purchased);
    ticket.querySelector("input").checked = purchased;
    ticket.querySelector("input").setAttribute("aria-label", `${purchased ? "取消已购票" : "标记为已购票"}：${ticketTitle(ticketData)}`);
    ticket.querySelector(".schedule-ticket__status").textContent = purchased ? "已购票" : ticketRequirement(ticketData);
  });
  const day = state.data.days.find((item) => ticketData.dayId ? item.id === ticketData.dayId : item.day === ticketData.day);
  const dayCardElement = day ? $(`[data-day="${day.day}"]`) : null;
  const badge = dayCardElement ? $(".day-ticket-summary", dayCardElement) : null;
  const dayTickets = day ? ticketsForDay(day) : [];
  const pending = dayTickets.filter((ticket) => !isTicketPurchased(ticket)).length;
  if (!badge) return;
  badge.textContent = pending ? `${pending} 项待购票` : "门票已准备";
  badge.classList.toggle("has-pending", pending > 0);
  badge.classList.toggle("is-complete", pending === 0);
}

async function loadTicketState() {
  state.purchasedTickets = new Set();
}

function saveTicketState(ticketId, completed) {
  return saveSharedChange("tickets", { id: ticketId, completed }, completed ? "upsert" : "delete").catch(console.error);
}

function rentalStatus(rental) {
  const pickup = new Date(`${rental.pickup.date}T${rental.pickup.time}:00${rental.pickup.utcOffset || "+00:00"}`);
  const dropoff = new Date(`${rental.dropoff.date}T${rental.dropoff.time}:00${rental.dropoff.utcOffset || "+00:00"}`);
  const now = new Date();
  if (now < pickup) return { label: "距取车", target: pickup, complete: false };
  if (now < dropoff) return { label: "距还车", target: dropoff, complete: false };
  return { label: "已超过预约还车时间", target: dropoff, complete: true };
}

function renderRental() {
  const transport = state.data.groundTransport;
  const rental = transport.rentalCar;
  $("#rental-provider-label").textContent = rental.company;
  const status = rentalStatus(rental);
  const vehicle = rental.vehicle || {};
  const price = rental.price || {};
  $("#rental-card").innerHTML = `
    <article class="rental-panel">
      <div class="return-deadline">
        <span class="return-deadline__label">重要 · 还车截止时间</span>
        <strong>${escapeHtml(formatCompactDate(rental.dropoff.date))} <time>${escapeHtml(rental.dropoff.time)}</time> 前</strong>
        <span>${escapeHtml(rental.dropoff.timeZoneLabel)}</span>
        <p>${escapeHtml(rental.dropoff.vehicleReturnPoint)}</p>
        <div class="return-deadline__timer" id="return-deadline-timer"></div>
        <p class="return-deadline__warning">${escapeHtml(rental.dropoff.deadlineWarning)}</p>
        <small>建议 ${escapeHtml(rental.dropoff.recommendedArrivalTime)} 抵达机场区域，预留还车及值机时间。</small>
      </div>
      <div class="rental-countdown" id="rental-countdown">
        <span>${escapeHtml(status.label)}</span>
        <strong>${status.complete ? `请立即联系 ${escapeHtml(rental.company)}` : escapeHtml(countdownText(status.target))}</strong>
        <small>${formatCompactDate(rental.dropoff.date)} ${escapeHtml(rental.dropoff.time)} 前 · ${escapeHtml(rental.dropoff.vehicleReturnPoint)}</small>
      </div>
      <div class="rental-details">
        <div class="rental-car">${escapeHtml(rental.company)} · ${escapeHtml(vehicle.example)}</div>
        <div class="rental-sub">${escapeHtml(vehicle.class)} · ${rental.unlimitedKilometers ? "无限里程" : "里程条款见订单"}</div>
        <div class="rental-stops">
          <div class="rental-stop">
            <span class="rental-stop__label">PICK UP</span>
            <div><b>${formatCompactDate(rental.pickup.date)} ${escapeHtml(rental.pickup.time)}</b><span>${escapeHtml(rental.pickup.location)}<br>${escapeHtml(rental.pickup.address)}</span></div>
          </div>
          <div class="rental-stop">
            <span class="rental-stop__label">RETURN</span>
            <div><b>${formatCompactDate(rental.dropoff.date)} ${escapeHtml(rental.dropoff.time)}</b><span>${escapeHtml(rental.dropoff.vehicleReturnPoint)}<br>建议 ${escapeHtml(rental.dropoff.recommendedArrivalTime)} 抵达机场区域</span></div>
          </div>
        </div>
        <div class="rental-price"><span>柜台支付 · ${rental.rentalPeriodDays} 天</span><strong>${escapeHtml(price.currency)} ${Number(price.payAtCounter).toFixed(2)}</strong></div>
      </div>
    </article>
  `;
  const insurance = (rental.insurance || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const panels = {
    checklist: transport.rentalChecklist.map((rule) => `<li>${escapeHtml(rule)}</li>`).join(""),
    insurance,
    driving: `${(transport.drivingNotes || []).map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}${(transport.drivingReferenceLinks || []).map((link) => `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ↗</a></li>`).join("")}`
  };
  const notes = $("#drive-notes");
  notes.innerHTML = `
    <div class="drive-note-tabs" role="group" aria-label="自驾注意事项">
      <button type="button" aria-expanded="true" aria-controls="drive-note-content" data-drive-note="checklist">取还车检查</button>
      <button type="button" aria-expanded="false" aria-controls="drive-note-content" data-drive-note="insurance">订单保障</button>
      <button type="button" aria-expanded="false" aria-controls="drive-note-content" data-drive-note="driving">驾驶提醒</button>
    </div>
    <div class="drive-note-panel" id="drive-note-content"><ul>${panels.checklist}</ul></div>`;
  notes.onclick = (event) => {
    const button = event.target.closest("button[data-drive-note]");
    if (!button) return;
    const collapse = button.getAttribute("aria-expanded") === "true";
    $$("button[data-drive-note]", notes).forEach((item) => item.setAttribute("aria-expanded", String(item === button && !collapse)));
    const panel = $(".drive-note-panel", notes);
    panel.hidden = collapse;
    if (!collapse) panel.innerHTML = `<ul>${panels[button.dataset.driveNote]}</ul>`;
  };
}

function updateRentalCountdown() {
  const dropoff = state.data.groundTransport.rentalCar.dropoff;
  const deadline = new Date(`${dropoff.date}T${dropoff.time}:00${dropoff.utcOffset}`);
  const remaining = deadline.getTime() - Date.now();
  $("#return-deadline-timer").textContent = remaining > 0
    ? `距还车截止 ${preciseCountdownText(deadline)}`
    : "预约还车时间已过 · 如尚未还车，请立即联系租车公司";
  $(".return-deadline").classList.toggle("is-urgent", remaining <= 86400000);
  const panel = $("#rental-countdown");
  if (!panel) return;
  const status = rentalStatus(state.data.groundTransport.rentalCar);
  $("span", panel).textContent = status.label;
  $("strong", panel).textContent = status.complete ? `请立即联系 ${state.data.groundTransport.rentalCar.company}` : countdownText(status.target);
}

function loadTodoState() { state.todos = []; }

function createRuntimeAdapters() {
  const storage = window.TravelRuntimeStorage;
  if (!storage?.createAdapter) throw new Error("runtime-storage.js is required");
  const persistence = state.config.persistence || { mode: "local" };
  const sharedCollections = new Set(Array.isArray(persistence.sharedCollections)
    ? persistence.sharedCollections
    : ["todos", "tickets", "ledger"]);
  const tripId = state.data.metadata.tripId;
  const enabledCollections = ["todos", ...(moduleEnabled("itinerary") ? ["tickets"] : [])];
  const localCollections = enabledCollections.filter((collection) => persistence.mode !== "d1" || !sharedCollections.has(collection));
  const d1Collections = enabledCollections.filter((collection) => persistence.mode === "d1" && sharedCollections.has(collection));
  const localAdapter = localCollections.length ? storage.createAdapter({ mode: "local", tripId, collections: localCollections }) : null;
  const d1Adapter = d1Collections.length ? storage.createAdapter({
    mode: "d1",
    tripId,
    apiBase: persistence.apiBase || "/api/trip",
    collections: d1Collections
  }) : null;
  state.runtimeAdapters = {};
  localCollections.forEach((collection) => { state.runtimeAdapters[collection] = localAdapter; });
  d1Collections.forEach((collection) => { state.runtimeAdapters[collection] = d1Adapter; });
}

async function loadSharedState() {
  const adapters = [...new Set(Object.values(state.runtimeAdapters).filter(Boolean))];
  const todoAdapter = state.runtimeAdapters.todos;
  let hasLocalTodoSnapshot = true;
  if (todoAdapter?.mode === "local" && todoAdapter.storageKey) {
    try { hasLocalTodoSnapshot = localStorage.getItem(todoAdapter.storageKey) !== null; }
    catch { hasLocalTodoSnapshot = false; }
  }
  const snapshots = await Promise.all(adapters.map(async (adapter) => [adapter, await adapter.load()]));
  const snapshotFor = (collection) => snapshots.find(([adapter]) => adapter === state.runtimeAdapters[collection])?.[1] || {};
  const todoSnapshot = snapshotFor("todos");
  const ticketSnapshot = snapshotFor("tickets");
  state.todos = Array.isArray(todoSnapshot.todos) ? todoSnapshot.todos : [];
  state.purchasedTickets = new Set((Array.isArray(ticketSnapshot.tickets) ? ticketSnapshot.tickets : []).filter((item) => item.completed).map((item) => item.id));
  const authoredTodos = state.data.preTrip?.todoItems || state.data.preTrip?.packingItems || [];
  if (moduleEnabled("todo") && todoAdapter?.mode === "local" && !hasLocalTodoSnapshot && !state.todos.length && authoredTodos.length) {
    state.todos = authoredTodos.map((item, index) => ({
      id: String(item.id || `todo-initial-${index + 1}`),
      text: String(item.text || item.title || "").trim(),
      completed: Boolean(item.completed)
    })).filter((item) => item.text);
    await Promise.all(state.todos.map((todo) => todoAdapter.applyChange("todos", todo, "upsert")));
  }
}

async function saveSharedChange(collection, value, op = "upsert") {
  const adapter = state.runtimeAdapters[collection];
  if (!adapter) return null;
  return adapter.applyChange(collection, value, op);
}

async function saveTodosBatch(todos) {
  const adapter = state.runtimeAdapters.todos;
  if (!adapter) throw new Error("To Do 本地存储未启用。");
  const snapshot = await adapter.load();
  snapshot.todos = JSON.parse(JSON.stringify(todos));
  await adapter.save(snapshot);
}

function saveTodoState() { return saveTodosBatch(state.todos); }

function renderTodoList() {
  const completed = state.todos.filter((todo) => todo.completed).length;
  $("#todo-progress").textContent = `${completed} / ${state.todos.length}`;
  $("#todo-list").innerHTML = state.todos.length ? state.todos.map((todo) => `
    <div class="todo-item${todo.completed ? " is-complete" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <label>
        <input type="checkbox" ${todo.completed ? "checked" : ""} aria-label="完成：${escapeHtml(todo.text)}">
        <span class="todo-check" aria-hidden="true">✓</span>
        <span class="todo-text">${escapeHtml(todo.text)}</span>
      </label>
      <small class="todo-category">${escapeHtml(state.todoCategories.find((item) => item.id === todo.categoryId)?.name || "Other")}</small>
      <div class="todo-actions"><button type="button" class="todo-edit" aria-label="编辑：${escapeHtml(todo.text)}">编辑</button>
      <button type="button" class="todo-delete" aria-label="删除：${escapeHtml(todo.text)}">删除</button>
      </div>
      <form class="todo-edit-form" hidden>
        <input name="text" type="text" maxlength="80" value="${escapeHtml(todo.text)}" aria-label="任务内容">
        <select name="categoryId" aria-label="任务分类">${state.todoCategories.map((category) => `<option value="${escapeHtml(category.id)}" ${category.id === todo.categoryId ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select>
        <button type="submit">保存</button><button type="button" class="todo-edit-cancel">取消</button>
      </form>
    </div>`).join("") : `<p class="todo-empty">还没有准备事项，添加第一项吧。</p>`;
}

function renderTravelPrep() {
  renderTodoList();
  $("#todo-category-select").innerHTML = state.todoCategories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join("");
  $("#todo-category-manage").onclick = () => window.TravelContentEditor?.openTab("todoCategories");
  const setTodoStatus = (message, error = false) => {
    const node = $("#todo-status");
    node.textContent = message;
    node.classList.toggle("is-error", error);
  };
  $("#todo-form").onsubmit = async (event) => {
    event.preventDefault();
    const input = $("#todo-input");
    const text = input.value.trim();
    if (!text) return;
    const next = [...state.todos, { id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, categoryId: $("#todo-category-select").value || "other", completed: false }];
    try { await saveTodosBatch(next); state.todos = next; input.value = ""; }
    catch (error) { setTodoStatus(`任务保存失败，内容仍保留在输入框中：${error.message || "本地存储不可用"}`, true); return; }
    setTodoStatus("任务已保存。");
    renderTodoList();
  };
  $("#todo-list").onchange = async (event) => {
    const item = event.target.closest("[data-todo-id]");
    if (!item || !event.target.matches("input[type='checkbox']")) return;
    const next = state.todos.map((todo) => todo.id === item.dataset.todoId ? { ...todo, completed: event.target.checked } : todo);
    try { await saveTodosBatch(next); state.todos = next; }
    catch (error) { event.target.checked = !event.target.checked; setTodoStatus(`完成状态保存失败：${error.message || "本地存储不可用"}`, true); return; }
    renderTodoList();
  };
  $("#todo-list").onsubmit = async (event) => {
    const form = event.target.closest(".todo-edit-form");
    if (!form) return;
    event.preventDefault();
    const item = form.closest("[data-todo-id]");
    const values = new FormData(form);
    const text = String(values.get("text") || "").trim();
    if (!text) { form.elements.text.focus(); return; }
    const next = state.todos.map((todo) => todo.id === item.dataset.todoId ? { ...todo, text, categoryId: String(values.get("categoryId") || todo.categoryId) } : todo);
    try { await saveTodosBatch(next); state.todos = next; renderTodoList(); }
    catch (error) { setTodoStatus(`任务保存失败：${error.message || "本地存储不可用"}`, true); }
  };
  $("#todo-list").onclick = async (event) => {
    if (event.target.closest(".todo-edit-cancel")) { renderTodoList(); return; }
    if (event.target.closest(".todo-edit")) {
      const item = event.target.closest("[data-todo-id]");
      item.querySelector(".todo-edit-form").hidden = false;
      item.classList.add("is-editing");
      item.querySelector(".todo-edit-form input").focus({ preventScroll: true });
      return;
    }
    const button = event.target.closest(".todo-delete");
    if (!button) return;
    const item = button.closest("[data-todo-id]");
    const todo = state.todos.find((entry) => entry.id === item.dataset.todoId);
    if (!confirm(`确定删除任务“${todo?.text || ""}”吗？`)) return;
    const next = state.todos.filter((entry) => entry.id !== item.dataset.todoId);
    try { await saveTodosBatch(next); state.todos = next; }
    catch (error) { setTodoStatus(`任务删除失败：${error.message || "本地存储不可用"}`, true); return; }
    setTodoStatus("任务已删除。");
    renderTodoList();
  };
}

function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function safeMapUrl(value, provider = "google") {
  return window.TravelPhase3?.allowedMapUrl(value, provider) ? new URL(value).href : "";
}

function localAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin ? url.href : "";
  } catch {
    return "";
  }
}

let ticketDialogOpener = null;

function openTicketDialog(ticketId, opener) {
  const ticket = state.data.ticketPlanning?.items?.find((item) => item.id === ticketId);
  const dialog = $("#ticket-dialog");
  if (!ticket || !dialog) return;
  ticketDialogOpener = opener || null;
  $("#ticket-dialog-title").textContent = ticketTitle(ticket);
  const document = ticketDocument(ticket);
  const localDocument = localAssetUrl(document?.url);
  const externalDocument = !localDocument ? safeExternalUrl(document?.url) : "";
  const officialUrl = safeExternalUrl(ticket.officialUrl || ticket.booking?.officialUrl || ticket.booking?.purchaseUrl);
  const extension = localDocument.split(/[?#]/)[0].split(".").at(-1)?.toLocaleLowerCase();
  let preview = "";
  if (localDocument && ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) {
    preview = `<img class="ticket-dialog__preview" src="${escapeHtml(localDocument)}" alt="${escapeHtml(ticketTitle(ticket))}">`;
  } else if (localDocument) {
    preview = `<iframe class="ticket-dialog__preview" src="${escapeHtml(localDocument)}" title="${escapeHtml(ticketTitle(ticket))}" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
  }
  const links = [
    localDocument ? `<a href="${escapeHtml(localDocument)}" target="_blank" rel="noopener noreferrer">在新窗口打开票据 ↗</a>` : "",
    externalDocument ? `<a href="${escapeHtml(externalDocument)}" target="_blank" rel="noopener noreferrer">${escapeHtml(document?.label || "查看票据")} ↗</a>` : "",
    officialUrl ? `<a href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">打开官方页面 ↗</a>` : ""
  ].filter(Boolean).join("");
  $("#ticket-dialog-body").innerHTML = `
    <p class="ticket-dialog__status">${escapeHtml(isTicketPurchased(ticket) ? "已标记购票" : ticketRequirement(ticket))}</p>
    ${ticketGuidance(ticket) ? `<p class="ticket-dialog__guidance">${escapeHtml(ticketGuidance(ticket))}</p>` : ""}
    ${preview || (!links ? `<p class="ticket-dialog__empty">当前没有可预览的票据文件或官方链接。</p>` : "")}
    ${links ? `<div class="ticket-dialog__links">${links}</div>` : ""}
    <button type="button" class="schedule-map-link" data-ticket-attachments="${escapeHtml(ticket.id)}">管理本地附件 / 二维码</button>`;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("#ticket-dialog-close").focus();
}

function setupTicketDialog() {
  const dialog = $("#ticket-dialog");
  if (!dialog) return;
  const close = () => {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  };
  $("#ticket-dialog-close").onclick = close;
  dialog.addEventListener("click", (event) => {
    const attachmentButton = event.target.closest("[data-ticket-attachments]");
    if (attachmentButton) {
      const ticket = state.data.ticketPlanning?.items?.find((item) => item.id === attachmentButton.dataset.ticketAttachments);
      if (ticket) openTransportDetail({ transportId: `ticket:${ticket.id}`, sourceType: "ticket", sourceId: ticket.id, type: "other", title: ticketTitle(ticket), transport: { type: "other", from: ticketTitle(ticket), date: ticket.date || "", note: ticketGuidance(ticket) }, attachmentOnly: true });
      return;
    }
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    const body = $("#ticket-dialog-body");
    if (!body.querySelector(".ticket-dialog__preview--pdf")) body.replaceChildren();
    ticketDialogOpener?.focus({ preventScroll: true });
    ticketDialogOpener = null;
  });
}

function setupPlaceMap() {
  const panel = $("#place-map");
  const frame = $("#place-map-frame");
  let opener;
  let previousOverflow = "";
  const close = () => {
    panel.hidden = true;
    frame.src = "about:blank";
    frame.hidden = false;
    $("#place-map-provider-note").hidden = true;
    document.body.style.overflow = previousOverflow;
    opener?.focus();
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest("button[data-map-query]");
    if (!link) return;
    event.preventDefault();
    opener = link;
    $("#place-map-title").textContent = link.dataset.mapLabel;
    const provider = link.dataset.mapProvider || "google";
    const providerLabel = window.TravelPhase3?.PROVIDERS?.[provider] || "Google Maps";
    $("#place-map-external").href = safeMapUrl(link.dataset.mapUrl, provider) || window.TravelPhase3?.placeUrl(provider, { label: link.dataset.mapLabel, query: link.dataset.mapQuery }) || (provider === "google" ? mapsSearch(link.dataset.mapQuery) : "#");
    $("#place-map-external").textContent = `打开 ${providerLabel} ↗`;
    frame.title = `${link.dataset.mapLabel} ${providerLabel}`;
    frame.src = "about:blank";
    frame.hidden = true;
    const note = $("#place-map-provider-note");
    note.hidden = false;
    note.textContent = `点击下方按钮后，当前地点才会发送给 ${providerLabel}。`;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.hidden = false;
    $("#place-map-close").focus();
  });
  $("#place-map-close").onclick = close;
  panel.addEventListener("click", (event) => { if (event.target === panel) close(); });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const first = $("#place-map-close");
      const last = $("#place-map-external");
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}

function startCountdowns() {
  if (moduleEnabled("flights")) updateFlightCountdowns();
  if (moduleEnabled("driving")) updateRentalCountdown();
  if (!moduleEnabled("flights") && !moduleEnabled("driving")) return;
  state.countdownTimer = window.setInterval(() => {
    if (moduleEnabled("flights")) updateFlightCountdowns();
    if (moduleEnabled("driving")) updateRentalCountdown();
  }, 1000);
}

function preloadDefaultRouteMap() {
  const routeMap = state.data?.routeMap;
  const source = travelMapSource(routeMap, routeMap?.defaultRegionId);
  if (!source?.baseImage) return;
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = "high";
  image.src = source.baseImage;
  state.routeMapPreload = image;
}

async function init() {
  try {
    const response = await fetch("trip-data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.config = normalizeTripConfig(state.data.config);
    window.TRAVEL_PLAN_CONFIG = state.config;
    window.TRAVEL_PLAN_DATA = state.data;
    document.dispatchEvent(new CustomEvent("travel-data-ready", { detail: state.data }));
    applyModuleConfig();
    if (moduleEnabled("overview")) preloadDefaultRouteMap();
    renderHero();
    if (moduleEnabled("flights")) renderFlights();
    if (moduleEnabled("overview")) setupRouteExplorer();
    if (moduleEnabled("itinerary")) {
      setupPlaceMap();
      setupTicketDialog();
    }
    createRuntimeAdapters();
    try {
      await loadSharedState();
    } catch (error) {
      console.error(`${state.config.persistence.mode === "d1" ? "Shared" : "Local"} runtime data could not be loaded`, error);
      state.todos = [];
      state.purchasedTickets = new Set();
    }
    if (window.TravelContentEditor) {
      const content = await window.TravelContentEditor.init({
        data: state.data,
        cloudStorage: state.config.persistence.mode === "d1",
        enabled: state.config.modules,
        getTodos: () => state.todos,
        setTodos: (todos) => { state.todos = todos; },
        onCategoriesChanged: (categories) => { state.todoCategories = categories; },
        saveTodos: saveTodosBatch,
        renderTodos: renderTravelPrep,
        onDataChanged: () => {
          if (moduleEnabled("itinerary")) renderTimeline();
          renderFlights();
          renderHero();
          renderTravelContentDisplay();
        }
      });
      setupTransportDetailDialog();
      setupConnectionDialog();
      renderFlights();
      state.todoCategories = content?.todoCategories || window.TravelContentStore.DEFAULT_CATEGORIES.map(([id, name]) => ({ id, name }));
      const normalizedTodos = window.TravelContentStore.normalizeTodos(state.todos, state.todoCategories);
      if (normalizedTodos.some((todo, index) => todo.categoryId !== state.todos[index]?.categoryId)) {
        try { await saveTodosBatch(normalizedTodos); state.todos = normalizedTodos; }
        catch (error) {
          console.error("Legacy todo categories could not be saved", error);
          const node = $("#todo-status");
          node.textContent = `旧任务分类兼容保存失败：${error.message || "本地存储不可用"}`;
          node.classList.add("is-error");
        }
      }
    }
    renderHero();
    if (moduleEnabled("itinerary")) renderTimeline();
    if (moduleEnabled("driving")) renderRental();
    if (moduleEnabled("todo")) renderTravelPrep();
    if (moduleEnabled("ledger")) {
      const persistence = state.config.persistence?.mode === "d1"
        ? { mode: "d1", sharedCollections: ["ledger"], apiBase: state.config.persistence.apiBase || "/api/trip" }
        : { mode: "local" };
      await window.TravelLedger?.init?.({ tripId: state.data.metadata.tripId, config: state.config, persistence });
      $("#ledger-root")?.addEventListener("travel-ledger:changed", () => { renderFlights(); renderTravelContentDisplay(); });
    }
    renderFlights();
    renderTravelContentDisplay();
    startCountdowns();
  } catch (error) {
    console.error("Travel data could not be loaded", error);
    $("#loading-error").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", init);
