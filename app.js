import { nbPmf, multiplier, evaluateCell } from "./src/autofill.js";
import { POLICIES, buildCells, planBoard } from "./src/board.js";

const STORE = "broccoli-board-autofill-v1";
const app = document.getElementById("app");
const overlay = document.getElementById("overlay");
let CONFIG, BOARD, RESULTS;
const cache = new Map();

const usd = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const n0 = (x) => Math.round(x).toLocaleString("en-US");
const n1 = (x) => (Math.round(x * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icons = () => window.lucide && window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
const DAYNAME = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const addDays = (iso, k) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

// ---------- state ----------
function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
let store = load();
const save = () => localStorage.setItem(STORE, JSON.stringify(store));
const assumptions = () => ({ ...CONFIG.assumptions, ...(store.assumptions || {}), inboundValues: { ...CONFIG.assumptions.inboundValues, ...((store.assumptions || {}).inboundValues || {}) }, playValues: { ...CONFIG.assumptions.playValues, ...((store.assumptions || {}).playValues || {}) } });

function route() {
  const h = location.hash.replace(/^#/, "") || "/board";
  const [path, qs] = h.split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(qs || "") };
}
function dateOptions() {
  const coldest = RESULTS.days.slice().sort((a, b) => a.temps[1] - b.temps[1]).slice(0, 6);
  const mild = RESULTS.days.filter((d) => d.temps[1] >= 45).slice(0, 2);
  return [{ id: "today", label: `Today · ${DAYNAME(BOARD.today.date)} (forecast)` },
    ...[...coldest, ...mild].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ id: d.date, label: `${DAYNAME(d.date)}, ${d.date.slice(0, 4)} · ${Math.round(d.temps[1])}°F next day` }))];
}
function snapshot(dateId) {
  if (dateId === "today" || !dateId) return { id: "today", date: BOARD.today.date, dates: BOARD.today.dates, temps: BOARD.today.temps, mins: BOARD.today.mins, maxs: BOARD.today.maxs, kind: "Real Open-Meteo forecast, fetched Nov 11, 2026" };
  const i = BOARD.history.findIndex((h) => h[0] === dateId);
  if (i < 0 || i + 2 >= BOARD.history.length) return null;
  const hs = [0, 1, 2].map((k) => BOARD.history[i + k]);
  return { id: dateId, date: dateId, dates: hs.map((h) => h[0]), temps: hs.map((h) => h[1]), mins: hs.map((h) => h[2]), maxs: hs.map((h) => h[3]), kind: "Replay with the day's actual temperatures (Open-Meteo archive)" };
}
function plans(snap) {
  const a = assumptions();
  const key = snap.id + "|" + JSON.stringify(a);
  if (cache.has(key)) return cache.get(key);
  const cells = buildCells(CONFIG, BOARD.fit, snap.temps, snap.date, a);
  const out = Object.fromEntries(["fill", "reserve", "smart"].map((p) => [p, planBoard(CONFIG, cells, p, a)]));
  cache.set(key, out);
  return out;
}
function hrefBoard(p) { const q = new URLSearchParams({ date: p.date || "today", policy: p.policy || "smart" }); return `#/board?${q}`; }

// ---------- chrome ----------
function crumbs(list) {
  document.getElementById("crumbs").innerHTML = list.map((c, i) => (i < list.length - 1 ? `<a href="${c.href}">${esc(c.label)}</a><i data-lucide="chevron-right"></i>` : `<span class="here" aria-current="page">${esc(c.label)}</span>`)).join("");
}
function setNav(name) { document.querySelectorAll(".sb-menu a[data-nav]").forEach((a) => { if (a.dataset.nav === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }); }
function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.innerHTML = `<i data-lucide="circle-check"></i>${esc(msg)}`; document.body.appendChild(t); icons(); setTimeout(() => t.remove(), 2600); }
const wxIcon = (t) => (t < 25 ? "snowflake" : t < 40 ? "cloud-snow" : t < 55 ? "cloud-sun" : "sun");

// ---------- slot strip for a cell ----------
function slotStrip(r) {
  const out = Math.round(r.ev.outboundBooked);
  const hold = Math.max(0, Math.min(r.open - out, Math.round(r.ev.inboundServed)));
  const open = Math.max(0, r.open - out - hold);
  const parts = [];
  for (let i = 0; i < r.booked; i++) parts.push("s-sched");
  for (let i = 0; i < out; i++) parts.push("s-out");
  for (let i = 0; i < hold; i++) parts.push("s-hold");
  for (let i = 0; i < open; i++) parts.push("s-open");
  return `<div class="slots" aria-hidden="true">${parts.map((c) => `<span class="${c}"></span>`).join("")}</div>`;
}

// ---------- views ----------
function viewBoard(params) {
  setNav("board");
  crumbs([{ label: "Board" }]);
  const snap = snapshot(params.get("date") || "today");
  if (!snap) { app.innerHTML = `<div class="alert alert-red" role="alert"><i data-lucide="circle-alert"></i><div>No weather for that date. <a href="#/board">Back to today</a></div></div>`; return; }
  const policy = POLICIES[params.get("policy")] ? params.get("policy") : "smart";
  const all = plans(snap), P = all[policy], fill = all.fill;
  const launched = store.launched && store.launched.date === snap.id ? store.launched : null;
  const dv = P.totals.value - fill.totals.value;
  const opts = dateOptions();
  app.innerHTML = `
    <div class="page-h">
      <div><h1>Board</h1><p>Open capacity by business unit for the next three days. Broccoli fills it with outbound plays; weather-aware autofill holds the slots that tomorrow's inbound callers will need.</p></div>
      <div class="actions">
        <div class="rel"><button class="btn" id="exportBtn" type="button" aria-haspopup="menu"><i data-lucide="download"></i>Export</button></div>
        <button class="btn" id="assumpBtn" type="button"><i data-lucide="sliders-horizontal"></i>Assumptions</button>
        ${launched ? `<button class="btn" id="pauseBtn" type="button"><i data-lucide="pause"></i>Pause plays</button>` : `<button class="btn btn-accent" id="launchBtn" type="button" ${P.totals.calls ? "" : "disabled"}><i data-lucide="phone-outgoing"></i>Launch plays</button>`}
      </div>
    </div>
    ${launched ? `<div class="alert alert-accent" role="status" style="margin-bottom:14px"><i data-lucide="phone-outgoing"></i><div><b>${POLICIES[launched.policy].name} plays are calling.</b> ${n0(launched.calls)} calls queued at ${launched.at} for ${esc(CONFIG.company)}; expected ${n1(launched.booked)} bookings.</div></div>` : ""}
    <div class="toolbar">
      <select class="select" id="dateSel" aria-label="Board date">${opts.map((o) => `<option value="${o.id}" ${o.id === snap.id ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
      <div class="seg" role="group" aria-label="Autofill policy">${["fill", "reserve", "smart"].map((p, i) => `<button type="button" data-policy="${p}" aria-pressed="${p === policy}" title="${POLICIES[p].name} (${i + 1})">${POLICIES[p].name}${p === "smart" ? ' <span class="pill pill-accent" style="height:18px;margin-left:4px;font-size:11px">New</span>' : ""}</button>`).join("")}</div>
      <span class="grow"></span>
      <a class="btn btn-ghost btn-sm" href="#/board/backtest"><i data-lucide="history"></i>Backtest: two winters</a>
    </div>
    <div class="stats">
      <div class="card stat"><div class="k"><i data-lucide="circle-dollar-sign"></i>Expected revenue, 3 days</div><div class="v">${usd(P.totals.value)}</div><div class="d">${policy === "fill" ? "Baseline: fill every open slot" : `<span class="${dv >= 0 ? "up" : "down"}">${dv >= 0 ? "+" : ""}${usd(dv)}</span> vs filling every slot`}</div></div>
      <div class="card stat"><div class="k"><i data-lucide="phone-outgoing"></i>Outbound calls</div><div class="v">${n0(P.totals.calls)}</div><div class="d">${n1(P.totals.outboundBooked)} expected bookings</div></div>
      <div class="card stat"><div class="k"><i data-lucide="shield"></i>Slots left for inbound</div><div class="v">${n0(P.rows.reduce((s, r) => s + r.open, 0) - P.totals.outboundBooked)}</div><div class="d">${n1(P.totals.inboundServed)} expected inbound bookings</div></div>
      <div class="card stat"><div class="k"><i data-lucide="phone-missed"></i>Inbound callers turned away</div><div class="v">${n1(P.totals.turnedAway)}</div><div class="d">${policy === "fill" ? "No open slot when they called" : `${n1(fill.totals.turnedAway - P.totals.turnedAway)} fewer than filling every slot`}</div></div>
    </div>
    <section class="card" aria-label="Board">
      <div class="wx">
        <div class="lab">${esc(CONFIG.city)}<br><span class="ink3" style="font-size:11.5px">${snap.id === "today" ? "Forecast" : "Actual"}</span></div>
        ${snap.dates.map((d, k) => `<div class="day"><span class="ico"><i data-lucide="${wxIcon(snap.temps[k])}"></i></span><div><div class="d1">${k === 0 ? "Today" : k === 1 ? "Tomorrow" : DAYNAME(d).split(",")[0]} · ${DAYNAME(d).split(", ")[1]}</div><div class="d2">${Math.round(snap.mins[k])}° to ${Math.round(snap.maxs[k])}°F · inbound ×${multiplier(BOARD.fit, snap.temps[k], 1).toFixed(2)}</div></div></div>`).join("")}
      </div>
      <div class="board" role="grid" aria-label="Business units by day">
        ${CONFIG.rows.map((row) => `<div class="rowh" role="rowheader"><span class="t">${esc(row.label)}</span><span class="s">${row.techs} techs · ${row.capacity} slots/day</span></div>
          ${[0, 1, 2].map((d) => { const r = P.rows.find((x) => x.row === row.id && x.day === d); return `<button class="cell" role="gridcell" type="button" data-cell="${row.id}/${d}" aria-label="${esc(row.label)} ${d === 0 ? "today" : d === 1 ? "tomorrow" : "day after"}: ${r.open} open, ${n0(r.ev.calls)} calls, ${n1(r.inboundMean)} inbound expected">
            <div class="top"><b>${r.open}</b> open of ${r.capacity}<span class="calls">${n0(r.ev.calls)} calls</span></div>
            ${slotStrip(r)}
            <div class="bot"><span>Inbound ~${n1(r.inboundMean)}</span><span>Outbound ~${n1(r.ev.outboundBooked)}</span></div></button>`; }).join("")}`).join("")}
      </div>
      <div class="legend"><span><i class="s-sched"></i>Already scheduled</span><span><i class="s-out"></i>Booked by Broccoli (expected)</span><span><i class="s-hold"></i>Held for inbound (expected)</span><span><i class="s-open" style="box-shadow:inset 0 0 0 1px var(--bui-line-strong)"></i>Likely idle</span><span style="margin-left:auto" class="ink3">${esc(snap.kind)}</span></div>
    </section>
    <div class="grid2">
      <section class="card" aria-label="Plays">
        <div class="card-h"><h3>Plays</h3><span class="sub">${POLICIES[policy].name}</span></div>
        <div class="card-b" style="padding:8px 0 4px">
          <table class="table"><thead><tr><th>Play</th><th class="r">Conversion</th><th class="r">Value</th><th class="r">Calls</th><th class="r">Bookings</th><th class="r">Revenue</th></tr></thead><tbody>
          ${P.plays.map((pl, i) => { const calls = P.rows.reduce((s, r) => s + r.calls[i], 0); const ev = P.rows.reduce((s, r) => s + evaluateCell(r.ctx, P.plays, P.plays.map((_, j) => (j === i ? r.calls[j] : 0))).outboundBooked, 0);
            return `<tr><td>${esc(pl.name)}</td><td class="r num">${pct(pl.rate, 0)}</td><td class="r num">${usd(pl.value)}</td><td class="r num">${n0(calls)}</td><td class="r num">${n1(calls ? ev : 0)}</td><td class="r num">${usd(calls ? ev * pl.value : 0)}</td></tr>`; }).join("")}
          </tbody></table>
          <p class="note" style="padding:0 14px">Conversion rates are Broccoli's own play templates. Bookings and revenue are each play alone in its cells; the stats above account for plays competing for the same slots.</p>
        </div>
      </section>
      <section class="card" aria-label="Policies compared">
        <div class="card-h"><h3>Policies on this board</h3></div>
        <div class="card-b" style="padding:8px 0 4px">
          <table class="table"><thead><tr><th>Policy</th><th class="r">Calls</th><th class="r">Turned away</th><th class="r">Revenue</th></tr></thead><tbody>
          ${["fill", "reserve", "smart"].map((p) => `<tr class="click" data-href="${hrefBoard({ date: snap.id, policy: p })}" ${p === policy ? 'style="background:var(--bui-accent-tint)"' : ""}><td>${POLICIES[p].name}</td><td class="r num">${n0(all[p].totals.calls)}</td><td class="r num">${n1(all[p].totals.turnedAway)}</td><td class="r num">${usd(all[p].totals.value)}</td></tr>`).join("")}
          </tbody></table>
          <p class="note" style="padding:0 14px">Expected values, computed exactly from the inbound forecast and the plays' conversion rates. Over two real Salt Lake City winters, weather-aware earned <b>${pct(RESULTS.headline.smart_vs_fill_revenue_pct)}</b> more per board than filling every slot. <a href="#/board/backtest">See the backtest</a></p>
        </div>
      </section>
    </div>`;
  const go = (patch) => { location.hash = hrefBoard({ date: snap.id, policy, ...patch }); };
  document.getElementById("dateSel").addEventListener("change", (e) => go({ date: e.target.value }));
  app.querySelectorAll("[data-policy]").forEach((b) => b.addEventListener("click", () => go({ policy: b.dataset.policy })));
  app.querySelectorAll("[data-cell]").forEach((b) => b.addEventListener("click", () => { location.hash = `#/board/cell/${b.dataset.cell}?date=${snap.id}&policy=${policy}`; }));
  app.querySelectorAll("tr[data-href]").forEach((tr) => tr.addEventListener("click", () => { location.hash = tr.dataset.href; }));
  document.getElementById("assumpBtn").addEventListener("click", assumptionsDialog);
  document.getElementById("exportBtn").addEventListener("click", (e) => exportMenu(e.currentTarget, snap, policy, P));
  const lb = document.getElementById("launchBtn"); if (lb) lb.addEventListener("click", () => launchDialog(snap, policy, P));
  const pb = document.getElementById("pauseBtn"); if (pb) pb.addEventListener("click", () => { delete store.launched; save(); toast("Plays paused"); render(); });
  keys.ctx = { snap, policy, P };
}

function viewCell(rowId, d, params) {
  setNav("board");
  const snap = snapshot(params.get("date") || "today");
  const policy = POLICIES[params.get("policy")] ? params.get("policy") : "smart";
  const row = CONFIG.rows.find((r) => r.id === rowId);
  if (!snap || !row || !(d >= 0 && d <= 2)) { viewMissing(); return; }
  const all = plans(snap);
  const cellOf = (p) => all[p].rows.find((x) => x.row === rowId && x.day === d);
  const r = cellOf(policy);
  crumbs([{ label: "Board", href: hrefBoard({ date: snap.id, policy }) }, { label: `${row.label} · ${d === 0 ? "Today" : d === 1 ? "Tomorrow" : DAYNAME(snap.dates[2])}` }]);
  // Inbound demand distribution
  const max = Math.max(r.open + 4, Math.ceil(r.inboundMean * 2.6) + 4);
  const pmf = Array.from(nbPmf(r.inboundMean, BOARD.fit.alpha, max));
  const W = 560, H = 210, L = 40, Rm = 10, T = 14, B = 34, bw = (W - L - Rm) / (max + 1);
  const ymax = Math.max(...pmf) * 1.15;
  const leftForInbound = r.open - r.ev.outboundBooked;
  const x = (k) => L + k * bw;
  const chart1 = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Distribution of inbound demand still to come">
    ${[0, 0.5, 1].map((f) => `<line class="gl" x1="${L}" x2="${W - Rm}" y1="${T + (1 - f) * (H - T - B)}" y2="${T + (1 - f) * (H - T - B)}"/><text x="${L - 6}" y="${T + (1 - f) * (H - T - B) + 4}" text-anchor="end">${pct(f * ymax, 0)}</text>`).join("")}
    ${pmf.map((p, k) => `<rect x="${x(k) + 1}" y="${T + (1 - p / ymax) * (H - T - B)}" width="${Math.max(1, bw - 2)}" height="${(p / ymax) * (H - T - B)}" rx="2" fill="${k <= leftForInbound ? "hsl(var(--booked) / .55)" : "hsl(var(--unbooked) / .8)"}"/>`).join("")}
    <line x1="${x(leftForInbound + 1)}" x2="${x(leftForInbound + 1)}" y1="${T - 4}" y2="${H - B}" stroke="var(--bui-ink)" stroke-dasharray="4 3"/>
    <text x="${x(leftForInbound + 1) + 4}" y="${T + 8}" style="fill:var(--bui-ink)">${n1(leftForInbound)} slots left for inbound</text>
    ${[0, Math.round(max / 4), Math.round(max / 2), Math.round((3 * max) / 4), max].map((k) => `<text x="${x(k) + bw / 2}" y="${H - B + 16}" text-anchor="middle">${k}</text>`).join("")}
    <text x="${(L + W) / 2}" y="${H - 4}" text-anchor="middle">Inbound callers still to come for this day</text></svg>`;
  // Value vs outbound bookings target, with the three policies marked
  const plays = all[policy].plays;
  const cheap = plays.at(-1);
  const curve = [];
  for (let n = 0; n <= Math.ceil(r.open / cheap.rate) + 10; n += Math.max(1, Math.round(r.open / cheap.rate / 40))) {
    const ev = evaluateCell(r.ctx, plays, plays.map((_, i) => (i === plays.length - 1 ? n : 0)), assumptions().costPerCall);
    curve.push({ n, booked: ev.outboundBooked, value: ev.value });
  }
  const vmin = Math.min(...curve.map((c) => c.value)), vmax = Math.max(...curve.map((c) => c.value));
  const W2 = 560, H2 = 210, L2 = 60, x2 = (b) => L2 + (b / Math.max(1, r.open)) * (W2 - L2 - 12), y2 = (v) => 14 + (1 - (v - vmin) / Math.max(1, vmax - vmin)) * (H2 - 14 - 34);
  const best = curve.reduce((a, c) => (c.value > a.value ? c : a), curve[0]);
  const chart2 = `<svg class="chart" viewBox="0 0 ${W2} ${H2}" width="100%" role="img" aria-label="Expected value against outbound tune-up bookings">
    ${[vmin, (vmin + vmax) / 2, vmax].map((v) => `<line class="gl" x1="${L2}" x2="${W2 - 12}" y1="${y2(v)}" y2="${y2(v)}"/><text x="${L2 - 6}" y="${y2(v) + 4}" text-anchor="end">${usd(v)}</text>`).join("")}
    <path d="${curve.map((c, i) => `${i ? "L" : "M"}${x2(c.booked).toFixed(1)},${y2(c.value).toFixed(1)}`).join("")}" fill="none" stroke="var(--bui-accent)" stroke-width="2.25"/>
    <circle cx="${x2(best.booked)}" cy="${y2(best.value)}" r="5" fill="var(--bui-accent)" stroke="#fff" stroke-width="2"/>
    <text x="${Math.min(x2(best.booked) + 8, W2 - 140)}" y="${Math.max(y2(best.value) + 18, 30)}" text-anchor="start" style="fill:var(--bui-accent-ink)">Best: ${n1(best.booked)} tune-ups</text>
    ${[0, 0.5, 1].map((f) => `<text x="${x2(f * r.open)}" y="${H2 - 18}" text-anchor="middle">${n0(f * r.open)}</text>`).join("")}
    <text x="${(L2 + W2) / 2}" y="${H2 - 2}" text-anchor="middle">Open slots filled with member tune-ups (expected)</text></svg>`;
  app.innerHTML = `
    <div class="page-h"><div><h1>${esc(row.label)} · ${d === 0 ? "Today" : d === 1 ? "Tomorrow" : DAYNAME(snap.dates[d])}</h1>
      <p>${r.open} open slots of ${r.capacity}. ${snap.id === "today" ? "Forecast" : "Actual"} mean ${Math.round(r.temp)}°F, so inbound demand runs at ×${r.multiplier.toFixed(2)} of a 45°F day: about ${n1(r.inboundMean)} more callers will want this day.</p></div>
      <div class="actions"><a class="btn" href="${hrefBoard({ date: snap.id, policy })}"><i data-lucide="arrow-left"></i>Back to board</a></div></div>
    <div class="stats">
      ${["fill", "reserve", "smart"].map((p) => { const c = cellOf(p); return `<div class="card stat" style="${p === policy ? "box-shadow:0 0 0 1.5px var(--bui-accent),var(--bui-shadow-sm)" : ""}"><div class="k">${POLICIES[p].name}</div><div class="v">${usd(c.ev.value)}</div><div class="d">${n0(c.ev.calls)} calls · ${n1(c.ev.outboundBooked)} outbound · ${n1(c.ev.inboundTurnedAway)} turned away</div></div>`; }).join("")}
      <div class="card stat"><div class="k">Tune-up protection level</div><div class="v">${r.protect}</div><div class="d">Slots worth more to inbound than to a ${usd(cheap.value)} tune-up</div></div>
    </div>
    <div class="grid2" style="grid-template-columns:1fr 1fr;margin-top:0">
      <section class="card"><div class="card-h"><h3>Inbound still to come</h3><span class="sub">Negative binomial, mean ${n1(r.inboundMean)}</span></div><div class="card-b">${chart1}
        <p class="note">Purple: callers who still find a slot after this policy's outbound bookings. Orange: callers who would be turned away; ${pct(assumptions().lossShare, 0)} of them call a competitor.</p></div></section>
      <section class="card"><div class="card-h"><h3>Is one more tune-up worth it?</h3></div><div class="card-b">${chart2}
        <p class="note">Each tune-up earns ${usd(cheap.value)} but can take a slot a ${usd(r.inboundValue)} repair caller needed. The curve peaks where the chance that inbound fills the next slot drops below ${pct(cheap.value / (r.inboundValue * assumptions().lossShare), 0)}, Littlewood's rule.</p></div></section>
    </div>
    <section class="card" style="margin-top:16px"><div class="card-h"><h3>Calls in this cell</h3><span class="sub">${POLICIES[policy].name}</span></div>
      <div class="card-b" style="padding:8px 0 4px"><table class="table"><thead><tr><th>Play</th><th class="r">Conversion</th><th class="r">Value</th>${["fill", "reserve", "smart"].map((p) => `<th class="r">${POLICIES[p].short}</th>`).join("")}</tr></thead><tbody>
      ${plays.map((pl, i) => `<tr><td>${esc(pl.name)}</td><td class="r num">${pct(pl.rate, 0)}</td><td class="r num">${usd(pl.value)}</td>${["fill", "reserve", "smart"].map((p) => `<td class="r num" ${p === policy ? 'style="font-weight:600"' : ""}>${n0(cellOf(p).calls[i])}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div></section>`;
  keys.ctx = null;
}

function viewBacktest() {
  setNav("board");
  crumbs([{ label: "Board", href: "#/board" }, { label: "Backtest" }]);
  const H = RESULTS.headline, A = RESULTS.all, C = RESULTS.cold, M = RESULTS.mild;
  const days = RESULTS.days;
  // scatter: revenue difference (smart - fill) vs next-day temperature
  const W = 1100, Ht = 260, L = 60, R = 16, T = 14, B = 36;
  const xs = days.map((d) => d.temps[1]), ys = days.map((d) => d.smart.revenue - d.fill.revenue);
  const xmin = Math.floor(Math.min(...xs) / 5) * 5, xmax = Math.ceil(Math.max(...xs) / 5) * 5;
  const ymin = Math.min(0, ...ys), ymax = Math.max(...ys);
  const X = (v) => L + ((v - xmin) / (xmax - xmin)) * (W - L - R), Y = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (Ht - T - B);
  const yt = [ymin, 0, ymax / 2, ymax].filter((v, i, a) => a.indexOf(v) === i);
  const coldest = days.slice().sort((a, b) => a.temps[1] - b.temps[1]).slice(0, 8);
  app.innerHTML = `
    <div class="page-h"><div><h1>Backtest: two Salt Lake City winters</h1><p>${H.snapshots} board snapshots, one for every day from Nov 1 to Mar 31 in 2024-25 and 2025-26. Each policy plans on a forecast (actual temperature plus ${CONFIG.assumptions.forecastErrorF.join(" / ")}°F error), then ${H.draws_per_snapshot} simulated days per snapshot play out with the actual temperatures. Same inbound callers for every policy.</p></div>
      <div class="actions"><a class="btn" href="#/board"><i data-lucide="arrow-left"></i>Back to board</a><button class="btn" id="dlBt" type="button"><i data-lucide="download"></i>Export CSV</button></div></div>
    <div class="stats">
      <div class="card stat"><div class="k">Revenue per board vs fill every slot</div><div class="v up">+${pct(H.smart_vs_fill_revenue_pct)}</div><div class="d">+${usd(H.smart_vs_fill_revenue_per_board)} per 3-day board on average</div></div>
      <div class="card stat"><div class="k">Callers turned away on cold days</div><div class="v">-${pct(H.cold_turned_away_reduction_pct, 0)}</div><div class="d">${n1(H.cold_turned_away_smart)} vs ${n1(H.cold_turned_away_fill)} per board, ${H.cold_snapshots} days below 25°F</div></div>
      <div class="card stat"><div class="k">vs a fixed 25% emergency reserve</div><div class="v up">+${usd(H.smart_vs_reserve_revenue_per_board)}</div><div class="d">per board; the reserve idles ${n1(A.reserve.idle)} slots on average</div></div>
      <div class="card stat"><div class="k">Outbound calls per board</div><div class="v">${n0(A.smart.calls)}</div><div class="d">vs ${n0(A.fill.calls)} to fill every slot</div></div>
    </div>
    <section class="card"><div class="card-h"><h3>Gain over filling every slot, by next-day temperature</h3><span class="sub">Each dot is one board snapshot</span></div>
      <div class="card-b"><svg class="chart" viewBox="0 0 ${W} ${Ht}" width="100%" role="img" aria-label="Revenue gain per board against next-day temperature">
        ${yt.map((v) => `<line class="gl" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" ${v === 0 ? 'style="stroke:var(--bui-line-strong)"' : ""}/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${usd(v)}</text>`).join("")}
        ${Array.from({ length: (xmax - xmin) / 10 + 1 }, (_, i) => xmin + i * 10).map((v) => `<text x="${X(v)}" y="${Ht - B + 16}" text-anchor="middle">${v}°F</text>`).join("")}
        <text x="${(L + W) / 2}" y="${Ht - 2}" text-anchor="middle">Next-day mean temperature, Salt Lake City (actual)</text>
        ${days.map((d, i) => `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="3.4" fill="${xs[i] < 25 ? "hsl(var(--unbooked))" : "var(--bui-accent)"}" fill-opacity=".7"><title>${d.date}: ${usd(ys[i])}</title></circle>`).join("")}
      </svg><p class="note">Orange: days below 25°F. Weather-aware gains most when it is cold (held slots go to no-heat repairs) and still gains on mild days by choosing higher-value plays and skipping calls that would only overbook.</p></div></section>
    <div class="grid2">
      <section class="card"><div class="card-h"><h3>Averages per board</h3></div><div class="card-b" style="padding:8px 0 4px">
        <table class="table"><thead><tr><th>Policy</th><th class="r">All days</th><th class="r">Cold</th><th class="r">Mild</th><th class="r">Turned away</th><th class="r">Idle</th></tr></thead><tbody>
        ${["fill", "reserve", "smart"].map((p) => `<tr><td style="white-space:nowrap">${POLICIES[p].short}</td><td class="r num">${usd(A[p].revenue)}</td><td class="r num">${usd(C[p].revenue)}</td><td class="r num">${usd(M[p].revenue)}</td><td class="r num">${n1(A[p].turned)}</td><td class="r num">${n1(A[p].idle)}</td></tr>`).join("")}
        </tbody></table><p class="note" style="padding:0 14px">Cold: next day below 25°F (${H.cold_snapshots} snapshots). Mild: 40°F and up (${H.mild_snapshots}). Revenue per 3-day board. It counts turned-away callers who wait for a later day and subtracts call cost.</p></div></section>
      <section class="card"><div class="card-h"><h3>Coldest boards</h3></div><div class="card-b" style="padding:8px 0 4px">
        <table class="table"><thead><tr><th>Date</th><th class="r">Next day</th><th class="r">Turned away: fill all</th><th class="r">Weather-aware</th><th class="r">Gain</th></tr></thead><tbody>
        ${coldest.map((d) => `<tr class="click" data-href="${hrefBoard({ date: d.date, policy: "smart" })}"><td style="white-space:nowrap">${DAYNAME(d.date).split(", ")[1]}, ${d.date.slice(0, 4)}</td><td class="r num">${Math.round(d.temps[1])}°F</td><td class="r num">${n1(d.fill.turned)}</td><td class="r num">${n1(d.smart.turned)}</td><td class="r num up">+${usd(d.smart.revenue - d.fill.revenue)}</td></tr>`).join("")}
        </tbody></table><p class="note" style="padding:0 14px">Click a row to open that morning's board.</p></div></section>
    </div>`;
  app.querySelectorAll("tr[data-href]").forEach((tr) => tr.addEventListener("click", () => { location.hash = tr.dataset.href; }));
  document.getElementById("dlBt").addEventListener("click", () => {
    const lines = ["date,next_day_mean_f,policy,revenue,turned_away,idle,outbound_booked,inbound_served,calls"];
    for (const d of days) for (const p of ["fill", "reserve", "smart"]) lines.push([d.date, d.temps[1], p, d[p].revenue, d[p].turned, d[p].idle, d[p].outBooked, d[p].inServed, d[p].calls].join(","));
    save_("broccoli-autofill-backtest.csv", lines.join("\n"), "text/csv"); toast(`Exported ${days.length * 3} rows`);
  });
  keys.ctx = null;
}

function viewMissing(name) {
  const labels = { dashboard: "Dashboard", calls: "Calls", customers: "Customers", issues: "Issues", analytics: "Analytics", inbound: "Inbound", outbound: "Outbound", "speed-to-lead": "Speed to Lead", qa: "QA & Coaching", settings: "Settings" };
  setNav(name);
  crumbs([{ label: labels[name] || "Not found" }]);
  app.innerHTML = `<div class="page-h"><div><h1>${labels[name] || "Page not found"}</h1><p>This page is part of the Broccoli app and is not reproduced in this concept demo.</p></div></div>
    <section class="card"><div class="empty"><i data-lucide="calendar-range"></i><h4>The demo covers the Board</h4><a class="btn btn-accent" href="#/board" style="margin-top:8px">Open the Board</a></div></section>`;
  keys.ctx = null;
}

// ---------- actions ----------
function dialog(html, onMount) { overlay.innerHTML = `<div class="backdrop" id="bd">${html}</div>`; icons(); document.getElementById("bd").onclick = (e) => { if (e.target.id === "bd") overlay.innerHTML = ""; }; overlay.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => (overlay.innerHTML = ""))); onMount && onMount(); }
function launchDialog(snap, policy, P) {
  dialog(`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="lt"><div class="dh"><div><h2 id="lt">Launch plays</h2><p>${esc(POLICIES[policy].name)} plan for ${esc(CONFIG.company)}</p></div><button class="icon-btn" data-close aria-label="Close"><i data-lucide="x"></i></button></div>
    <div class="db">${P.plays.map((pl, i) => { const c = P.rows.reduce((s, r) => s + r.calls[i], 0); return c ? `<div class="row"><span>${esc(pl.name)}</span><span class="num">${n0(c)} calls</span></div>` : ""; }).join("")}
      <div class="row"><span><b>Expected bookings</b></span><span class="num"><b>${n1(P.totals.outboundBooked)}</b></span></div></div>
    <div class="df"><button class="btn" data-close type="button">Cancel</button><button class="btn btn-accent" id="ok" type="button">Start calling</button></div></div>`, () => {
    const ok = document.getElementById("ok"); ok.focus();
    ok.onclick = () => { store.launched = { date: snap.id, policy, calls: P.totals.calls, booked: P.totals.outboundBooked, at: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) }; save(); overlay.innerHTML = ""; toast(`${n0(P.totals.calls)} calls queued`); render(); };
  });
}
function assumptionsDialog() {
  const a = assumptions();
  const rowsIn = CONFIG.rows.map((r) => `<div class="row"><label for="in_${r.id}">${esc(r.label)} repair ticket</label><input class="field num" id="in_${r.id}" type="number" min="0" step="10" value="${a.inboundValues[r.id]}"></div>`).join("");
  const rowsPl = CONFIG.plays.map((p) => `<div class="row"><label for="pl_${p.id}">${esc(p.name)}</label><input class="field num" id="pl_${p.id}" type="number" min="0" step="10" value="${a.playValues[p.id]}"></div>`).join("");
  dialog(`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="at" style="width:min(560px,calc(100vw - 2rem))"><div class="dh"><div><h2 id="at">Assumptions</h2><p>Value per booked slot and how many turned-away callers you lose. Saved in this browser.</p></div><button class="icon-btn" data-close aria-label="Close"><i data-lucide="x"></i></button></div>
    <div class="db" style="max-height:60vh;overflow:auto">${rowsIn}${rowsPl}
      <div class="row"><label for="loss">Turned-away callers lost to a competitor</label><input class="field num" id="loss" type="number" min="0" max="1" step="0.05" value="${a.lossShare}"></div>
      <div class="row"><label for="cpc">Cost per outbound call ($)</label><input class="field num" id="cpc" type="number" min="0" step="0.05" value="${a.costPerCall}"></div>
      <div class="row"><label for="bud">Outbound call budget per board</label><input class="field num" id="bud" type="number" min="0" step="50" value="${a.callBudget}"></div></div>
    <div class="df"><button class="btn" id="reset" type="button" style="margin-right:auto">Reset</button><button class="btn" data-close type="button">Cancel</button><button class="btn btn-accent" id="ok" type="button">Save</button></div></div>`, () => {
    const v = (id) => Number(document.getElementById(id).value);
    document.getElementById("reset").onclick = () => { delete store.assumptions; save(); cache.clear(); overlay.innerHTML = ""; toast("Assumptions reset"); render(); };
    document.getElementById("ok").onclick = () => {
      const s = { inboundValues: {}, playValues: {}, lossShare: Math.min(1, Math.max(0, v("loss"))), costPerCall: Math.max(0, v("cpc")), callBudget: Math.max(0, Math.round(v("bud"))) };
      for (const r of CONFIG.rows) s.inboundValues[r.id] = Math.max(0, v("in_" + r.id));
      for (const p of CONFIG.plays) s.playValues[p.id] = Math.max(0, v("pl_" + p.id));
      store.assumptions = s; save(); cache.clear(); overlay.innerHTML = ""; toast("Board re-planned with your assumptions"); render();
    };
  });
}
function exportMenu(btn, snap, policy, P) {
  const ex = document.getElementById("menu"); if (ex) { ex.remove(); return; }
  const m = document.createElement("div"); m.className = "menu"; m.id = "menu"; m.setAttribute("role", "menu");
  m.innerHTML = `<button role="menuitem" type="button" data-x="csv"><i data-lucide="file-spreadsheet"></i>Call plan (CSV)</button><button role="menuitem" type="button" data-x="json"><i data-lucide="file-json"></i>Board snapshot (JSON)</button>`;
  btn.parentElement.appendChild(m); icons();
  m.querySelector('[data-x="csv"]').onclick = () => { exportCSV(snap, policy, P); m.remove(); };
  m.querySelector('[data-x="json"]').onclick = () => { exportJSON(snap, policy, P); m.remove(); };
  m.querySelector("button").focus();
}
function exportCSV(snap, policy, P) {
  const lines = ["date,business_unit,day,capacity,booked,open,mean_temp_f,inbound_expected,play,calls,conversion,value"];
  for (const r of P.rows) P.plays.forEach((pl, i) => { if (r.calls[i]) lines.push([snap.dates[r.day], r.row, r.day, r.capacity, r.booked, r.open, r.temp, r.inboundMean.toFixed(2), pl.id, r.calls[i], pl.rate, pl.value].join(",")); });
  save_(`board-${snap.date}-${policy}-plan.csv`, lines.join("\n"), "text/csv"); toast("Exported the call plan");
}
function exportJSON(snap, policy, P) {
  const out = { company: CONFIG.company, policy, snapshot: { date: snap.date, dates: snap.dates, temps_mean_f: snap.temps, source: snap.kind }, assumptions: assumptions(), fit: BOARD.fit,
    totals: P.totals, cells: P.rows.map((r) => ({ id: r.id, capacity: r.capacity, booked: r.booked, open: r.open, temp: r.temp, inbound_expected: r.inboundMean, calls: Object.fromEntries(P.plays.map((p, i) => [p.id, r.calls[i]])), expected: r.ev })) };
  save_(`board-${snap.date}-${policy}.json`, JSON.stringify(out, null, 2), "application/json"); toast("Exported the board snapshot");
}
function save_(name, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function shortcuts() {
  dialog(`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="kt"><div class="dh"><div><h2 id="kt">Keyboard shortcuts</h2></div><button class="icon-btn" data-close aria-label="Close"><i data-lucide="x"></i></button></div><div class="db">
    ${[["1 2 3", "Fill all / 25% reserve / Weather-aware"], ["L", "Launch plays"], ["E", "Export call plan"], ["B", "Backtest"], ["A", "Assumptions"], ["Esc", "Close"]].map(([k, v]) => `<div class="row"><span>${v}</span><span class="kbd">${k}</span></div>`).join("")}</div>
    <div class="df"><button class="btn btn-accent" data-close type="button">Done</button></div></div>`);
}
const keys = { ctx: null };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { overlay.innerHTML = ""; const m = document.getElementById("menu"); if (m) m.remove(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  if (overlay.innerHTML) return;
  if (e.key === "?") shortcuts();
  else if (e.key === "b" || e.key === "B") location.hash = "#/board/backtest";
  else if (e.key === "a" || e.key === "A") assumptionsDialog();
  else if (keys.ctx) {
    const { snap, policy, P } = keys.ctx;
    if (["1", "2", "3"].includes(e.key)) location.hash = hrefBoard({ date: snap.id, policy: ["fill", "reserve", "smart"][Number(e.key) - 1] });
    else if (e.key === "l" || e.key === "L") { const b = document.getElementById("launchBtn"); if (b && !b.disabled) b.click(); }
    else if (e.key === "e" || e.key === "E") exportCSV(snap, policy, P);
  }
});
document.addEventListener("click", (e) => { const m = document.getElementById("menu"); if (m && !e.target.closest(".rel")) m.remove(); });
document.getElementById("kbdHelp").addEventListener("click", shortcuts);

function render() {
  const { parts, params } = route();
  keys.ctx = null;
  try {
    if (parts[0] !== "board") viewMissing(parts[0]);
    else if (parts[1] === "backtest") viewBacktest();
    else if (parts[1] === "cell") viewCell(parts[2], Number(parts[3]), params);
    else viewBoard(params);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="alert alert-red" role="alert"><i data-lucide="circle-alert"></i><div><b>Something went wrong.</b> ${esc(err.message)}</div></div>`;
  }
  icons();
}
let last = "";
window.addEventListener("hashchange", () => { const p = location.hash.split("?")[0]; render(); if (p !== last) { window.scrollTo(0, 0); last = p; } });
async function boot() {
  try {
    const [c, b, r] = await Promise.all(["data/config.json", "data/board.json", "results/results.json"].map((u) => fetch(u)));
    if (!c.ok || !b.ok || !r.ok) throw new Error("data request failed");
    CONFIG = await c.json(); BOARD = await b.json(); RESULTS = await r.json();
    last = location.hash.split("?")[0];
    render();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="alert alert-red" role="alert"><i data-lucide="circle-alert"></i><div><b>Could not load the board.</b> ${esc(err.message)}.</div><div class="actions"><button class="btn btn-sm" type="button" onclick="location.reload()">Retry</button></div></div>`;
    icons();
  }
}
boot();
