// Fit the cold-response curve on real data, plan today's board on the real forecast, and
// backtest three policies over two real Salt Lake City winters.
// node scripts/build.mjs  ->  data/board.json, results/results.json
import { readFileSync, writeFileSync } from "node:fs";
import { fitDemand, rng, normal, simulateCell } from "../src/autofill.js";
import { buildCells, planBoard, playsOf } from "../src/board.js";

const rd = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const config = rd("../data/config.json");
const nyc = rd("../data/raw/nyc311_heat_hot_water_daily.json");
const nycWx = rd("../data/raw/nyc_weather_daily.json").daily;
const slc = rd("../data/raw/slc_weather_daily.json").daily;
const fc = rd("../data/raw/slc_forecast_2026-11-11.json").daily;

// 1. Cold response, fitted on NYC 311 heat complaints (two heating seasons).
const counts = Object.fromEntries(nyc.map((r) => [r.d.slice(0, 10), Number(r.n)]));
const rows = nycWx.time.map((t, i) => ({ t, tMean: nycWx.temperature_2m_mean[i], dow: new Date(t + "T12:00:00Z").getUTCDay(), y: counts[t] }))
  .filter((r) => r.y !== undefined && r.tMean !== null);
const fit = fitDemand(rows);
console.log("fit", fit.n, "days, beta", fit.beta.slice(0, 3).map((b) => b.toFixed(4)).join(" "), "alpha", fit.alpha.toFixed(4), "pseudoR2", fit.pseudoR2.toFixed(3));

// 2. Real Salt Lake City temperatures and today's real forecast.
const slcDays = slc.time.map((t, i) => ({ t, mean: slc.temperature_2m_mean[i], min: slc.temperature_2m_min[i], max: slc.temperature_2m_max[i] })).filter((d) => d.mean !== null);
const today = { date: fc.time[0], temps: fc.temperature_2m_mean.slice(0, 3), mins: fc.temperature_2m_min.slice(0, 3), maxs: fc.temperature_2m_max.slice(0, 3), dates: fc.time.slice(0, 3) };

// 3. Backtest: every winter day Nov 1 - Mar 31 in 2024-25 and 2025-26 is a board snapshot.
const DRAWS = 40;
const POL = ["fill", "reserve", "smart"];
const idx = Object.fromEntries(slcDays.map((d, i) => [d.t, i]));
const winter = slcDays.filter((d) => { const m = Number(d.t.slice(5, 7)); const y = Number(d.t.slice(0, 4)); return (m >= 11 || m <= 3) && d.t >= "2024-11-01" && d.t <= "2026-03-31"; });
const days = [];
for (const d of winter) {
  const i = idx[d.t];
  if (i + 2 >= slcDays.length) continue;
  const actual = [0, 1, 2].map((k) => slcDays[i + k].mean);
  const fr = rng(Number(d.t.replaceAll("-", "")));
  const forecast = actual.map((T, k) => T + config.assumptions.forecastErrorF[k] * normal(fr));
  const planned = Object.fromEntries(POL.map((p) => [p, planBoard(config, buildCells(config, fit, forecast, d.t), p)]));
  const actualCells = buildCells(config, fit, actual, d.t);
  const plays = playsOf(config);
  const out = {};
  for (const p of POL) {
    const acc = { revenue: 0, lost: 0, turned: 0, idle: 0, outBooked: 0, inServed: 0, calls: 0, outRevenue: 0 };
    for (let s = 0; s < DRAWS; s++) {
      const rIn = rng(Number(d.t.replaceAll("-", "")) * 101 + s);
      const rOut = rng(Number(d.t.replaceAll("-", "")) * 103 + s * 7 + POL.indexOf(p));
      actualCells.forEach((c, ci) => {
        const sim = simulateCell({ open: c.open, inboundMean: c.inboundMean, alpha: fit.alpha, inboundValue: c.inboundValue, lossShare: config.assumptions.lossShare }, plays, planned[p].rows[ci].calls, rOut, rIn);
        acc.revenue += sim.revenue; acc.lost += sim.lostRevenue; acc.turned += sim.turnedAway; acc.idle += sim.idle; acc.outBooked += sim.outboundBooked; acc.inServed += sim.inboundServed; acc.outRevenue += sim.outboundRevenue;
      });
    }
    for (const k of Object.keys(acc)) acc[k] /= DRAWS;
    acc.calls = planned[p].totals.calls;
    acc.revenue -= acc.calls * config.assumptions.costPerCall;
    out[p] = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  }
  days.push({ date: d.t, temps: actual.map((x) => Math.round(x * 10) / 10), forecast: forecast.map((x) => Math.round(x * 10) / 10), minT: d.min, ...out });
}
const agg = (list) => Object.fromEntries(POL.map((p) => {
  const k = ["revenue", "lost", "turned", "idle", "outBooked", "inServed", "calls"];
  return [p, Object.fromEntries(k.map((x) => [x, list.reduce((s, d) => s + d[p][x], 0) / list.length]))];
}));
const cold = days.filter((d) => d.temps[1] < 25);
const mild = days.filter((d) => d.temps[1] >= 40);
const all = agg(days), coldA = agg(cold), mildA = agg(mild);
const pct = (a, b) => (a - b) / b;
const headline = {
  snapshots: days.length, draws_per_snapshot: DRAWS, cold_snapshots: cold.length, mild_snapshots: mild.length,
  smart_vs_fill_revenue_per_board: all.smart.revenue - all.fill.revenue,
  smart_vs_fill_revenue_pct: pct(all.smart.revenue, all.fill.revenue),
  smart_vs_reserve_revenue_per_board: all.smart.revenue - all.reserve.revenue,
  cold_turned_away_fill: coldA.fill.turned, cold_turned_away_smart: coldA.smart.turned,
  cold_turned_away_reduction_pct: 1 - coldA.smart.turned / coldA.fill.turned,
  cold_smart_vs_fill_revenue_per_board: coldA.smart.revenue - coldA.fill.revenue,
  mild_smart_vs_fill_revenue_per_board: mildA.smart.revenue - mildA.fill.revenue,
  mild_smart_vs_reserve_revenue_per_board: mildA.smart.revenue - mildA.reserve.revenue,
};
writeFileSync(new URL("../data/board.json", import.meta.url), JSON.stringify({ fit, today, history: slcDays.map((d) => [d.t, d.mean, d.min, d.max]), sources: {
  demand_shape: "NYC Open Data 311 Service Requests (erm2-nwe9), complaint_type HEAT/HOT WATER, daily counts Oct 1 2024 - Apr 30 2026",
  weather: "Open-Meteo archive (ERA5) daily temperatures for New York City and Salt Lake City; Open-Meteo forecast for Salt Lake City fetched Nov 11 2026",
  plays: "Broccoli board play templates and expected conversion rates (production web bundle)",
} }));
writeFileSync(new URL("../results/results.json", import.meta.url), JSON.stringify({ generated: "scripts/build.mjs", fit: { beta: fit.beta, alpha: fit.alpha, n: fit.n, pseudoR2: fit.pseudoR2 }, headline, all, cold: coldA, mild: mildA, days }));
console.log(JSON.stringify({ headline, all }, null, 1));
