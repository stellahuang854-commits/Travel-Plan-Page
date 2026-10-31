(() => {
  "use strict";

  const esc = (value = "") => String(value).replace(/[&<>\'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const transportTypes = window.TravelContentStore.TRANSPORT_TYPES.map((id) => [id, ({ "high-speed-rail": "High-speed rail", train: "Train", metro: "Metro", "bus-coach": "Bus/Coach", "ferry-boat": "Ferry/Boat", "taxi-ride-hailing": "Taxi/Ride-hailing", "rental-car-driving": "Rental car/Driving", flight: "Flight", walking: "Walking", bicycle: "Bicycle", other: "Other" })[id]]);
  let context = null;
  let content = null;
  let store = null;
  let activeTab = "accommodations";
  let selectedDayId = null;
  let editing = null;
  let editingValue = null;

  function status(message, error = false) {
    const node = document.querySelector("#travel-content-status");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("is-error", error);
  }

  function sourceFlights() {
    const data = context.data;
    const flights = Array.isArray(data.flights) ? data.flights : [];
    const journeys = Array.isArray(data.flightJourneys) ? data.flightJourneys : [];
    return (flights.length ? flights : journeys).map((flight, index) => ({
      id: String(flight.id || (flight.journeyId ? `${flight.journeyId}-segment-${flight.sequence || index + 1}` : `flight-${index + 1}`)),
      journeyId: String(flight.journeyId || ""),
      title: [flight.airline?.nameZh || flight.airline?.name, flight.flightNumber, flight.departure?.city, flight.arrival?.city].filter(Boolean).join(" · ") || `Flight ${index + 1}`,
      flightNumber: flight.flightNumber || "",
      date: flight.departure?.date || flight.date || "",
      from: flight.departure?.city || flight.departure?.airportCode || "",
      to: flight.arrival?.city || flight.arrival?.airportCode || "",
      startTime: flight.departure?.time || "",
      endTime: flight.arrival?.time || ""
    }));
  }

  function rentalSource() {
    const rental = context.data.groundTransport?.rentalCar;
    if (!rental || typeof rental !== "object") return null;
    return {
      id: "rentalCar",
      title: rental.company || rental.vehicle?.example || "Rental car/Driving",
      date: rental.pickup?.date || "",
      from: rental.pickup?.location || rental.pickup?.address || "",
      to: rental.dropoff?.vehicleReturnPoint || rental.dropoff?.location || "",
      startTime: rental.pickup?.time || "",
      endTime: rental.dropoff?.time || ""
    };
  }

  function formatTransport(record) {
    const source = record.sourceType === "flight"
      ? sourceFlights().find((item) => item.id === record.sourceId)
      : record.sourceType === "rental" ? rentalSource() : null;
    const type = transportTypes.find(([id]) => id === record.type)?.[1] || record.type || "Other";
    const ticketNames = (record.ticketIds || []).map((id) => context.data.ticketPlanning?.items?.find((ticket) => ticket.id === id)?.name || id).filter(Boolean);
    return [type, source?.title || "", record.date || source?.date, [record.from || source?.from, record.to || source?.to].filter(Boolean).join(" → "), [record.startTime || source?.startTime, record.endTime || source?.endTime].filter(Boolean).join("–"), ticketNames.length ? `门票：${ticketNames.join("、")}` : "", record.note].filter(Boolean);
  }

  function row(title, detail, id, editLabel = "编辑", showDelete = true) {
    return `<article class="travel-content-row" data-record-id="${esc(id)}"><div><strong>${esc(title || "未命名资料")}</strong><p>${esc(detail || "尚无详细信息")}</p></div><div class="travel-content-row__actions"><button type="button" data-edit="${esc(id)}">${editLabel}</button>${showDelete ? `<button type="button" class="travel-content-delete" data-delete="${esc(id)}">删除</button>` : ""}</div></article>`;
  }

  function collectionFor(tab) {
    return content[tab] || [];
  }

  function renderList() {
    const panel = document.querySelector("#travel-content-panel");
    if (!panel) return;
    editing = null;
    if (activeTab === "tripInfo") {
      panel.innerHTML = `<form class="travel-editor-form" data-trip-title-form><div class="travel-content-list__heading"><h3>旅行基本信息</h3></div><div class="travel-editor-fields">${field("旅行名称", "title", content.metadata?.title || "", "text", { required: true, maxlength: 120 })}${field("旅行开始日期", "startDate", content.metadata?.startDate || "", "date")}${field("旅行结束日期", "endDate", content.metadata?.endDate || "", "date")}</div><div class="travel-editor-actions"><button type="submit">保存旅行信息</button></div></form>`;
      return;
    }
    if (activeTab === "todoCategories") {
      panel.innerHTML = `<div class="travel-content-list"><div class="travel-content-list__heading"><h3>To Do 分类</h3><button type="button" data-category-add>新增分类</button></div>${content.todoCategories.map((category) => row(category.name, "可编辑；删除时可将已有任务移动到其他分类。", category.id)).join("") || `<p>还没有分类。</p>`}</div>`;
      return;
    }
    if (activeTab === "days" && selectedDayId) {
      renderScheduleList(panel);
      return;
    }
    let records = collectionFor(activeTab);
    let heading = ({ accommodations: "住宿", restaurants: "餐厅", transportRecords: "交通", days: "每日行程" })[activeTab] || "资料";
    if (activeTab === "transportRecords") records = transportList();
    const rows = records.map((record) => {
      const id = record.id;
      if (activeTab === "transportRecords") { const parts = formatTransport(record); return `<article class="travel-content-row" data-record-id="${esc(id)}"><div><strong>${esc(parts[0] || "交通")}</strong><p>${esc(parts.slice(1).join(" · ") || "尚无详细信息")}</p></div><div class="travel-content-row__actions"><button type="button" data-transport-detail="${esc(id)}">详情 / 凭证</button><button type="button" data-edit="${esc(id)}">${record.linked ? "关联" : "编辑"}</button>${record.linked ? "" : `<button type="button" class="travel-content-delete" data-delete="${esc(id)}">删除</button>`}</div></article>`; }
      if (activeTab === "days") return `<article class="travel-content-row" data-record-id="${esc(id)}"><div><strong>${esc(record.title || `第 ${record.day || "—"} 天`)}</strong><p>${esc([record.date, (record.locations || []).join(" → "), `${(record.schedule || []).length} 项安排`].filter(Boolean).join(" · "))}</p></div><div class="travel-content-row__actions"><button type="button" data-edit="${esc(id)}">编辑日期</button><button type="button" data-schedule="${esc(id)}">管理安排</button><button type="button" class="travel-content-delete" data-delete="${esc(id)}">删除</button></div></article>`;
      const title = activeTab === "accommodations" ? record.name : record.name;
      const detail = activeTab === "accommodations"
        ? [record.address, record.checkInDate || record.checkIn?.date, record.checkOutDate || record.checkOut?.date].filter(Boolean).join(" · ")
        : [record.address, record.date, record.reservationTime].filter(Boolean).join(" · ");
      return row(title, detail, id);
    }).join("");
    panel.innerHTML = `<div class="travel-content-list"><div class="travel-content-list__heading"><h3>${heading}</h3><button type="button" data-add>新增</button></div>${rows || `<p>还没有资料。你可以添加自己的内容。</p>`}</div>`;
  }

  function transportList() {
    const records = [...content.transportRecords];
    sourceFlights().forEach((flight) => {
      const id = `linked-flight-${flight.id}`;
      if (!records.some((record) => record.sourceType === "flight" && record.sourceId === flight.id)) {
        records.unshift({ id, type: "flight", sourceType: "flight", sourceId: flight.id, linked: true, ticketIds: [], dayIds: [] });
      }
    });
    const rental = rentalSource();
    if (rental && !records.some((record) => record.sourceType === "rental" && record.sourceId === "rentalCar")) {
      records.unshift({ id: "linked-rentalCar", type: "rental-car-driving", sourceType: "rental", sourceId: "rentalCar", linked: true, ticketIds: [], dayIds: [] });
    }
    return records;
  }

  function renderScheduleList(panel) {
    const day = content.days.find((item) => item.id === selectedDayId);
    if (!day) { selectedDayId = null; renderList(); return; }
    const rows = (day.schedule || []).map((item) => row(item.text || item.title, [item.time, item.endTime, item.location || item.placeName, item.note].filter(Boolean).join(" · "), item.id)).join("");
    panel.innerHTML = `<div class="travel-content-list"><div class="travel-content-list__heading"><h3>${esc(day.title || day.date || "每日安排")}</h3><div><button type="button" data-back-days>返回日期</button><button type="button" data-add>新增安排</button></div></div>${rows || `<p>这一天还没有安排。</p>`}</div>`;
  }

  function sourceFor(record) {
    if (record.sourceType === "flight") return sourceFlights().find((item) => item.id === record.sourceId);
    if (record.sourceType === "rental") return rentalSource();
    return null;
  }

  function transportsForDay(dayId) {
    return transportList().filter((item) => (item.dayIds || []).includes(dayId)).map((item) => ({
      id: item.id,
      time: item.startTime || item.date || sourceFor(item)?.startTime || sourceFor(item)?.date || "",
      text: formatTransport(item).join(" · "),
      transportId: item.id
    }));
  }

  function field(label, name, value = "", type = "text", options = {}) {
    const attributes = `${options.required ? " required" : ""}${options.maxlength ? ` maxlength="${options.maxlength}"` : ""}${options.inputmode ? ` inputmode="${options.inputmode}"` : ""}${options.step ? ` step="${esc(options.step)}"` : ""}`;
    return `<label class="travel-editor-field"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}"${attributes}></label>`;
  }

  function textarea(label, name, value = "", hint = "") {
    return `<label class="travel-editor-field"><span>${esc(label)}</span><textarea name="${esc(name)}" rows="3" placeholder="${esc(hint)}">${esc(value)}</textarea></label>`;
  }

  function selectField(label, name, options, value = "", multiple = false) {
    return `<label class="travel-editor-field"><span>${esc(label)}</span><select name="${esc(name)}"${multiple ? " multiple size=\"4\"" : ""}>${multiple ? "" : `<option value="">未关联</option>`}${options.map(([id, label]) => `<option value="${esc(id)}" ${multiple ? "" : id === value ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`;
  }

  function ticketOptions() {
    return (context.data.ticketPlanning?.items || []).map((item) => [String(item.id), item.name || item.attraction?.nameZh || item.attraction?.name || item.id]);
  }

  function dayOptions() { return content.days.map((day) => [day.id, `${day.date || "未设日期"} ${day.title || `第 ${day.day || "—"} 天`}`]); }

  function travelerOptions() { return window.TravelLedger?.getSnapshot?.()?.travelers || []; }

  function refreshTravelerSelectors(event) {
    if (!context || String(event?.detail?.tripId || "") !== String(context.data.metadata.tripId)) return;
    const travelers = travelerOptions();
    document.querySelectorAll('#travel-content-panel [data-journey-field="travelerIds"]').forEach((select) => {
      const selectedIds = new Set([...select.selectedOptions].map((option) => option.value));
      select.innerHTML = travelers.map((person) => `<option value="${esc(person.id)}"${selectedIds.has(String(person.id)) ? " selected" : ""}>${esc(person.name || "同行者")}</option>`).join("");
    });
    document.querySelectorAll("#travel-content-panel .travel-editor-hint").forEach((hint) => {
      if (hint.textContent.includes("尚无同行者名单")) hint.remove();
    });
    const fieldset = document.querySelector("#travel-content-panel .passenger-journey-editor");
    if (fieldset && !travelers.length && !fieldset.querySelector(".travel-editor-hint")) {
      fieldset.insertAdjacentHTML("beforeend", '<p class="travel-editor-hint">尚无同行者名单；可先在 AA 记账中添加同行者，再回此处选择。</p>');
    }
  }

  function passengerJourneyFieldset(journey = {}, index = 0) {
    const travelers = travelerOptions();
    const selectedIds = new Set(journey.travelerIds || []);
    const options = travelers.map((person) => `<option value="${esc(person.id)}"${selectedIds.has(String(person.id)) ? " selected" : ""}>${esc(person.name || "同行者")}</option>`).join("");
    const makeInput = (label, key, value = "", type = "text") => `<label class="travel-editor-field"><span>${label}</span><input data-journey-field="${key}" type="${type}" value="${esc(value)}"></label>`;
    const typeOptions = transportTypes.map(([id, label]) => `<option value="${esc(id)}"${id === (journey.type || "train") ? " selected" : ""}>${esc(label)}</option>`).join("");
    return `<fieldset class="passenger-journey-editor" data-passenger-journey-id="${esc(journey.id || "")}"><legend>乘客 / 班次 ${index + 1}</legend><div class="travel-editor-fields"><label class="travel-editor-field"><span>交通方式</span><select data-journey-field="type">${typeOptions}</select></label><label class="travel-editor-field"><span>同行者（可多选）</span><select data-journey-field="travelerIds" multiple size="3">${options}</select></label>${travelers.length ? "" : `<p class="travel-editor-hint">尚无同行者名单；可在 AA 记账中先添加同行者，再回此处选择。</p>`}${makeInput("其他乘客姓名（选填）", "passenger", journey.passenger || journey.passengerName || "")}${makeInput("航班号 / 车次 / 班次", "serviceNumber", journey.serviceNumber || journey.flightNumber || "")}${makeInput("出发地点 / 车站 / 机场", "from", journey.from || "")}${makeInput("到达地点 / 车站 / 机场", "to", journey.to || "")}${makeInput("出发日期", "date", journey.date || "", "date")}${makeInput("到达日期", "arrivalDate", journey.arrivalDate || journey.date || "", "date")}${makeInput("出发时间", "startTime", journey.startTime || "", "time")}${makeInput("到达时间", "endTime", journey.endTime || "", "time")}${makeInput("座位", "seat", journey.seat || "")}<label class="travel-editor-field"><span>备注</span><textarea data-journey-field="note" rows="2">${esc(journey.note || "")}</textarea></label></div><button type="button" data-remove-passenger-journey>删除此组</button></fieldset>`;
  }

  function readPassengerJourneys(form) {
    return [...form.querySelectorAll("[data-passenger-journey-id]")].map((fieldset) => {
      const value = (name) => fieldset.querySelector(`[data-journey-field="${name}"]`)?.value?.trim() || "";
      const select = fieldset.querySelector('[data-journey-field="travelerIds"]');
      const passenger = value("passenger");
      const id = fieldset.dataset.passengerJourneyId || idFor("passenger-journey");
      const previous = (editingValue?.passengerJourneys || []).find((journey) => journey.id === id) || {};
      return { ...copy(previous), id, travelerIds: select ? [...select.selectedOptions].map((option) => option.value) : [], type: value("type") || "other", passenger, passengerName: passenger, serviceNumber: value("serviceNumber"), from: value("from"), to: value("to"), date: value("date"), arrivalDate: value("arrivalDate"), startTime: value("startTime"), endTime: value("endTime"), seat: value("seat"), note: value("note"), ticketIds: previous.ticketIds || editingValue?.ticketIds || [] };
    });
  }

  function draftFromForm(form) {
    const draft = { ...(editingValue || {}) };
    for (const [key, value] of new FormData(form).entries()) {
      if (["dayIds", "ticketIds"].includes(key) || form.querySelector(`[data-journey-field][name="${key}"]`)) continue;
      draft[key] = String(value).trim();
    }
    draft.dayIds = form.elements.dayIds ? selectedValues(form.elements.dayIds) : draft.dayIds || [];
    draft.ticketIds = form.elements.ticketIds ? selectedValues(form.elements.ticketIds) : draft.ticketIds || [];
    draft.passengerJourneys = readPassengerJourneys(form);
    return draft;
  }

  function openForm(kind, record = null) {
    editing = { kind, id: record?.id || null };
    editingValue = record ? copy(record) : null;
    const isEditing = Boolean(record?.id);
    const fields = [];
    const existing = record || {};
    let title = "新增资料";
    if (kind === "accommodations") {
      title = isEditing ? "编辑住宿" : "新增住宿";
      fields.push(field("名称", "name", existing.name));
      fields.push(field("地址", "address", existing.address));
      fields.push(field("入住日期", "checkInDate", existing.checkInDate || existing.checkIn?.date, "date"));
      fields.push(field("退房日期", "checkOutDate", existing.checkOutDate || existing.checkOut?.date, "date"));
      fields.push(field("预订编号", "bookingReference", existing.bookingReference || existing.confirmationNumber));
      fields.push(field("联系方式", "contact", existing.contact || existing.phone));
      fields.push(field("预订凭证（链接或文件路径）", "documentUrl", existing.documentUrl || existing.bookingDocument?.url));
      fields.push(textarea("备注", "notes", existing.notes || existing.note));
    } else if (kind === "restaurants") {
      title = isEditing ? "编辑餐厅" : "新增餐厅";
      fields.push(field("名称", "name", existing.name)); fields.push(field("地址", "address", existing.address));
      fields.push(field("日期", "date", existing.date, "date")); fields.push(field("预约时间", "reservationTime", existing.reservationTime || existing.time, "time"));
      fields.push(field("预约人数", "partySize", existing.partySize, "number", { inputmode: "numeric" }));
      fields.push(field("联系方式", "contact", existing.contact || existing.phone)); fields.push(field("预订链接", "bookingUrl", existing.bookingUrl || existing.url, "url"));
      fields.push(textarea("备注", "notes", existing.notes || existing.note));
    } else if (kind === "days") {
      title = isEditing ? "编辑行程日期" : "新增行程日期";
      fields.push(field("日期", "date", existing.date, "date")); fields.push(field("标题", "title", existing.title));
      fields.push(textarea("地点（每行一个）", "locations", (existing.locations || []).join("\n")));
    } else if (kind === "schedule") {
      title = isEditing ? "编辑行程安排" : "新增行程安排";
      fields.push(field("开始时间", "time", existing.time, "time")); fields.push(field("结束时间", "endTime", existing.endTime, "time"));
      fields.push(field("活动名称", "text", existing.text || existing.title)); fields.push(field("地点", "location", existing.location || existing.placeName));
      fields.push(selectField("地图地点（可选）", "placeId", (context.data.places || []).map((place) => [place.id, place.nameZh || place.name || place.id]), existing.placeId || ""));
      fields.push(selectField("地图导航服务", "mapProvider", [["google", "Google Maps"], ["apple", "Apple Maps"], ["openstreetmap", "OpenStreetMap"], ["amap", "高德地图 Amap"]], existing.mapProvider || "google"));
      fields.push(`<p class="travel-editor-hint">仅点击地图入口时，当前地点会发送到此处选择的服务；不会后台发送或上传其他行程资料。高德路线需要 GCJ-02 坐标。</p>`);
      fields.push(field("纬度（选填）", "locationLatitude", existing.locationLatitude ?? existing.geo?.lat ?? "", "number"));
      fields.push(field("经度（选填）", "locationLongitude", existing.locationLongitude ?? existing.geo?.lng ?? "", "number", { step: "any" }));
      fields[fields.length - 2] = field("纬度（选填）", "locationLatitude", existing.locationLatitude ?? existing.geo?.lat ?? "", "number", { step: "any" });
      const coordinateSystem = String(existing.coordinateSystem || existing.geo?.system || "wgs84").toLowerCase().replace(/[-_\s]/g, "");
      fields.push(selectField("坐标系", "coordinateSystem", [["wgs84", "WGS-84"], ["gcj02", "GCJ-02（高德）"]], coordinateSystem === "gcj02" ? "gcj02" : "wgs84"));
      fields.push(textarea("详细说明", "details", existing.details || existing.description)); fields.push(textarea("备注", "note", existing.note));
      fields.push(selectField("相关门票", "ticketIds", ticketOptions(), "", true));
      fields.push(textarea("相关文件链接（每行一个）", "documentUrls", (existing.documentUrls || []).map((item) => typeof item === "string" ? item : item.url).join("\n")));
      fields.push(selectField("关联交通", "transportIds", transportList().map((item) => [item.id, formatTransport(item).join(" · ")]), "", true));
    } else if (kind === "transportRecords") {
      title = isEditing ? "编辑交通" : "新增交通";
      const linked = Boolean(existing.sourceType);
      const typeValue = existing.type || "train";
      fields.push(selectField("交通方式", "type", transportTypes, typeValue));
      const role = window.TravelContentStore.journeyRoleFor(existing);
      fields.push(selectField("首页行程方向", "journeyRole", [["outbound", "去程"], ["return", "回程"], ["other", "行程中交通 / 其他"]], role || (record ? "" : "other")));
      fields.push(`<p class="travel-editor-hint">只有明确选择“去程”或“回程”的资料会显示在首页顶部；未分类的旧资料不会被自动判断。</p>`);
      if (typeValue === "flight") {
        const mode = existing.sourceType === "flight" ? "linked" : "new";
        fields.push(selectField("航班资料", "flightSourceMode", [["linked", "关联原有航班"], ["new", "新增航班记录"]], existing.flightSourceMode || mode));
        if ((existing.flightSourceMode || mode) === "linked") {
          fields.push(selectField("选择原有航班", "sourceId", sourceFlights().map((flight) => [flight.id, flight.title]), existing.sourceId || ""));
          fields.push(`<p class="travel-editor-hint">关联后沿用原始航班路线与时间，不复制原始航班记录。</p>`);
        } else {
          fields.push(field("航空公司", "airline", existing.airline || ""));
          fields.push(field("出发机场", "from", existing.from || "")); fields.push(field("到达机场", "to", existing.to || ""));
          fields.push(field("出发日期", "date", existing.date || "", "date")); fields.push(field("到达日期", "arrivalDate", existing.arrivalDate || existing.date || "", "date"));
          fields.push(field("出发时间", "startTime", existing.startTime || "", "time")); fields.push(field("到达时间", "endTime", existing.endTime || "", "time"));
          fields.push(field("航班号", "flightNumber", existing.flightNumber || ""));
        }
        fields.push(field("行李信息", "baggage", existing.baggage || "")); fields.push(field("航站楼", "terminal", existing.terminal || ""));
        fields.push(field("登机口", "gate", existing.gate || "")); fields.push(field("登机时间", "boardingTime", existing.boardingTime || "", "time"));
        fields.push(textarea("备注", "note", existing.note));
      } else if (typeValue === "rental-car-driving") {
        fields.push(`<p class="travel-editor-hint">租车详情继续使用原有租车资料；此处只建立每日行程和门票的关联，不复制航班或租车信息。</p>`);
        fields.push(`<input type="hidden" name="sourceId" value="rentalCar">`);
      } else {
        fields.push(field("出发日期", "date", existing.date, "date")); fields.push(field("到达日期", "arrivalDate", existing.arrivalDate || existing.date, "date"));
        fields.push(field("出发地点", "from", existing.from)); fields.push(field("到达地点", "to", existing.to));
        fields.push(field("出发时间", "startTime", existing.startTime, "time")); fields.push(field("到达时间", "endTime", existing.endTime, "time"));
        fields.push(field("车次 / 票号", "serviceNumber", existing.serviceNumber || existing.flightNumber || ""));
        fields.push(field("行李信息", "baggage", existing.baggage || ""));
      }
      fields.push(selectField("关联每日行程", "dayIds", dayOptions(), "", true));
      fields.push(selectField("相关门票", "ticketIds", ticketOptions(), "", true)); fields.push(textarea("备注", "note", existing.note));
      const source = sourceFor(existing);
      const normalized = window.TravelContentStore.normalizePassengerJourneys(existing, { ensureOne: true });
      const journeys = Array.isArray(existing.passengerJourneys) ? normalized : normalized.length ? normalized : [{ id: idFor("passenger-journey"), type: typeValue, ...(source || {}) }];
      if (!record?.id && !Array.isArray(record?.passengerJourneys) && journeys.length === 1) journeys[0].id = idFor("passenger-journey");
      fields.push(`<section class="passenger-journeys-editor"><h4>同行者班次</h4><p class="travel-editor-hint">多人乘坐同一班次可放在一组；不同班次请分别添加。</p><div data-passenger-journeys>${journeys.map(passengerJourneyFieldset).join("")}</div><button type="button" data-add-passenger-journey>＋ 添加另一组乘客 / 班次</button></section>`);
      if (linked) fields.push(`<p class="travel-editor-hint">关联的原始航班或租车资料不会被复制或覆盖。</p>`);
    }
    const panel = document.querySelector("#travel-content-panel");
    panel.innerHTML = `<form class="travel-editor-form" data-editor-form="${esc(kind)}"><div class="travel-content-list__heading"><h3>${title}</h3><button type="button" data-cancel-form>返回</button></div><div class="travel-editor-fields">${fields.join("")}</div><div class="travel-editor-actions"><button type="submit">保存</button><button type="button" data-cancel-form>取消</button></div></form>`;
    if (record && kind === "schedule") {
      const form = panel.querySelector("form");
      setMulti(form.elements.ticketIds, existing.ticketIds || []);
      setMulti(form.elements.transportIds, existing.transportIds || []);
    }
    if (record && kind === "transportRecords") {
      const form = panel.querySelector("form");
      setMulti(form.elements.dayIds, existing.dayIds || []); setMulti(form.elements.ticketIds, existing.ticketIds || []);
    }
    panel.querySelector("input,select,textarea")?.focus({ preventScroll: true });
  }

  function setMulti(select, values) { if (select) [...select.options].forEach((option) => { option.selected = values.includes(option.value); }); }
  function selectedValues(select) { return select ? [...select.selectedOptions].map((option) => option.value) : []; }

  function appendPassengerJourney(form) {
    const host = form?.querySelector("[data-passenger-journeys]");
    if (!host) throw new Error("找不到乘客班次列表，请关闭并重新打开交通编辑器。");
    const index = host.querySelectorAll("[data-passenger-journey-id]").length;
    const type = String(form.elements.type?.value || "other");
    const journey = { id: idFor("passenger-journey"), travelerIds: [], type, ticketIds: [] };
    host.insertAdjacentHTML("beforeend", passengerJourneyFieldset(journey, index));
    const rows = host.querySelectorAll("[data-passenger-journey-id]");
    const added = rows[rows.length - 1];
    added?.querySelector('[data-journey-field="travelerIds"]')?.focus({ preventScroll: true });
    return journey.id;
  }

  function handlePassengerJourneyClick(event) {
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const addJourney = target?.closest?.("[data-add-passenger-journey]");
    if (!addJourney) return;
    event.preventDefault();
    const form = addJourney.closest('form[data-editor-form="transportRecords"]');
    if (!form) { status("找不到交通编辑表单，请重新打开交通资料。", true); return; }
    try { appendPassengerJourney(form); }
    catch (error) { status(error.message || "无法添加乘客班次。", true); }
  }

  async function commit(mutator, successMessage) {
    try {
      const candidate = copy(content);
      mutator(candidate);
      const saved = await store.save(candidate);
      const categoriesChanged = JSON.stringify(content.todoCategories) !== JSON.stringify(saved.todoCategories);
      content = saved;
      applyToPage();
      if (categoriesChanged) { context.onCategoriesChanged?.(copy(content.todoCategories)); context.renderTodos?.(); }
      status(successMessage);
      return true;
    } catch (error) {
      status(error.message || "保存失败，请重试。", true);
      return false;
    }
  }

  function applyToPage() {
    context.data.metadata = context.data.metadata || {};
    context.data.metadata.title = content.metadata?.title || "";
    context.data.trip = context.data.trip || {};
    context.data.trip.startDate = content.metadata?.startDate || null;
    context.data.trip.endDate = content.metadata?.endDate || null;
    context.data.accommodations = copy(content.accommodations);
    context.data.restaurants = copy(content.restaurants);
    context.data.days = copy(content.days);
    window.TRAVEL_CONTENT = copy(content);
    context.onDataChanged?.(context.data);
  }

  function idFor(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

  async function saveForm(form) {
    const kind = form.dataset.editorForm;
    const data = new FormData(form);
    const current = editing?.id ? (editingValue || content[kind === "schedule" ? "days" : kind].flatMap((item) => kind === "schedule" ? item.schedule || [] : [item]).find((item) => item.id === editing.id)) : null;
    const removedPassengerJourneyIds = kind === "transportRecords" && Array.isArray(current?.removedPassengerJourneyIds) ? [...current.removedPassengerJourneyIds] : [];
    const record = { ...(current || {}), id: current?.id || idFor(kind === "accommodations" ? "stay" : kind === "restaurants" ? "restaurant" : kind === "days" ? "day" : kind === "schedule" ? "item" : "transport") };
    delete record.removedPassengerJourneyIds;
    for (const [key, value] of data.entries()) {
      if (["ticketIds", "transportIds", "dayIds"].includes(key)) continue;
      if (key === "locations" || key === "documentUrls") record[key] = String(value).split("\n").map((item) => item.trim()).filter(Boolean);
      else if (key === "partySize") record[key] = value ? Number(value) : "";
      else if (key === "locationLatitude" || key === "locationLongitude") record[key] = value === "" ? "" : Number(value);
      else if (key === "sourceId") record.sourceId = String(value);
      else record[key] = String(value).trim();
    }
    if (form.elements.ticketIds) record.ticketIds = selectedValues(form.elements.ticketIds);
    if (form.elements.transportIds) record.transportIds = selectedValues(form.elements.transportIds);
    if (form.elements.dayIds) record.dayIds = selectedValues(form.elements.dayIds);
    if (kind === "transportRecords") {
      record.passengerJourneys = readPassengerJourneys(form);
      record.type = String(data.get("type") || "other");
      const journeyRole = window.TravelContentStore.normalizeJourneyRole(data.get("journeyRole"));
      if (journeyRole) record.journeyRole = journeyRole;
      else delete record.journeyRole;
      delete record.direction;
      if (record.type === "flight" && String(data.get("flightSourceMode")) === "linked") {
        record.sourceType = "flight";
        if (!sourceFlights().some((flight) => flight.id === record.sourceId)) { status("请选择可关联的原有航班，或改为新增航班记录。", true); return; }
        delete record.flightSourceMode; delete record.date; delete record.arrivalDate; delete record.from; delete record.to; delete record.startTime; delete record.endTime; delete record.flightNumber; delete record.airline;
      } else if (record.type === "flight") {
        delete record.sourceType; delete record.sourceId; delete record.flightSourceMode;
        const duplicateSource = sourceFlights().some((flight) => flight.flightNumber && record.flightNumber && flight.flightNumber.toLocaleLowerCase() === record.flightNumber.toLocaleLowerCase() && flight.date && flight.date === record.date);
        const duplicateCustom = content.transportRecords.some((item) => item.id !== record.id && item.type === "flight" && !item.sourceType && item.flightNumber && record.flightNumber && item.flightNumber.toLocaleLowerCase() === record.flightNumber.toLocaleLowerCase() && item.date === record.date);
        if (duplicateSource || duplicateCustom) { status("已存在相同日期和航班号的记录，请关联原航班或编辑已有记录。", true); return; }
      }
      else if (record.type === "rental-car-driving") {
        record.sourceType = "rental";
        if (!rentalSource()) { status("没有可关联的原有租车资料；此处不会创建重复租车记录。", true); return; }
        delete record.date; delete record.from; delete record.to; delete record.startTime; delete record.endTime;
      }
      else { delete record.sourceType; delete record.sourceId; }
      if (record.sourceType) {
        const duplicate = content.transportRecords.find((item) => item.sourceType === record.sourceType && item.sourceId === record.sourceId);
        if (duplicate) record.id = duplicate.id;
      }
    }
    if (kind === "schedule") { record.type = record.type || "activity"; record.title = record.text; }
    if (kind === "days") {
      record.schedule = Array.isArray(record.schedule) ? record.schedule : [];
      record.locations = Array.isArray(record.locations) ? record.locations : [];
      if (!record.day) record.day = Math.max(0, ...content.days.map((day) => Number(day.day) || 0)) + 1;
    }
    const ok = await commit((next) => {
      if (kind === "schedule") {
        const day = next.days.find((item) => item.id === selectedDayId);
        if (!day) throw new Error("找不到对应日期。");
        day.schedule = Array.isArray(day.schedule) ? day.schedule : [];
        const index = day.schedule.findIndex((item) => item.id === record.id);
        const oldTransportIds = index >= 0 ? day.schedule[index].transportIds || [] : [];
        if (index >= 0) day.schedule[index] = record; else day.schedule.push(record);
        const linked = new Set([...oldTransportIds, ...(record.transportIds || [])]);
        linked.forEach((transportId) => {
          let transport = next.transportRecords.find((item) => item.id === transportId);
          if (!transport) {
            const source = transportList().find((item) => item.id === transportId);
            if (source?.sourceType) {
              transport = { id: source.id, type: source.type, sourceType: source.sourceType, sourceId: source.sourceId, ticketIds: [], dayIds: [] };
              next.transportRecords.push(transport);
            }
          }
          if (!transport) return;
          const days = new Set(transport.dayIds || []);
          if ((record.transportIds || []).includes(transportId)) days.add(selectedDayId); else days.delete(selectedDayId);
          transport.dayIds = [...days];
        });
      } else {
        const list = next[kind];
        const index = list.findIndex((item) => item.id === record.id);
        if (index >= 0) list[index] = { ...list[index], ...record }; else list.push(record);
      }
    }, "资料已保存。");
    if (ok) {
      let cleanupFailed = false;
      for (const journeyId of removedPassengerJourneyIds) {
        try { await window.TravelAttachmentStore?.removeAll(context.data.metadata.tripId, window.TravelContentStore.passengerJourneyAttachmentKey(record.id, journeyId)); }
        catch { cleanupFailed = true; }
      }
      status(cleanupFailed ? "资料已保存，但部分已删除班次的附件未能清理。" : "资料已保存。");
      renderList();
    }
  }

  async function saveTripTitle(form) {
    const title = String(new FormData(form).get("title") || "").trim();
    if (!title) { status("请输入旅行名称。", true); form.elements.title?.focus(); return; }
    const startDate = String(new FormData(form).get("startDate") || "");
    const endDate = String(new FormData(form).get("endDate") || "");
    if (startDate && endDate && endDate < startDate) { status("旅行结束日期不能早于开始日期。", true); form.elements.endDate?.focus(); return; }
    const ok = await commit((next) => { next.metadata = { ...(next.metadata || {}), title, startDate, endDate }; }, "旅行信息已保存。");
    if (ok) renderList();
  }

  async function removePassengerJourney(button) {
    const form = button.form;
    const journeyId = button.closest("[data-passenger-journey-id]")?.dataset.passengerJourneyId;
    if (!form || !journeyId) return;
    if (form.querySelectorAll("[data-passenger-journey-id]").length <= 1) {
      status("至少保留一组乘客班次；如无需同行者资料，可清空这组字段。", true);
      return;
    }
    const draft = draftFromForm(form);
    if (editing?.id && window.TravelAttachmentStore) {
      try {
        const key = window.TravelContentStore.passengerJourneyAttachmentKey(editing.id, journeyId);
        const attachments = await window.TravelAttachmentStore.list(context.data.metadata.tripId, key);
        if (attachments.length && !window.confirm(`删除这组乘客班次时，也会删除其关联的 ${attachments.length} 份附件。继续吗？`)) return;
      } catch (error) { status(`无法检查班次附件，未删除此组：${error.message || "本地存储不可用"}`, true); return; }
    }
    draft.removedPassengerJourneyIds = [...new Set([...(draft.removedPassengerJourneyIds || []), journeyId])];
    draft.passengerJourneys = (draft.passengerJourneys || []).filter((journey) => journey.id !== journeyId);
    openForm("transportRecords", draft);
  }

  async function deleteRecord(id) {
    const collection = activeTab;
    if (collection === "days" && selectedDayId) {
      const day = content.days.find((item) => item.id === selectedDayId);
      const scheduleItem = day?.schedule?.find((item) => item.id === id);
      if (!scheduleItem) return;
      const linkedTickets = (context.data.ticketPlanning?.items || []).filter((ticket) =>
        (scheduleItem.ticketIds || []).includes(ticket.id) || (ticket.scheduleItemIds || ticket.itemIds || []).includes(scheduleItem.id)
      );
      if (linkedTickets.length) { status("此安排关联着门票。请先在安排编辑中移除或重新关联门票，再删除。", true); return; }
      let attachmentCount = 0;
      if (window.TravelAttachmentStore) {
        try { attachmentCount = (await window.TravelAttachmentStore.list(context.data.metadata.tripId, `schedule:${id}`)).length; }
        catch (error) { status(`无法检查该行程的附件，已取消删除：${error.message || "本地存储不可用"}`, true); return; }
      }
      if (!window.confirm(`确定删除这项行程安排吗？${attachmentCount ? `同时删除关联的 ${attachmentCount} 个本地附件。` : ""}`)) return;
      const saved = await commit((next) => {
        const targetDay = next.days.find((item) => item.id === selectedDayId);
        if (targetDay) targetDay.schedule = targetDay.schedule.filter((item) => item.id !== id);
        next.connections = next.connections.filter((item) => item.fromItemId !== id && item.toItemId !== id);
        const detached = new Set(scheduleItem.transportIds || []);
        detached.forEach((transportId) => {
          const stillLinked = targetDay?.schedule.some((item) => (item.transportIds || []).includes(transportId));
          if (!stillLinked) {
            const transport = next.transportRecords.find((item) => item.id === transportId);
            if (transport) transport.dayIds = (transport.dayIds || []).filter((dayId) => dayId !== selectedDayId);
          }
        });
      }, "行程安排已删除。");
      if (saved && window.TravelAttachmentStore) {
        try { await window.TravelAttachmentStore.removeAll(context.data.metadata.tripId, `schedule:${id}`); }
        catch (error) { status(`行程已删除，但附件清理失败：${error.message || "本地存储不可用"}`, true); }
      }
      renderList();
      return;
    }
    const record = content[collection]?.find((item) => item.id === id);
    if (collection === "todoCategories") return deleteCategory(record);
    if (collection === "transportRecords") {
      const linked = record?.sourceType;
      const question = linked ? "删除这条航班/租车关联？原始航班和租车资料会保留。" : "确定删除这条交通记录吗？";
      if (!window.confirm(question)) return;
    } else if (collection === "days") {
      const day = record;
      const ticketRefs = (context.data.ticketPlanning?.items || []).filter((ticket) => ticket.dayId === day?.id || ticket.day === day?.day);
      if (ticketRefs.length) { status("这一天关联着门票。请先在门票资料中重新关联，再删除日期。", true); return; }
      let attachmentCount = 0;
      if (window.TravelAttachmentStore) {
        try { for (const item of day?.schedule || []) attachmentCount += (await window.TravelAttachmentStore.list(context.data.metadata.tripId, `schedule:${item.id}`)).length; }
        catch (error) { status(`无法检查该日期的附件，已取消删除：${error.message || "本地存储不可用"}`, true); return; }
      }
      if (!window.confirm(`确定删除这一天及其行程安排吗？${attachmentCount ? `同时删除关联的 ${attachmentCount} 个本地附件。` : ""}`)) return;
    } else if (!window.confirm("确定删除这条资料吗？")) return;
    const saved = await commit((next) => {
      if (collection === "days" && selectedDayId === id) selectedDayId = null;
      next[collection] = next[collection].filter((item) => item.id !== id);
      if (collection === "days") {
        next.transportRecords.forEach((item) => { item.dayIds = (item.dayIds || []).filter((dayId) => dayId !== id); });
        next.connections = next.connections.filter((item) => item.dayId !== id);
      }
      if (collection === "transportRecords") next.days.forEach((day) => (day.schedule || []).forEach((item) => { item.transportIds = (item.transportIds || []).filter((transportId) => transportId !== id); }));
    }, "资料已删除。");
    if (saved && collection === "days" && window.TravelAttachmentStore) {
      try {
        for (const item of record?.schedule || []) await window.TravelAttachmentStore.removeAll(context.data.metadata.tripId, `schedule:${item.id}`);
      } catch (error) { status(`日期已删除，但部分行程附件清理失败：${error.message || "本地存储不可用"}`, true); }
    }
    renderList();
  }

  function openDialog(tab = "accommodations") {
    activeTab = tab;
    selectedDayId = null;
    document.querySelector("#travel-content-dialog")?.showModal();
    renderTabs(); renderList();
  }

  function openTransportForRole(role) {
    const journeyRole = window.TravelContentStore.normalizeJourneyRole(role);
    if (!journeyRole) return;
    openDialog("transportRecords");
    openForm("transportRecords", { type: "other", journeyRole });
  }

  function renderTabs() {
    document.querySelectorAll("[data-travel-tab]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.travelTab === activeTab));
    });
  }

  function handleClick(event) {
    const removeJourney = event.target.closest("[data-remove-passenger-journey]");
    if (removeJourney) {
      void removePassengerJourney(removeJourney);
      return;
    }
    const tab = event.target.closest("[data-travel-tab]");
    if (tab) { activeTab = tab.dataset.travelTab; selectedDayId = null; renderTabs(); renderList(); return; }
    if (event.target.closest("#travel-content-open")) { openDialog(); return; }
    if (event.target.closest("#travel-content-close")) { document.querySelector("#travel-content-dialog")?.close(); return; }
    if (event.target.closest("[data-back-days]")) { selectedDayId = null; renderList(); return; }
    if (event.target.closest("[data-category-add]")) { openCategoryForm(); return; }
    const add = event.target.closest("[data-add]");
    if (add) {
      if (activeTab === "days" && selectedDayId) openForm("schedule");
      else if (activeTab === "days") openForm("days");
      else if (activeTab === "accommodations" || activeTab === "restaurants" || activeTab === "transportRecords") openForm(activeTab);
      return;
    }
    const schedule = event.target.closest("[data-schedule]");
    if (schedule) { selectedDayId = schedule.dataset.schedule; renderList(); return; }
    if (event.target.closest("[data-cancel-form]")) { renderList(); return; }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      const id = edit.dataset.edit;
      if (activeTab === "todoCategories") { openCategoryForm(content.todoCategories.find((item) => item.id === id)); return; }
      if (activeTab === "transportRecords") openForm(activeTab, transportList().find((item) => item.id === id));
      else if (activeTab === "days" && selectedDayId) openForm("schedule", content.days.find((day) => day.id === selectedDayId)?.schedule?.find((item) => item.id === id));
      else openForm(activeTab, content[activeTab].find((item) => item.id === id));
      return;
    }
    const transportDetail = event.target.closest("[data-transport-detail]");
    if (transportDetail) {
      const record = transportList().find((item) => item.id === transportDetail.dataset.transportDetail);
      if (record) window.dispatchEvent(new CustomEvent("travel-transport-detail", { detail: copy(record) }));
      return;
    }
    const remove = event.target.closest("[data-delete]");
    if (remove) { void deleteRecord(remove.dataset.delete); return; }
  }

  function handleSubmit(event) {
    const titleForm = event.target.closest("[data-trip-title-form]");
    if (titleForm) { event.preventDefault(); void saveTripTitle(titleForm); return; }
    const form = event.target.closest("[data-editor-form]");
    if (form) { event.preventDefault(); void saveForm(form); return; }
    const categoryForm = event.target.closest("[data-category-form]");
    if (categoryForm) { event.preventDefault(); void saveCategoryForm(categoryForm); }
    const moveForm = event.target.closest("[data-category-move]");
    if (moveForm) { event.preventDefault(); void moveCategoryTasks(moveForm); }
  }

  function handleChange(event) {
    if (!["type", "flightSourceMode"].includes(event.target.name) || !event.target.closest('[data-editor-form="transportRecords"]')) return;
    const form = event.target.form;
    const draft = draftFromForm(form);
    if (event.target.name === "type") draft.type = event.target.value;
    if (event.target.name === "flightSourceMode") draft.flightSourceMode = event.target.value;
    openForm("transportRecords", draft);
  }

  function openCategoryForm(category = null) {
    editing = { kind: "todoCategories", id: category?.id || null };
    editingValue = category ? copy(category) : null;
    document.querySelector("#travel-content-panel").innerHTML = `<form class="travel-editor-form" data-category-form><div class="travel-content-list__heading"><h3>${category ? "编辑分类" : "新增分类"}</h3><button type="button" data-cancel-form>返回</button></div><div class="travel-editor-fields">${field("分类名称", "name", category?.name || "", "text", { maxlength: 40 })}</div><div class="travel-editor-actions"><button type="submit">保存</button><button type="button" data-cancel-form>取消</button></div></form>`;
    document.querySelector("#travel-content-panel input")?.focus({ preventScroll: true });
  }

  function openCategoryMoveForm(category, count) {
    const targets = content.todoCategories.filter((item) => item.id !== category.id);
    if (!targets.length) { status("请先新增另一个分类，再删除此分类。", true); return; }
    document.querySelector("#travel-content-panel").innerHTML = `<form class="travel-editor-form" data-category-move="${esc(category.id)}"><div class="travel-content-list__heading"><h3>移动分类中的任务</h3><button type="button" data-cancel-form>返回</button></div><p>“${esc(category.name)}”中有 ${count} 项任务。选择目标分类后删除该分类，任务内容和完成状态会保留。</p>${selectField("移动到", "targetId", targets.map((item) => [item.id, item.name]))}<div class="travel-editor-actions"><button type="submit">移动任务并删除分类</button><button type="button" data-cancel-form>取消</button></div></form>`;
  }

  async function moveCategoryTasks(form) {
    const categoryId = form.dataset.categoryMove;
    const targetId = String(new FormData(form).get("targetId") || "");
    if (!targetId || targetId === categoryId) { status("请选择有效的目标分类。", true); return; }
    let updatedTodos;
    try { updatedTodos = window.TravelContentStore.moveTasksBeforeCategoryDelete(context.getTodos(), content.todoCategories, categoryId, targetId); }
    catch (error) { status(error.message, true); return; }
    try { await context.saveTodos(updatedTodos); context.setTodos(updatedTodos); }
    catch (error) { status(`任务保存失败，任务和分类都未删除：${error.message || "本地保存失败"}`, true); return; }
    const ok = await commit((next) => { next.todoCategories = next.todoCategories.filter((item) => item.id !== categoryId); }, "分类已删除，任务已移动并保留。");
    if (ok) { context.renderTodos(); renderList(); }
  }

  async function saveCategoryForm(form) {
    const name = String(new FormData(form).get("name") || "").trim();
    if (!name) { status("请输入分类名称。", true); form.elements.name?.focus(); return; }
    const old = editingValue;
    const id = old?.id || `category-${idFor("custom").replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const ok = await commit((next) => {
      const collision = next.todoCategories.some((item) => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (collision) throw new Error("已有同名分类。");
      const index = next.todoCategories.findIndex((item) => item.id === id);
      if (index >= 0) next.todoCategories[index] = { ...next.todoCategories[index], name };
      else next.todoCategories.push({ id, name });
    }, "分类已保存。");
    if (ok) { context.renderTodos?.(); renderList(); }
  }

  async function deleteCategory(category) {
    if (!category) return;
    const usedBy = context.getTodos().filter((todo) => todo.categoryId === category.id);
    if (usedBy.length) {
      openCategoryMoveForm(category, usedBy.length);
      return;
    } else {
      if (content.todoCategories.length <= 1) { status("至少需要保留一个分类。", true); return; }
      if (!window.confirm(`确定删除“${category.name}”分类吗？`)) return;
    }
    const ok = await commit((next) => { next.todoCategories = next.todoCategories.filter((item) => item.id !== category.id); }, "分类已删除，任务已保留。");
    if (ok) { context.renderTodos(); renderList(); }
  }

  async function init(options) {
    context = options;
    window.addEventListener("travel-ledger:travelers-changed", (event) => {
      refreshTravelerSelectors(event);
      if (String(event?.detail?.tripId || "") === String(context?.data?.metadata?.tripId || "")) void refreshInspirationApprovals();
    });
    store = options.cloudStorage
      ? window.TravelContentStore.createCloudStore(options.data.metadata.tripId, options.data.config.persistence.apiBase || "/api/trip")
      : window.TravelContentStore.createStore(options.data.metadata.tripId);
    try {
      content = await store.load(options.data);
      applyToPage();
      window.TRAVEL_CONTENT = content;
      const section = document.querySelector("#travel-content-tools");
      section.hidden = false;
      document.addEventListener("click", handleClick);
      document.querySelector("#travel-content-panel")?.addEventListener("click", handlePassengerJourneyClick);
      document.addEventListener("submit", handleSubmit);
      document.querySelector("#travel-content-panel")?.addEventListener("change", handleChange);
      return content;
    } catch (error) {
      const section = document.querySelector("#travel-content-tools");
      section.hidden = false;
      status(error.message || "旅行资料载入失败。", true);
      return null;
    }
  }

  function openTab(tab) { openDialog(tab); }
  function openDay(dayId) { selectedDayId = String(dayId || ""); activeTab = "days"; document.querySelector("#travel-content-dialog")?.showModal(); renderTabs(); renderList(); }
  function openDayItem(dayId, itemId = "") {
    selectedDayId = String(dayId || ""); activeTab = "days";
    document.querySelector("#travel-content-dialog")?.showModal(); renderTabs(); renderList();
    const day = content?.days.find((item) => item.id === selectedDayId);
    if (day) openForm("schedule", itemId ? day.schedule?.find((item) => item.id === itemId) : null);
  }
  function getContent() { return content ? copy(content) : null; }

  function getSourceDetails(sourceType, sourceId) {
    const direct = content?.transportRecords.find((item) => item.sourceType === sourceType && item.sourceId === sourceId);
    if (direct) return copy(direct);
    if (sourceType === "journey") {
      const flightIds = new Set(sourceFlights().filter((flight) => flight.journeyId === sourceId).map((flight) => flight.id));
      const linked = content?.transportRecords.find((item) => item.sourceType === "flight" && flightIds.has(item.sourceId));
      if (linked) return copy(linked);
    }
    return {};
  }

  async function saveSourceDetails(sourceType, sourceId, details) {
    if (sourceType === "record") {
      const ok = await commit((next) => {
        const item = next.transportRecords.find((record) => record.id === sourceId);
        if (!item) throw new Error("找不到这条交通记录。");
        Object.assign(item, copy(details));
      }, "交通详情已保存。");
      return ok;
    }
    const current = content?.transportRecords.find((item) => item.sourceType === sourceType && item.sourceId === sourceId);
    const id = current?.id || `${sourceType}-${sourceId}`;
    const ok = await commit((next) => {
      const index = next.transportRecords.findIndex((item) => item.sourceType === sourceType && item.sourceId === sourceId);
      const record = { ...(index >= 0 ? next.transportRecords[index] : {}), ...copy(details), id, type: sourceType === "journey" || sourceType === "flight" ? "flight" : sourceType === "rental" ? "rental-car-driving" : details.type || "other", sourceType, sourceId };
      if (index >= 0) next.transportRecords[index] = record; else next.transportRecords.push(record);
    }, "交通详情已保存。");
    return ok;
  }

  async function saveConnection(value) {
    const existing = content.connections.find((item) => item.fromItemId === value.fromItemId && item.toItemId === value.toItemId);
    const id = value.id || existing?.id || idFor("leg");
    const ok = await commit((next) => {
      const index = next.connections.findIndex((item) => item.id === id || (item.fromItemId === value.fromItemId && item.toItemId === value.toItemId));
      const record = { ...(index >= 0 ? next.connections[index] : {}), ...copy(value), id };
      if (index >= 0) next.connections[index] = record; else next.connections.push(record);
    }, "行程交通衔接已保存。");
    return ok;
  }

  async function deleteConnection(id) {
    return commit((next) => { next.connections = next.connections.filter((item) => item.id !== id); }, "交通衔接已删除。");
  }

  async function removeConnectionsForItem(itemId) {
    return commit((next) => { next.connections = next.connections.filter((item) => item.fromItemId !== itemId && item.toItemId !== itemId); }, "关联交通衔接已清理。");
  }

  async function saveInspiration(value) {
    const url = window.TravelContentStore.safeInspirationUrl(value?.sourceUrl || "");
    const id = String(value?.id || idFor("inspiration"));
    const record = {
      ...(content.inspirations.find((item) => item.id === id) || {}),
      ...copy(value || {}), id, sourceUrl: url,
      title: String(value?.title || "").trim(),
      locationName: String(value?.locationName || "").trim(),
      votes: Array.isArray(value?.votes) ? copy(value.votes) : (content.inspirations.find((item) => item.id === id)?.votes || []),
      createdAt: content.inspirations.find((item) => item.id === id)?.createdAt || value?.createdAt || new Date().toISOString()
    };
    return commit((next) => {
      if (!record.title) throw new Error("请填写种草标题。");
      const index = next.inspirations.findIndex((item) => item.id === id);
      if (index >= 0) next.inspirations[index] = record;
      else next.inspirations.unshift(record);
    }, "种草记录已保存。");
  }

  async function voteInspiration(inspirationId, travelerId) {
    const travelers = window.TravelLedger?.getSnapshot?.()?.travelers || [];
    let outcome = null;
    const ok = await commit((next) => {
      outcome = window.TravelContentStore.applyInspirationVote(next, String(inspirationId), String(travelerId), travelers.map((person) => person.id));
    }, "投票已更新。");
    return ok ? outcome : null;
  }

  async function addInspirationToDay(inspirationId, dayId) {
    let added = false;
    const ok = await commit((next) => { added = window.TravelContentStore.manuallyAddInspiration(next, String(inspirationId), String(dayId)); }, "灵感已加入当天行程。");
    return ok ? added : false;
  }

  async function deleteInspiration(inspirationId) {
    const record = content.inspirations.find((item) => item.id === String(inspirationId));
    if (!record) return false;
    const message = record.linkedItineraryItemId
      ? "这条灵感已经关联行程。删除灵感只会删除原帖记录，保留用户可能已修改过的行程安排。确定继续吗？"
      : "确定删除这条旅行灵感吗？";
    if (!window.confirm(message)) return false;
    return commit((next) => { next.inspirations = next.inspirations.filter((item) => item.id !== record.id); }, "种草记录已删除；已有行程安排已保留。");
  }

  async function refreshInspirationApprovals() {
    if (!content?.inspirations?.length) return true;
    const travelers = window.TravelLedger?.getSnapshot?.()?.travelers || [];
    return commit((next) => {
      next.inspirations.forEach((record) => window.TravelContentStore.updateInspirationApproval(next, record, travelers.map((person) => person.id)));
    }, "同行人变更后已更新种草投票状态。");
  }

  window.TravelContentEditor = Object.freeze({ init, openTab, openDay, openDayItem, openTransportForRole, getContent, getCategories: () => copy(content?.todoCategories || []), transportsForDay, getSourceDetails, saveSourceDetails, saveConnection, deleteConnection, removeConnectionsForItem, saveInspiration, voteInspiration, addInspirationToDay, deleteInspiration, refreshInspirationApprovals });
})();
