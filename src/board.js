// Build a 3-day board for a business from its config, the fitted demand curve and the
// temperatures for t0..t2, then plan it under each policy. Shared by the app and scripts.
import { cellContext, evaluateCell, multiplier, planSmart, planToTarget, protectionLevel } from "./autofill.js";

export const POLICIES = {
  fill: { id: "fill", name: "Fill every open slot", short: "Fill all" },
  reserve: { id: "reserve", name: "Hold 25% for emergencies", short: "25% reserve" },
  smart: { id: "smart", name: "Weather-aware", short: "Weather-aware" },
};

/** Plays sorted by value per booking, highest first (the order the agent works them). */
export function playsOf(config, assumptions = config.assumptions) {
  return config.plays
    .map((p) => ({ ...p, value: assumptions.playValues[p.id] ?? p.value }))
    .sort((a, b) => b.value - a.value);
}

/** Deterministic share of capacity already booked for a row/day on a given date (stand-in for the live board). */
export function bookedShare(config, row, d, dateKey) {
  let h = 2166136261;
  for (const ch of `${dateKey}|${row.id}|${d}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const jitter = ((h >>> 0) / 4294967296 - 0.5) * 0.1;
  return Math.min(0.95, Math.max(0, config.bookedShare[d] + jitter));
}

/** Cells for one board snapshot. temps: [t0, t1, t2] daily mean temperatures (F). */
export function buildCells(config, fit, temps, dateKey, assumptions = config.assumptions) {
  const cells = [];
  for (const row of config.rows) {
    for (let d = 0; d < 3; d++) {
      const booked = Math.round(row.capacity * bookedShare(config, row, d, dateKey));
      const m = multiplier(fit, temps[d], row.weatherStrength);
      const inboundMean = row.inboundBase * config.dayShare[d] * m;
      const inboundValue = assumptions.inboundValues[row.id] ?? row.inboundValue;
      const ctx = cellContext({ open: row.capacity - booked, inboundMean, alpha: fit.alpha, inboundValue, lossShare: assumptions.lossShare });
      cells.push({ id: `${row.id}:${d}`, row: row.id, day: d, capacity: row.capacity, booked, open: row.capacity - booked, temp: temps[d], multiplier: m, inboundMean, inboundValue, ctx });
    }
  }
  return cells;
}

export function audienceOf(config) {
  const a = {};
  for (const row of config.rows) a[row.id] = { ...row.audience };
  return a;
}

/** Plan all cells under a policy; returns per-cell calls and exact expected outcomes. */
export function planBoard(config, cells, policyId, assumptions = config.assumptions) {
  const plays = playsOf(config, assumptions);
  const audience = audienceOf(config);
  const opts = { budget: assumptions.callBudget, costPerCall: assumptions.costPerCall };
  let plan;
  if (policyId === "smart") plan = planSmart(cells, plays, audience, opts);
  else if (policyId === "reserve") plan = planToTarget(cells, plays, audience, (c) => c.open - Math.round(0.25 * c.capacity), opts);
  else if (policyId === "fill") plan = planToTarget(cells, plays, audience, (c) => c.open, opts);
  else plan = cells.map((c) => ({ id: c.id, calls: plays.map(() => 0) }));
  const byId = Object.fromEntries(plan.map((p) => [p.id, p.calls]));
  const rows = cells.map((c) => {
    const calls = byId[c.id];
    const ev = evaluateCell(c.ctx, plays, calls, assumptions.costPerCall);
    const avgOut = plays.reduce((s, p, i) => s + p.value * calls[i] * p.rate, 0) / Math.max(1e-9, plays.reduce((s, p, i) => s + calls[i] * p.rate, 0));
    const protect = Math.min(c.open, protectionLevel(c.inboundMean, c.ctx.alpha, c.ctx.vin, plays.at(-1).value));
    return { ...c, calls, ev, avgOutboundValue: isFinite(avgOut) ? avgOut : 0, protect };
  });
  const sum = (k) => rows.reduce((s, r) => s + r.ev[k], 0);
  return {
    policy: policyId, plays, rows,
    totals: { calls: sum("calls"), outboundBooked: sum("outboundBooked"), outboundRevenue: sum("outboundRevenue"), inboundServed: sum("inboundServed"), turnedAway: sum("inboundTurnedAway"), value: sum("value"), idle: sum("idle") },
  };
}
