import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  binomSample, cellContext, evaluateCell, expectedMinTable, fitDemand, heat, multiplier, nbPmf, nbSample,
  planSmart, planToTarget, protectionLevel, rng, simulateCell,
} from "../src/autofill.js";
import { buildCells, planBoard, playsOf } from "../src/board.js";

const rd = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const config = rd("../data/config.json");
const board = rd("../data/board.json");
const results = rd("../results/results.json");

test("nbPmf sums to one and has the right mean and variance", () => {
  for (const [mu, a] of [[3, 0], [12, 0.27], [40, 0.1]]) {
    const p = nbPmf(mu, a, 600);
    const s = p.reduce((x, y) => x + y, 0), m = p.reduce((x, y, k) => x + k * y, 0), v = p.reduce((x, y, k) => x + (k - m) ** 2 * y, 0);
    assert.ok(Math.abs(s - 1) < 1e-9, `sum ${s}`);
    assert.ok(Math.abs(m - mu) < 1e-6 * mu + 1e-9, `mean ${m}`);
    assert.ok(Math.abs(v - (mu + a * mu * mu)) < 1e-4 * v, `var ${v}`);
  }
});

test("expectedMinTable matches a direct expectation", () => {
  const mu = 9, a = 0.27, R = 20, p = nbPmf(mu, a, 800), t = expectedMinTable(mu, a, R);
  for (const k of [0, 1, 5, 9, 20]) {
    const direct = p.reduce((s, q, y) => s + q * Math.min(y, k), 0);
    assert.ok(Math.abs(t[k] - direct) < 1e-9, `k=${k}`);
  }
});

test("demand fit on the real NYC 311 data: strong cold response, good fit", () => {
  const f = board.fit;
  assert.equal(f.n, 577);
  assert.ok(f.beta[1] > 0.5, "more heat complaints when colder");
  assert.ok(f.pseudoR2 > 0.75);
  assert.ok(multiplier(f, 15) > multiplier(f, 35) && multiplier(f, 35) > multiplier(f, 55));
  assert.ok(Math.abs(multiplier(f, 45) - 1) < 1e-12);
  assert.equal(multiplier(f, 10, 0), 1, "strength 0 is flat");
  assert.equal(heat(70), 0);
});

test("fitDemand recovers known coefficients from synthetic Poisson data", () => {
  const r = rng(7), rows = [];
  for (let i = 0; i < 3000; i++) {
    const tMean = 10 + 55 * r(), dow = i % 7, h = heat(tMean);
    const mu = Math.exp(3 + 0.6 * h - 0.03 * h * h + (dow === 0 ? -0.2 : 0));
    rows.push({ tMean, dow, y: nbSample(mu, 0, r) });
  }
  const f = fitDemand(rows);
  assert.ok(Math.abs(f.beta[0] - 2.8) < 0.1, `intercept ${f.beta[0]}`); // Sunday is the reference level (dummies for Mon-Sat absorb +0.2)
  assert.ok(Math.abs(f.beta[1] - 0.6) < 0.05, `h ${f.beta[1]}`);
  assert.ok(Math.abs(f.beta[2] + 0.03) < 0.01, `h2 ${f.beta[2]}`);
  assert.ok(f.alpha < 0.02, "Poisson data shows almost no extra dispersion");
});

test("evaluateCell matches Monte Carlo simulation of the same plan", () => {
  const ctx = cellContext({ open: 12, inboundMean: 8, alpha: 0.27, inboundValue: 500, lossShare: 0.6 });
  const plays = [{ id: "a", rate: 0.1, value: 600 }, { id: "b", rate: 0.12, value: 150 }];
  const calls = [30, 40];
  const ev = evaluateCell(ctx, plays, calls);
  const rOut = rng(1), rIn = rng(2);
  let out = 0, served = 0;
  const N = 40000;
  for (let i = 0; i < N; i++) { const s = simulateCell({ open: 12, inboundMean: 8, alpha: 0.27, inboundValue: 500, lossShare: 0.6 }, plays, calls, rOut, rIn); out += s.outboundRevenue; served += s.inboundServed; }
  assert.ok(Math.abs(out / N - ev.outboundRevenue) / ev.outboundRevenue < 0.02, `outbound ${out / N} vs ${ev.outboundRevenue}`);
  assert.ok(Math.abs(served / N - ev.inboundServed) / ev.inboundServed < 0.02, `inbound ${served / N} vs ${ev.inboundServed}`);
});

test("property: in one cell with one play, greedy equals the brute-force optimum", () => {
  const r = rng(11);
  for (let t = 0; t < 40; t++) {
    const open = 1 + Math.floor(r() * 15), mu = r() * 20, vin = 200 + r() * 600, rate = 0.03 + r() * 0.25, value = 80 + r() * 600, aud = Math.floor(r() * 120);
    const ctx = cellContext({ open, inboundMean: mu, alpha: 0.2, inboundValue: vin, lossShare: 0.6 });
    const plays = [{ id: "p", rate, value }];
    const g = planSmart([{ id: "c", row: "x", ctx }], plays, { x: { p: aud } }, { costPerCall: 0.35 })[0].calls[0];
    let best = -Infinity, bestN = 0;
    for (let n = 0; n <= aud; n++) { const v = evaluateCell(ctx, plays, [n], 0.35).value; if (v > best + 1e-9) { best = v; bestN = n; } }
    assert.ok(Math.abs(evaluateCell(ctx, plays, [g], 0.35).value - best) < 1e-6, `trial ${t}: greedy ${g} vs best ${bestN}`);
  }
});

test("property: greedy across plays is within 1% of brute force on small random cells", () => {
  const r = rng(23);
  for (let t = 0; t < 15; t++) {
    const open = 2 + Math.floor(r() * 6), ctx = cellContext({ open, inboundMean: r() * 8, alpha: 0.2, inboundValue: 400, lossShare: 0.6 });
    const plays = [{ id: "a", rate: 0.1, value: 600 }, { id: "b", rate: 0.15, value: 300 }].sort((x, y) => y.value - x.value);
    const g = planSmart([{ id: "c", row: "x", ctx }], plays, { x: { a: 25, b: 25 } })[0].calls;
    const gv = evaluateCell(ctx, plays, g).value;
    let best = -Infinity;
    for (let a = 0; a <= 25; a++) for (let b = 0; b <= 25; b++) best = Math.max(best, evaluateCell(ctx, plays, [a, b]).value);
    assert.ok(gv >= best * 0.99 - 1e-9, `trial ${t}: ${gv} vs ${best}`);
  }
});

test("the planner holds slots on cold days and fills them on warm days", () => {
  const plays = [{ id: "tune", rate: 0.12, value: 150 }];
  const calls = (temp) => {
    const mu = 9 * 0.9 * multiplier(board.fit, temp);
    const ctx = cellContext({ open: 18, inboundMean: mu, alpha: board.fit.alpha, inboundValue: 520, lossShare: 0.6 });
    return planSmart([{ id: "c", row: "x", ctx }], plays, { x: { tune: 1000 } })[0].calls[0];
  };
  assert.ok(calls(15) < calls(45) && calls(45) < calls(65), `${calls(15)} ${calls(45)} ${calls(65)}`);
  assert.equal(calls(5), 0);
});

test("protectionLevel follows Littlewood's rule", () => {
  const mu = 10, a = 0.2, vin = 300, vout = 150;
  const y = protectionLevel(mu, a, vin, vout);
  const p = nbPmf(mu, a, 400);
  const tail = (k) => 1 - p.slice(0, k + 1).reduce((s, x) => s + x, 0);
  assert.ok(tail(y) * vin <= vout + 1e-12);
  assert.ok(y === 0 || tail(y - 1) * vin > vout);
  assert.equal(protectionLevel(mu, a, 100, 150), 0, "never protect when outbound is worth more");
});

test("planToTarget respects audience, budget and targets", () => {
  const plays = [{ id: "a", rate: 0.1, value: 600 }, { id: "b", rate: 0.12, value: 150 }];
  const ctx = cellContext({ open: 10, inboundMean: 3, alpha: 0.2, inboundValue: 500, lossShare: 0.6 });
  const plan = planToTarget([{ id: "c1", row: "x", ctx, open: 10 }, { id: "c2", row: "x", ctx, open: 10 }], plays, { x: { a: 50, b: 1000 } }, (c) => c.open, { budget: 120 });
  const a = plan.reduce((s, p) => s + p.calls[0], 0), total = plan.reduce((s, p) => s + p.calls[0] + p.calls[1], 0);
  assert.ok(a <= 50 && total <= 120);
  assert.equal(plan[0].calls[0], 50, "the higher value-per-call play goes first");
});

test("binomSample and nbSample have the right means", () => {
  const r = rng(5);
  let b = 0, n = 0;
  for (let i = 0; i < 20000; i++) { b += binomSample(20, 0.15, r); n += nbSample(6, 0.3, r); }
  assert.ok(Math.abs(b / 20000 - 3) < 0.05);
  assert.ok(Math.abs(n / 20000 - 6) < 0.1);
});

test("board planning: weather-aware beats both baselines on every policy comparison today and on the coldest day", () => {
  for (const date of ["today", "2025-01-19"]) {
    let temps;
    if (date === "today") temps = board.today.temps;
    else { const i = board.history.findIndex((h) => h[0] === date); temps = [0, 1, 2].map((k) => board.history[i + k][1]); }
    const cells = buildCells(config, board.fit, temps, date === "today" ? board.today.date : date);
    const v = Object.fromEntries(["fill", "reserve", "smart"].map((p) => [p, planBoard(config, cells, p).totals.value]));
    assert.ok(v.smart >= v.fill && v.smart >= v.reserve, `${date}: ${JSON.stringify(v)}`);
  }
  assert.deepEqual(playsOf(config).map((p) => p.value), [600, 340, 320, 190, 150]);
});

test("headline numbers in results.json are consistent with the per-day rows", () => {
  const h = results.headline, d = results.days;
  assert.equal(h.snapshots, d.length);
  const mean = (p) => d.reduce((s, x) => s + x[p].revenue, 0) / d.length;
  assert.ok(Math.abs(h.smart_vs_fill_revenue_per_board - (mean("smart") - mean("fill"))) < 1e-6);
  assert.ok(Math.abs(h.smart_vs_fill_revenue_pct - (mean("smart") - mean("fill")) / mean("fill")) < 1e-9);
  const cold = d.filter((x) => x.temps[1] < 25);
  assert.equal(cold.length, h.cold_snapshots);
  assert.ok(h.smart_vs_fill_revenue_pct > 0.05, "a clear gain");
  assert.ok(h.cold_turned_away_reduction_pct > 0.3, "far fewer turned-away callers on cold days");
  assert.ok(h.smart_vs_reserve_revenue_per_board > 0, "also beats a fixed reserve");
});
