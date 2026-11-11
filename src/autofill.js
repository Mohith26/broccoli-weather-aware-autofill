// Weather-aware autofill for the Broccoli Board.
//
// The autofill agent books outbound plays (tune-ups, open estimates, rebookings) into
// open slots. Every slot it fills today is a slot an inbound caller cannot get tomorrow.
// On a cold morning that trade is bad: a no-heat repair is worth several tune-ups, and a
// caller who cannot get a slot calls a competitor. This module decides, per business unit
// and day, how many outbound calls of each play to place, given a weather-driven forecast
// of the inbound demand still to come.
//
// 1. Demand: a Poisson GLM with a negative-binomial dispersion, fitted by IRLS on real
//    daily counts (NYC 311 "HEAT/HOT WATER" complaints vs. daily mean temperature), gives
//    the shape of the cold response: multiplier m(T) = exp(f(T) - f(45 F)).
// 2. Value: for one board cell with R open slots, outbound bookings O (sum of binomials,
//    one per play) take slots first; inbound demand D ~ NB(mu, alpha) takes what is left.
//    Expected value = sum_p v_p * E[play-p bookings that got a slot]
//                   + v_in * L * E[min(D, (R - O)+)]   (L: share of turned-away callers lost)
//                   - cost_per_call * calls.
//    Both terms are computed exactly on the integer lattice.
// 3. Plan: greedy marginal-value allocation of single calls across cells and plays, under
//    per-play audience limits and a daily call budget. In one cell with one play the
//    objective is concave in the number of calls, so greedy is optimal (tested against
//    brute force); across plays it is a strong heuristic (also tested).
//
// Pure functions, no dependencies; runs in the browser and in Node.

// ---------- numerics ----------
const LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = LG[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LG[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Negative-binomial pmf with mean mu and dispersion alpha (Var = mu + alpha mu^2), for y = 0..max. */
export function nbPmf(mu, alpha, max) {
  const out = new Float64Array(max + 1);
  if (mu <= 0) { out[0] = 1; return out; }
  if (alpha <= 1e-9) {
    let p = Math.exp(-mu);
    out[0] = p;
    for (let y = 1; y <= max; y++) { p *= mu / y; out[y] = p; }
    return out;
  }
  const k = 1 / alpha, p = k / (k + mu), lp = Math.log(p), lq = Math.log1p(-p), lk = lgamma(k);
  for (let y = 0; y <= max; y++) out[y] = Math.exp(lgamma(y + k) - lk - lgamma(y + 1) + k * lp + y * lq);
  return out;
}

/** Table t[k] = E[min(D, k)] for k = 0..R, D ~ NB(mu, alpha). */
export function expectedMinTable(mu, alpha, R) {
  const max = Math.max(R, Math.ceil(mu + 12 * Math.sqrt(mu + alpha * mu * mu) + 20));
  const pmf = nbPmf(mu, alpha, max);
  const t = new Float64Array(R + 1);
  let cdf = 0;
  for (let k = 1; k <= R; k++) { cdf += pmf[k - 1]; t[k] = t[k - 1] + (1 - cdf); } // E[min(D,k)] = sum_{j<k} P(D>j)
  return t;
}

// ---------- demand model ----------
const HREF = 45;
/** Heating feature: degrees below 65 F, in tens of degrees. */
export const heat = (tMean) => Math.max(0, 65 - tMean) / 10;

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * Poisson GLM by IRLS with features [1, h, h^2, day-of-week dummies], then the NB2
 * dispersion alpha by the method of moments on the Pearson residuals.
 * rows: [{ tMean, dow (0 = Sunday), y }]
 */
export function fitDemand(rows, iters = 40) {
  const X = rows.map((r) => { const h = heat(r.tMean); const d = [0, 0, 0, 0, 0, 0]; if (r.dow > 0) d[r.dow - 1] = 1; return [1, h, h * h, ...d]; });
  const y = rows.map((r) => r.y);
  const p = X[0].length;
  let beta = new Array(p).fill(0);
  beta[0] = Math.log(y.reduce((a, b) => a + b, 0) / y.length);
  for (let it = 0; it < iters; it++) {
    const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
    for (let i = 0; i < X.length; i++) {
      const eta = X[i].reduce((s, x, j) => s + x * beta[j], 0), mu = Math.exp(eta);
      const z = eta + (y[i] - mu) / mu;
      for (let j = 0; j < p; j++) { b[j] += X[i][j] * mu * z; for (let k = 0; k < p; k++) A[j][k] += X[i][j] * mu * X[i][k]; }
    }
    const nb = solve(A, b);
    const delta = Math.max(...nb.map((v, j) => Math.abs(v - beta[j])));
    beta = nb;
    if (delta < 1e-10) break;
  }
  const mus = X.map((x) => Math.exp(x.reduce((s, v, j) => s + v * beta[j], 0)));
  const alpha = Math.max(0, mus.reduce((s, mu, i) => s + ((y[i] - mu) ** 2 - mu) / (mu * mu), 0) / mus.length);
  // Deviance-based pseudo R^2 against the intercept-only model, for reporting.
  const ybar = y.reduce((a, b) => a + b, 0) / y.length;
  const dev = (m) => 2 * y.reduce((s, yi, i) => s + (yi > 0 ? yi * Math.log(yi / m[i]) : 0) - (yi - m[i]), 0);
  const r2 = 1 - dev(mus) / dev(y.map(() => ybar));
  return { beta, alpha, n: rows.length, pseudoR2: r2 };
}

/** Demand multiplier relative to a 45 F day; `strength` scales the log-response (1 = as fitted, 0 = flat). */
export function multiplier(fit, tMean, strength = 1) {
  const h = heat(tMean), h0 = heat(HREF);
  return Math.exp(strength * (fit.beta[1] * (h - h0) + fit.beta[2] * (h * h - h0 * h0)));
}

// ---------- one board cell ----------
/** Push one more call with conversion r into the outbound-bookings pmf q (lumped at R). */
function addCall(q, r) {
  const R = q.length - 1, out = new Float64Array(R + 1);
  for (let o = 0; o <= R; o++) {
    if (o === R) { out[R] += q[R]; continue; }
    out[o] += q[o] * (1 - r);
    out[o + 1] += q[o] * r;
  }
  return out;
}
const inboundTerm = (q, emin) => { let s = 0; const R = q.length - 1; for (let o = 0; o <= R; o++) s += q[o] * emin[R - o]; return s; };

/** Cell context: open slots R, inbound value per served call, and the E[min(D,k)] table. */
export function cellContext({ open, inboundMean, alpha, inboundValue, lossShare }) {
  const R = Math.max(0, open);
  return { R, vin: inboundValue * lossShare, inboundValue, lossShare, emin: expectedMinTable(inboundMean, alpha, R), inboundMean, alpha };
}

/** Exact expected outcome of placing `calls[p]` calls of each play into one cell. */
export function evaluateCell(ctx, plays, calls, costPerCall = 0) {
  let q = new Float64Array(ctx.R + 1); q[0] = 1;
  let outRev = 0, outBooked = 0, n = 0;
  // Calls are taken in play order (plays are listed highest value first), matching simulateCell.
  plays.forEach((pl, i) => {
    for (let c = 0; c < (calls[i] || 0); c++) {
      const free = ctx.R ? 1 - q[ctx.R] : 0;
      outRev += pl.value * pl.rate * free; outBooked += pl.rate * free; n++;
      q = addCall(q, pl.rate);
    }
  });
  const inServed = inboundTerm(q, ctx.emin);
  const inAll = ctx.inboundMean;
  return {
    calls: n, outboundBooked: outBooked, outboundRevenue: outRev,
    inboundServed: inServed, inboundTurnedAway: inAll - inServed,
    value: outRev + ctx.vin * inServed - costPerCall * n,
    idle: ctx.R - outBooked - inServed,
  };
}

// ---------- planning ----------
/**
 * Greedy plan over many cells. cells: [{ id, row, ctx }], plays: [{ id, rate, value }],
 * audience: { [row]: { [playId]: size } } shared across a row's days, budget: max calls.
 * policy: "smart" (marginal value), or a fixed fill target per cell via targetFn.
 */
export function planSmart(cells, plays, audience, { budget = Infinity, costPerCall = 0 } = {}) {
  const st = cells.map((c) => { const q = new Float64Array(c.ctx.R + 1); q[0] = 1; return { c, q, calls: plays.map(() => 0) }; });
  const left = {};
  for (const c of cells) left[c.row] = left[c.row] || { ...audience[c.row] };
  let used = 0;
  const gain = (s, pl) => {
    const R = s.c.ctx.R;
    if (R === 0) return -Infinity;
    const free = 1 - s.q[R];
    const q2 = addCall(s.q, pl.rate);
    return pl.value * pl.rate * free + s.c.ctx.vin * (inboundTerm(q2, s.c.ctx.emin) - inboundTerm(s.q, s.c.ctx.emin)) - costPerCall;
  };
  // Cache gains; only the cell that changed needs recomputing.
  const g = st.map((s) => plays.map((pl) => gain(s, pl)));
  while (used < budget) {
    let best = -1, bi = -1, bp = -1;
    for (let i = 0; i < st.length; i++) for (let p = 0; p < plays.length; p++) {
      if (!(left[st[i].c.row][plays[p].id] > 0)) continue;
      if (g[i][p] > best) { best = g[i][p]; bi = i; bp = p; }
    }
    if (bi < 0 || best <= 0) break;
    const s = st[bi];
    s.q = addCall(s.q, plays[bp].rate); s.calls[bp]++; left[s.c.row][plays[bp].id]--; used++;
    g[bi] = plays.map((pl) => gain(s, pl));
  }
  return st.map((s) => ({ id: s.c.id, calls: s.calls }));
}

/**
 * Fill-to-target baseline: plays in order of expected value per call (rate x value), so the
 * baseline already prefers valuable plays, until expected bookings reach the target.
 */
export function planToTarget(cells, plays, audience, targetFn, { budget = Infinity } = {}) {
  const order = plays.map((p, i) => i).sort((a, b) => plays[b].rate * plays[b].value - plays[a].rate * plays[a].value);
  const left = {};
  for (const c of cells) left[c.row] = left[c.row] || { ...audience[c.row] };
  let used = 0;
  return cells.map((c) => {
    const calls = plays.map(() => 0);
    let need = Math.max(0, targetFn(c));
    for (const i of order) {
      if (need <= 1e-9 || used >= budget) break;
      const pl = plays[i];
      const n = Math.min(left[c.row][pl.id] || 0, Math.ceil(need / pl.rate - 1e-9), budget - used);
      calls[i] += n; left[c.row][pl.id] -= n; used += n; need -= n * pl.rate;
    }
    return { id: c.id, calls };
  });
}

/** Littlewood-style protection level: the smallest y with P(D > y) * v_in * L <= average outbound value. */
export function protectionLevel(mu, alpha, inboundValueEff, outboundValue, cap = 200) {
  const pmf = nbPmf(mu, alpha, cap);
  let tail = 1;
  for (let y = 0; y <= cap; y++) {
    tail -= pmf[y]; // P(D > y)
    if (tail * inboundValueEff <= outboundValue) return y;
  }
  return cap;
}

// ---------- simulation ----------
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function normal(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function gammaSample(k, r) { // Marsaglia-Tsang
  if (k < 1) return gammaSample(k + 1, r) * Math.pow(r(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = normal(r); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = r(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
function poissonSample(mu, r) { if (mu > 60) return Math.max(0, Math.round(mu + Math.sqrt(mu) * normal(r))); let L = Math.exp(-mu), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }
export function nbSample(mu, alpha, r) { if (mu <= 0) return 0; if (alpha <= 1e-9) return poissonSample(mu, r); const k = 1 / alpha; return poissonSample(gammaSample(k, r) * mu / k, r); }
export function binomSample(n, p, r) { let s = 0; for (let i = 0; i < n; i++) if (r() < p) s++; return s; }

/**
 * Realized outcome of a cell for one draw. Outbound bookings take slots first, in play
 * order (the agent works the highest-value plays first); bookings beyond the open slots
 * are offered another day and earn nothing here. Then inbound demand takes what is left.
 * rOut drives the outbound coin flips, rIn the inbound demand, so policies compared on
 * the same rIn seed face the same inbound calls.
 */
export function simulateCell({ open, inboundMean, alpha, inboundValue, lossShare }, plays, calls, rOut, rIn) {
  let free = Math.max(0, open), outRev = 0, booked = 0;
  plays.forEach((pl, i) => {
    const b = binomSample(calls[i] || 0, pl.rate, rOut);
    const take = Math.min(b, free);
    free -= take; booked += take; outRev += take * pl.value;
  });
  const D = nbSample(inboundMean, alpha, rIn);
  const inServed = Math.min(D, free);
  const turned = D - inServed;
  return {
    outboundBooked: booked, outboundRevenue: outRev, inboundDemand: D, inboundServed: inServed, turnedAway: turned,
    revenue: outRev + inboundValue * (inServed + (1 - lossShare) * turned),
    lostRevenue: inboundValue * lossShare * turned,
    idle: free - inServed,
  };
}
