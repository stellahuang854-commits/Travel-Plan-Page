(() => {
  "use strict";

  const esc = (value = "") => String(value).replace(/[&<>\'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const transportLabels = Object.freeze({
    flight: "Flight", "high-speed-rail": "High-speed rail", train: "Train", metro: "Metro", "bus-coach": "Bus/Coach",
    "ferry-boat": "Ferry/Boat", "taxi-ride-hailing": "Taxi/Ride-hailing", "rental-car-driving": "Rental car/Driving",
    walking: "Walking", bicycle: "Bicycle", other: "Other"
  });

  function safeHref(value) {
    try {
      const url = new URL(String(value || ""), globalThis.location?.href || "https://travel.invalid/");
      return ["https:", "http:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  function attachmentButton(transportId, count) {
    if (!count) return "";
    return `<button type="button" class="travel-archive-attachment" data-archive-attachment="${esc(transportId)}">查看附件 / 凭证（${Number(count)}）</button>`;
  }

  function renderPublicContent(content, travelers = [], attachmentCounts = {}) {
    if (!content) return "";
    const people = new Map((Array.isArray(travelers) ? travelers : []).map((person) => [String(person.id), person.name || ""]));
    const groups = [];
    const accommodations = (content.accommodations || []).map((item) => { const href = safeHref(item.documentUrl); return `<article class="travel-archive-row"><div><strong>${esc(item.name || "住宿")}</strong><p>${esc([item.address, item.checkInDate || item.checkIn?.date, item.checkOutDate || item.checkOut?.date, item.bookingReference || item.confirmationNumber, item.notes || item.note].filter(Boolean).join(" · ") || "尚无详细信息")}</p>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">查看预订凭证 ↗</a>` : ""}</div>${attachmentButton(`accommodation:${item.id}`, attachmentCounts[`accommodation:${item.id}`])}</article>`; }).join("");
    const restaurants = (content.restaurants || []).map((item) => { const href = safeHref(item.bookingUrl); return `<article class="travel-archive-row"><div><strong>${esc(item.name || "餐厅")}</strong><p>${esc([item.address, item.date, item.reservationTime, item.partySize ? `${item.partySize} 人` : "", item.contact, item.notes || item.note].filter(Boolean).join(" · ") || "尚无详细信息")}</p>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">查看预订链接 ↗</a>` : ""}</div>${attachmentButton(`restaurant:${item.id}`, attachmentCounts[`restaurant:${item.id}`])}</article>`; }).join("");
    const transportRows = (content.transportRecords || []).map((record) => {
      const journeys = window.TravelContentStore.normalizePassengerJourneys(record);
      const parentDetail = [transportLabels[record.type] || record.type, record.date, [record.from, record.to].filter(Boolean).join(" → ")].filter(Boolean).join(" · ");
      const journeyRows = journeys.map((journey) => {
        const selectedNames = (journey.travelerIds || []).map((id) => people.get(String(id))).filter(Boolean);
        const passengers = [...new Set([...selectedNames, journey.passenger, journey.passengerName].filter(Boolean))].join("、") || "同行者待选择";
        const type = transportLabels[journey.type] || journey.type || transportLabels[record.type] || "交通";
        const details = [type, passengers, journey.serviceNumber || journey.flightNumber, [journey.from, journey.to].filter(Boolean).join(" → "), [journey.date, journey.startTime, journey.endTime].filter(Boolean).join(" "), journey.seat ? `座位 ${journey.seat}` : "", journey.note].filter(Boolean).join(" · ");
        const attachmentKey = window.TravelContentStore.passengerJourneyAttachmentKey(record.id, journey.id);
        return `<div class="travel-archive-passenger"><p>${esc(details)}</p><button type="button" data-passenger-journey-detail="${esc(record.id)}" data-passenger-journey-id="${esc(journey.id)}" data-attachment-transport-id="${esc(attachmentKey)}">详情 / 票据${attachmentCounts[attachmentKey] ? `（${Number(attachmentCounts[attachmentKey])}）` : ""}</button></div>`;
      }).join("");
      const parentAttachmentCount = attachmentCounts[record.id] || 0;
      return `<article class="travel-archive-row"><div><strong>${esc(record.title || record.name || "交通行程")}</strong><p>${esc(parentDetail || "尚无详细信息")}</p>${journeyRows || `<p>${esc([record.serviceNumber || record.flightNumber, record.startTime, record.endTime, record.passenger, record.note].filter(Boolean).join(" · ") || "尚无乘客班次详情")}</p>`}</div>${parentAttachmentCount ? `<button type="button" data-record-detail="${esc(record.id)}">查看附件 / 凭证（${Number(parentAttachmentCount)}）</button>` : ""}</article>`;
    }).join("");
    if (accommodations) groups.push(`<section class="travel-archive-group"><h3>住宿</h3>${accommodations}</section>`);
    if (restaurants) groups.push(`<section class="travel-archive-group"><h3>餐厅</h3>${restaurants}</section>`);
    if (transportRows) groups.push(`<section class="travel-archive-group"><h3>其他交通资料</h3>${transportRows}</section>`);
    return groups.join("");
  }

  const api = Object.freeze({ renderPublicContent });
  if (typeof window !== "undefined") window.TravelContentView = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
