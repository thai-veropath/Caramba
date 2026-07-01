/* ============================================================================
 * Caramba event-based billiards engine — faithful JS port of pooltool physics.
 *
 * - Analytic ball motion between events (no dt integration error):
 *     SLIDING  : parabolic trajectory, fixed slip direction (exact solution)
 *     ROLLING  : straight line, linear deceleration
 *     SPINNING : stationary, z-spin decays linearly
 * - Event detection:
 *     ball-ball        : quartic polynomial roots
 *     ball-cushion     : quadratic roots (axis-aligned rails)
 *     state transition : closed-form durations
 * - Resolvers:
 *     strike       : instantaneous-point cue strike + squirt (TP A-30/A-31)
 *     ball-ball    : frictional inelastic w/ Alciatore speed-dependent friction
 *     ball-cushion : Mathavan et al. 2010 numerical impulse integration
 *
 * All units SI: meters, kg, seconds, rad/s.
 * ==========================================================================*/
'use strict';

// ----------------------------- Parameters ---------------------------------
const g = 9.81;
const BALL = {
  R: 0.03075,          // carom ball radius (61.5 mm diameter)
  m: 0.210,            // kg
  u_s: 0.2,            // ball-cloth sliding friction
  u_r: 0.01,           // rolling resistance
  u_sp_prop: 10 * 2 / (5 * 9),   // u_sp = prop * R (pooltool default)
  e_b: 0.96,           // ball-ball restitution (phenolic)
  e_c: 0.98,           // ball-cushion restitution (Mathavan 2010 measured)
  f_c: 0.14,           // ball-cushion sliding friction (Mathavan 2010 measured)
};
BALL.u_sp = BALL.u_sp_prop * BALL.R;
const CUE = { M: 0.567, end_mass: 0.170097 / 30 };
const TABLE = { W: 1.42, L: 2.84, h: 0.037 };   // playfield + cushion nose height
const STATIONARY = 0, SPINNING = 1, SLIDING = 2, ROLLING = 3;
const EPS = 2.220446049250313e-14;   // ~ np.finfo(float).eps * 100

// ----------------------------- Vector helpers ------------------------------
const hyp = Math.hypot;
function angleOf(x, y) { const a = Math.atan2(y, x); return a < 0 ? a + 2 * Math.PI : a; }
function rot2(x, y, phi) { const c = Math.cos(phi), s = Math.sin(phi); return [c * x - s * y, s * x + c * y]; }
// cross product for 3-vectors
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Ball object: {x,y, vx,vy, wx,wy,wz, state}
function relVelocity(b) {           // slip of contact point w.r.t. cloth
  return [b.vx - BALL.R * b.wy, b.vy + BALL.R * b.wx];
}
function getSlideTime(b) {
  const u = relVelocity(b); const n = hyp(u[0], u[1]);
  return BALL.u_s === 0 ? Infinity : 2 * n / (7 * BALL.u_s * g);
}
function getRollTime(b) {
  return BALL.u_r === 0 ? Infinity : hyp(b.vx, b.vy) / (BALL.u_r * g);
}
function getSpinTime(b) {
  return BALL.u_sp === 0 ? Infinity : Math.abs(b.wz) * 2 / 5 * BALL.R / (BALL.u_sp * g);
}

// ----------------------------- Analytic evolution --------------------------
function evolvePerpSpin(wz, t) {
  if (t === 0 || Math.abs(wz) < EPS) return wz;
  const alpha = 5 * BALL.u_sp * g / (2 * BALL.R);
  const tmax = Math.abs(wz) / alpha;
  if (t > tmax) t = tmax;
  return wz - Math.sign(wz) * alpha * t;
}

function evolveSlide(b, t) {
  if (t === 0) return { ...b };
  const R = BALL.R, u_s = BALL.u_s;
  const phi = angleOf(b.vx, b.vy);
  // rotate state into ball frame (-phi)
  const [vBx, vBy] = rot2(b.vx, b.vy, -phi);
  const [wBx, wBy] = rot2(b.wx, b.wy, -phi);
  const rv = relVelocity(b); const rn = hyp(rv[0], rv[1]);
  let u0x = 1, u0y = 0;
  if (rn > 0) { const [ux, uy] = rot2(rv[0] / rn, rv[1] / rn, -phi); u0x = ux; u0y = uy; }
  // position (ball frame)
  const pBx = vBx * t - 0.5 * u_s * g * t * t * u0x;
  const pBy = -0.5 * u_s * g * t * t * u0y;
  // velocity
  const nvBx = vBx - u_s * g * t * u0x;
  const nvBy = vBy - u_s * g * t * u0y;
  // angular velocity: w_B -= 5/(2R) u_s g t * (u0 x zhat);  u0 x zhat = (u0y, -u0x)
  const nwBx = wBx - 5 / (2 * R) * u_s * g * t * u0y;
  const nwBy = wBy - 5 / (2 * R) * u_s * g * t * (-u0x);
  // rotate back
  const [px, py] = rot2(pBx, pBy, phi);
  const [nvx, nvy] = rot2(nvBx, nvBy, phi);
  const [nwx, nwy] = rot2(nwBx, nwBy, phi);
  return {
    x: b.x + px, y: b.y + py, vx: nvx, vy: nvy,
    wx: nwx, wy: nwy, wz: evolvePerpSpin(b.wz, t), state: SLIDING,
  };
}

function evolveRoll(b, t) {
  if (t === 0) return { ...b };
  const sp = hyp(b.vx, b.vy);
  const hx = b.vx / sp, hy = b.vy / sp;
  const dec = BALL.u_r * g;
  const x = b.x + b.vx * t - 0.5 * dec * t * t * hx;
  const y = b.y + b.vy * t - 0.5 * dec * t * t * hy;
  const vx = b.vx - dec * t * hx, vy = b.vy - dec * t * hy;
  // w = rot(v/R, +90deg) -> (-vy/R, vx/R)
  return {
    x, y, vx, vy, wx: -vy / BALL.R, wy: vx / BALL.R,
    wz: evolvePerpSpin(b.wz, t), state: ROLLING,
  };
}

// Chained evolution matching pooltool's evolve_ball_motion.
function evolveBall(b, t) {
  let cur = { ...b };
  if (cur.state === STATIONARY) return cur;
  if (cur.state === SLIDING) {
    const dtau = getSlideTime(cur);
    if (t >= dtau) { cur = evolveSlide(cur, dtau); cur.state = ROLLING; t -= dtau; }
    else return evolveSlide(cur, t);
  }
  if (cur.state === ROLLING) {
    const dtau = getRollTime(cur);
    if (t >= dtau) { cur = evolveRoll(cur, dtau); cur.state = SPINNING; cur.vx = 0; cur.vy = 0; cur.wx = 0; cur.wy = 0; t -= dtau; }
    else return evolveRoll(cur, t);
  }
  if (cur.state === SPINNING) {
    const dtau = getSpinTime(cur);
    if (t >= dtau) { cur.wz = evolvePerpSpin(cur.wz, dtau); cur.state = STATIONARY; }
    else cur.wz = evolvePerpSpin(cur.wz, t);
    return cur;
  }
  return cur;
}

// ----------------------------- Root solving --------------------------------
// Quadratic (complex-safe, real coefficients) -> array of real roots
function quadRoots(a, b, c) {
  if (Math.abs(a) < 1e-300) {
    if (Math.abs(b) < 1e-300) return [];
    return [-c / b];
  }
  const d = b * b - 4 * a * c;
  if (d < 0) return [];
  const sq = Math.sqrt(d);
  const q = -(b + Math.sign(b || 1) * sq) / 2;
  const r1 = q / a;
  const r2 = Math.abs(q) > 1e-300 ? c / q : (-b + sq) / (2 * a);
  return [r1, r2];
}

// Durand-Kerner: all complex roots of real-coefficient polynomial (ascending order not required).
// coeffs: [a_n, ..., a_1, a_0] descending powers. Returns [[re,im],...]
function polyRootsDK(coeffs) {
  // strip leading ~zero coefficients (degree reduction)
  let cs = coeffs.slice();
  const scale = Math.max(...cs.map(Math.abs)) || 1;
  while (cs.length > 1 && Math.abs(cs[0]) < 1e-14 * scale) cs.shift();
  const n = cs.length - 1;
  if (n <= 0) return [];
  if (n === 1) return [[-cs[1] / cs[0], 0]];
  if (n === 2) {
    const [a, b, c] = cs; const d = b * b - 4 * a * c;
    if (d >= 0) { const sq = Math.sqrt(d); return [[(-b + sq) / (2 * a), 0], [(-b - sq) / (2 * a), 0]]; }
    const sq = Math.sqrt(-d); return [[-b / (2 * a), sq / (2 * a)], [-b / (2 * a), -sq / (2 * a)]];
  }
  // normalize monic
  const a0 = cs[0]; const p = cs.map(c => c / a0);
  // initial guesses on a circle
  const roots = [];
  const radius = 1 + Math.max(...p.slice(1).map(Math.abs));
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n + 0.4;
    roots.push([radius * Math.cos(th), radius * Math.sin(th)]);
  }
  const evalP = (re, im) => {
    let pr = 1, pi = 0;   // accumulates value via Horner
    let vr = p[0], vi = 0;
    for (let i = 1; i <= n; i++) {
      const nr = vr * re - vi * im + p[i];
      const ni = vr * im + vi * re;
      vr = nr; vi = ni;
    }
    return [vr, vi];
  };
  for (let iter = 0; iter < 120; iter++) {
    let maxd = 0;
    for (let i = 0; i < n; i++) {
      const [ri, ii] = roots[i];
      let [nr, ni] = evalP(ri, ii);
      // denominator: prod (x_i - x_j)
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const ar = ri - roots[j][0], ai = ii - roots[j][1];
        const t1 = dr * ar - di * ai, t2 = dr * ai + di * ar;
        dr = t1; di = t2;
      }
      const dn = dr * dr + di * di;
      if (dn < 1e-300) continue;
      const qr = (nr * dr + ni * di) / dn, qi = (ni * dr - nr * di) / dn;
      roots[i] = [ri - qr, ii - qi];
      maxd = Math.max(maxd, Math.abs(qr) + Math.abs(qi));
    }
    if (maxd < 1e-13) break;
  }
  // Newton polish (verified finding R7: improves clustered-root accuracy).
  const evalDP = (re, im) => {          // derivative via Horner
    let vr = n * p[0], vi = 0;
    for (let i = 1; i < n; i++) {
      const coef = (n - i) * p[i];
      const nr2 = vr * re - vi * im + coef;
      const ni2 = vr * im + vi * re;
      vr = nr2; vi = ni2;
    }
    return [vr, vi];
  };
  for (let i = 0; i < n; i++) {
    let [re, im] = roots[i];
    for (let k = 0; k < 3; k++) {
      const [fr, fi] = evalP(re, im);
      const [dr, di] = evalDP(re, im);
      const dn = dr * dr + di * di;
      if (dn < 1e-300) break;
      const sr = (fr * dr + fi * di) / dn, si = (fi * dr - fr * di) / dn;
      const [nfr, nfi] = evalP(re - sr, im - si);
      if (nfr * nfr + nfi * nfi >= fr * fr + fi * fi) break;   // no improvement
      re -= sr; im -= si;
    }
    roots[i] = [re, im];
  }
  return roots;
}

// pooltool root filter: smallest real positive root
function smallestRealPositive(roots) {
  const cutoff = 1e-3, rtol = 1e-3, atol = 1e-9;
  let best = Infinity;
  for (const [re, im] of roots) {
    if (re < 0) continue;
    const imag = Math.abs(im), real = Math.abs(re);
    let isReal;
    if (real > cutoff) isReal = imag < atol;
    else if (real > 0) isReal = imag / real < rtol;
    else isReal = imag === 0;
    if (isReal && re < best) best = re;
  }
  return best;
}

// ----------------------------- Event detection -----------------------------
// Motion polynomial r(t) = c + b t + a t^2 for a ball in its current state.
function motionCoeffs(b) {
  if (b.state !== SLIDING && b.state !== ROLLING) {
    return { ax: 0, ay: 0, bx: 0, by: 0, cx: b.x, cy: b.y };
  }
  const phi = angleOf(b.vx, b.vy);
  const v = hyp(b.vx, b.vy);
  let ux = 1, uy = 0;                       // rolling: decel along +x (ball frame)
  if (b.state === SLIDING) {
    const rv = relVelocity(b); const rn = hyp(rv[0], rv[1]);
    if (rn > 0) { const r = rot2(rv[0] / rn, rv[1] / rn, -phi); ux = r[0]; uy = r[1]; }
  }
  const mu = b.state === SLIDING ? BALL.u_s : BALL.u_r;
  const K = -0.5 * mu * g;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  return {
    ax: K * (ux * cp - uy * sp),
    ay: K * (ux * sp + uy * cp),
    bx: v * cp, by: v * sp,
    cx: b.x, cy: b.y,
  };
}

function ballBallTime(b1, b2) {
  const moving1 = b1.state === SLIDING || b1.state === ROLLING;
  const moving2 = b2.state === SLIDING || b2.state === ROLLING;
  if (!moving1 && !moving2) return Infinity;
  // Overlapping and approaching -> immediate collision (verified finding R2;
  // mirrors pooltool's is_overlapping -> event at current time).
  {
    const rx = b2.x - b1.x, ry = b2.y - b1.y;
    if (hyp(rx, ry) < 2 * BALL.R) {
      const rvx = b2.vx - b1.vx, rvy = b2.vy - b1.vy;
      if (rx * rvx + ry * rvy < -1e-12) return T_IMMEDIATE;
      return Infinity;   // overlapping but separating: let them part
    }
  }
  const m1 = motionCoeffs(b1), m2 = motionCoeffs(b2);
  const Ax = m2.ax - m1.ax, Ay = m2.ay - m1.ay;
  const Bx = m2.bx - m1.bx, By = m2.by - m1.by;
  const Cx = m2.cx - m1.cx, Cy = m2.cy - m1.cy;
  const R = BALL.R;
  const a = Ax * Ax + Ay * Ay;
  const b = 2 * (Ax * Bx + Ay * By);
  const c = Bx * Bx + By * By + 2 * (Ax * Cx + Ay * Cy);
  const d = 2 * (Bx * Cx + By * Cy);
  const e = Cx * Cx + Cy * Cy - 4 * R * R;
  // filter roots: real, positive, AND balls approaching at contact
  const roots = polyRootsDK([a, b, c, d, e]);
  const cutoff = 1e-3, rtol = 1e-3, atol = 1e-9;
  let bestT = Infinity;
  for (const [re, im] of roots) {
    if (re < 0 || re >= bestT) continue;
    const imag = Math.abs(im), real = Math.abs(re);
    const isReal = real > cutoff ? imag < atol : (real > 0 ? imag / real < rtol : imag === 0);
    if (!isReal) continue;
    const t = re;
    // relative position & velocity at t (quadratic trajectories)
    const rx = Cx + Bx * t + Ax * t * t, ry = Cy + By * t + Ay * t * t;
    const vx = Bx + 2 * Ax * t, vy = By + 2 * Ay * t;
    if (rx * vx + ry * vy >= 0) continue;      // separating or grazing — not a collision
    bestT = t;
  }
  return bestT;
}

// Axis-aligned rails: ball center line at R (left/bottom) or W-R / L-R (right/top).
const T_IMMEDIATE = 1e-14;   // event time for at/past-plane contacts

function ballRailTimes(b) {
  if (b.state !== SLIDING && b.state !== ROLLING) return [];
  const m = motionCoeffs(b);
  const R = BALL.R;
  const out = [];
  // At/beyond a rail plane and moving (or penetrated) inward -> immediate event.
  // Covers frozen-on-rail strikes, makeKiss pushes past the plane, and masse
  // curves from the rail line (verified finding R1).
  const imm = (past, vin, pen) => past && (vin || pen);
  if (imm(b.x <= R, b.vx < -1e-12, b.x < R - 1e-9)) out.push({ t: T_IMMEDIATE, rail: 'L' });
  if (imm(b.x >= TABLE.W - R, b.vx > 1e-12, b.x > TABLE.W - R + 1e-9)) out.push({ t: T_IMMEDIATE, rail: 'R' });
  if (imm(b.y <= R, b.vy < -1e-12, b.y < R - 1e-9)) out.push({ t: T_IMMEDIATE, rail: 'B' });
  if (imm(b.y >= TABLE.L - R, b.vy > 1e-12, b.y > TABLE.L - R + 1e-9)) out.push({ t: T_IMMEDIATE, rail: 'T' });
  if (out.length) return out;
  const check = (a2, b2, c2, rail, toward) => {
    for (const t of quadRoots(a2, b2, c2)) {
      if (!isFinite(t) || t <= EPS) continue;
      // approach check: velocity component toward the rail at time t must be toward it
      const vAt = rail === 'L' || rail === 'R'
        ? m.bx + 2 * m.ax * t
        : m.by + 2 * m.ay * t;
      if (toward === -1 && vAt >= 0) continue;
      if (toward === +1 && vAt <= 0) continue;
      out.push({ t, rail });
    }
  };
  check(m.ax, m.bx, m.cx - R, 'L', -1);                    // left   x = R
  check(m.ax, m.bx, m.cx - (TABLE.W - R), 'R', +1);        // right  x = W-R
  check(m.ay, m.by, m.cy - R, 'B', -1);                    // bottom y = R
  check(m.ay, m.by, m.cy - (TABLE.L - R), 'T', +1);        // top    y = L-R
  return out;
}

function transitionTime(b) {
  switch (b.state) {
    case SLIDING: return getSlideTime(b);
    case ROLLING: return getRollTime(b);
    case SPINNING: return getSpinTime(b);
    default: return Infinity;
  }
}

// ----------------------------- Resolvers -----------------------------------
// --- Cue strike (instantaneous point, TP A-30) + squirt (TP A-31).
// aIn: sidespin in [-1,1] (positive = LEFT english per pooltool convention)
// bIn: topspin in [-1,1] (positive = follow), theta: cue elevation (rad), phi: aim angle (rad)
function strike(ball, V0, phi, aIn, bIn, theta = 0) {
  const R = BALL.R, m = BALL.m, M = CUE.M;
  const cueC = Math.sqrt(Math.max(0, 1 - aIn * aIn - bIn * bIn));
  const a = aIn;
  const c = Math.cos(theta) * cueC - Math.sin(theta) * bIn;
  const bb = Math.sin(theta) * cueC + Math.cos(theta) * bIn;
  const aR = a * R, cR = c * R, bR = bb * R;
  const I_m = 2 / 5 * R * R;
  const temp = aR * aR + (bR * Math.cos(theta)) ** 2 + (cR * Math.sin(theta)) ** 2
    - 2 * bR * cR * Math.cos(theta) * Math.sin(theta);
  const v = 2 * V0 / (1 + m / M + temp / I_m);
  // ball-frame velocity and spin
  const vB = [0, -v * Math.cos(theta), 0];
  const wB = [
    v / I_m * (-cR * Math.sin(theta) + bR * Math.cos(theta)),
    v / I_m * (aR * Math.sin(theta)),
    v / I_m * (-aR * Math.cos(theta)),
  ];
  // squirt deflection
  const m_r = m / CUE.end_mass;
  const A = 1 - a * a;
  const alpha = -Math.atan2(5 / 2 * a * Math.sqrt(A), 1 + m_r + 5 / 2 * A);
  // rotate to table frame: phi + pi/2, then apply squirt rotation to v
  const ra = phi + Math.PI / 2;
  let [vx, vy] = rot2(vB[0], vB[1], ra);
  [vx, vy] = rot2(vx, vy, alpha);
  const [wx, wy] = rot2(wB[0], wB[1], ra);
  ball.vx = vx; ball.vy = vy;
  ball.wx = wx; ball.wy = wy; ball.wz = wB[2];
  ball.state = SLIDING;
}

const MIN_DIST = 1e-6;   // pooltool spacer: prevents repeat events at contact

function clampIntoTable(b) {
  const R = BALL.R;
  b.x = Math.min(Math.max(b.x, R), TABLE.W - R);
  b.y = Math.min(Math.max(b.y, R), TABLE.L - R);
}

function makeKiss(b1, b2) {
  // pooltool primary strategy: move balls along their velocities to the time
  // offset where separation = 2R + spacer; fallback: symmetric push along the
  // line of centers. Finally clamp into the table (verified finding R1).
  const R = BALL.R, target = 2 * R + MIN_DIST;
  const moving1 = b1.state === SLIDING || b1.state === ROLLING;
  const moving2 = b2.state === SLIDING || b2.state === ROLLING;
  let done = false;
  if (moving1 || moving2) {
    const Bx = b2.vx - b1.vx, By = b2.vy - b1.vy;
    const Cx = b2.x - b1.x, Cy = b2.y - b1.y;
    const alpha = Bx * Bx + By * By;
    const beta = 2 * (Bx * Cx + By * Cy);
    const gamma = Cx * Cx + Cy * Cy - target * target;
    const roots = quadRoots(alpha, beta, gamma).filter(isFinite);
    if (roots.length) {
      const t = roots.reduce((p, q) => Math.abs(q) < Math.abs(p) ? q : p);
      const n1x = b1.x + t * b1.vx, n1y = b1.y + t * b1.vy;
      const n2x = b2.x + t * b2.vx, n2y = b2.y + t * b2.vy;
      const shift = hyp((n1x + n2x) / 2 - (b1.x + b2.x) / 2, (n1y + n2y) / 2 - (b1.y + b2.y) / 2);
      if (shift <= 5 * MIN_DIST) {
        b1.x = n1x; b1.y = n1y; b2.x = n2x; b2.y = n2y;
        done = true;
      }
    }
  }
  if (!done) {
    const dx = b2.x - b1.x, dy = b2.y - b1.y;
    const d = hyp(dx, dy) || 1e-12;
    const corr = (2 * R - d + MIN_DIST) / 2;
    const nx = dx / d, ny = dy / d;
    b1.x -= corr * nx; b1.y -= corr * ny;
    b2.x += corr * nx; b2.y += corr * ny;
  }
  clampIntoTable(b1); clampIntoTable(b2);
}

// pooltool resolve_continually_touching: prevents event storms for balls
// moving in unison (Newton's cradle style) via 10% radial momentum theft.
function resolveContinuallyTouching(b1, b2) {
  const v1s = hyp(b1.vx, b1.vy), v2s = hyp(b2.vx, b2.vy);
  if (!(v1s > 0 && v2s > 0)) return;
  const dx = b2.x - b1.x, dy = b2.y - b1.y, d = hyp(dx, dy) || 1e-12;
  const nx = dx / d, ny = dy / d;
  const v1n = b1.vx * nx + b1.vy * ny, v2n = b2.vx * nx + b2.vy * ny;
  const cosSim = (b1.vx * b2.vx + b1.vy * b2.vy) / (v1s * v2s);
  if (Math.abs(v2n - v1n) < 0.01 && cosSim > 0.9) {
    const theft = 0.10;
    let n1, n2;
    if (v1n > v2n) { n1 = v1n - v1n * theft; n2 = v2n + v1n * theft; }
    else { n1 = v1n + v2n * theft; n2 = v2n - v2n * theft; }
    b1.vx += (n1 - v1n) * nx; b1.vy += (n1 - v1n) * ny;
    b2.vx += (n2 - v2n) * nx; b2.vy += (n2 - v2n) * ny;
  }
}

// Micro-contact (verified finding R4): resolving with restitution at
// near-zero approach speed spawns event storms in near-frozen chains.
// Treat as perfectly-inelastic touch: equalize normal velocities
// (momentum conserving), keep tangentials and spins, then apply pooltool's
// momentum-theft separation.
function microContact(b1, b2) {
  makeKiss(b1, b2);
  const dx = b2.x - b1.x, dy = b2.y - b1.y, d = hyp(dx, dy) || 1e-12;
  const nx = dx / d, ny = dy / d;
  const v1n = b1.vx * nx + b1.vy * ny, v2n = b2.vx * nx + b2.vy * ny;
  const avg = (v1n + v2n) / 2;
  b1.vx += (avg - v1n) * nx; b1.vy += (avg - v1n) * ny;
  b2.vx += (avg - v2n) * nx; b2.vy += (avg - v2n) * ny;
  resolveContinuallyTouching(b1, b2);
  b1.state = SLIDING; b2.state = SLIDING;
}

// Alciatore ball-ball friction from relative tangent surface speed
function alciatoreFriction(b1, b2) {
  const R = BALL.R;
  const dx = b2.x - b1.x, dy = b2.y - b1.y, d = hyp(dx, dy) || 1e-12;
  const n = [dx / d, dy / d, 0];
  const tangSurf = (b, sgn) => {
    const v = [b.vx, b.vy, 0], w = [b.wx, b.wy, b.wz];
    const vdotn = v[0] * n[0] * sgn + v[1] * n[1] * sgn;
    const vt = [v[0] - vdotn * n[0] * sgn, v[1] - vdotn * n[1] * sgn, 0];
    const wxd = cross(w, [sgn * R * n[0], sgn * R * n[1], 0]);
    return [vt[0] + wxd[0], vt[1] + wxd[1], vt[2] + wxd[2]];
  };
  const s1 = tangSurf(b1, +1), s2 = tangSurf(b2, -1);
  const rel = hyp(s1[0] - s2[0], s1[1] - s2[1], s1[2] - s2[2]);
  return 9.951e-3 + 0.108 * Math.exp(-1.088 * rel);
}

// --- Ball-ball: Mathavan et al. 2014 "Numerical simulations of the frictional
// collisions of solid balls on a rough surface" — exact port of pooltool's
// collide_balls impulse-integration loop.
function resolveBallBall(b1, b2, N = 1000) {
  const R = BALL.R, M = BALL.m;
  makeKiss(b1, b2);
  const u_s1 = BALL.u_s, u_s2 = BALL.u_s;
  const u_b = alciatoreFriction(b1, b2);
  const e_b = BALL.e_b;

  // local frame: y_loc along line of centers, x_loc = y_loc x z
  const dx = b2.x - b1.x, dy = b2.y - b1.y, dmag = hyp(dx, dy) || 1e-12;
  const yl = [dx / dmag, dy / dmag];            // y_loc
  const xl = [yl[1], -yl[0]];                    // x_loc = y_loc x zhat
  let v_ix = b1.vx * xl[0] + b1.vy * xl[1], v_iy = b1.vx * yl[0] + b1.vy * yl[1];
  let v_jx = b2.vx * xl[0] + b2.vy * xl[1], v_jy = b2.vx * yl[0] + b2.vy * yl[1];
  let w_ix = b1.wx * xl[0] + b1.wy * xl[1], w_iy = b1.wx * yl[0] + b1.wy * yl[1], w_iz = b1.wz;
  let w_jx = b2.wx * xl[0] + b2.wy * xl[1], w_jy = b2.wx * yl[0] + b2.wy * yl[1], w_jz = b2.wz;

  // slips (paper's sign conventions — do NOT unify with relVelocity)
  let u_iR_x = v_ix + R * w_iy, u_iR_y = v_iy - R * w_ix;
  let u_jR_x = v_jx + R * w_jy, u_jR_y = v_jy - R * w_jx;
  let u_iR_mag = hyp(u_iR_x, u_iR_y), u_jR_mag = hyp(u_jR_x, u_jR_y);
  let u_ijC_x = v_ix - v_jx - R * (w_iz + w_jz);
  let u_ijC_z = R * (w_ix + w_jx);
  let u_ijC_mag = hyp(u_ijC_x, u_ijC_z);
  let v_ijy = v_jy - v_iy;

  if (Math.abs(v_ijy) < 1e-6) {
    microContact(b1, b2);
    return;
  }
  const deltaP = 0.5 * (1 + e_b) * M * Math.abs(v_ijy) / N;
  const C = 5 / (2 * M * R);
  let W_f = Infinity, W_c = null, W = 0, niters = 0;

  while (v_ijy < 0 || W < W_f) {
    let dP1, dP2, dPix, dPiy, dPjx, dPjy;
    if (u_ijC_mag < 1e-16) {
      dP1 = dP2 = dPix = dPiy = dPjx = dPjy = 0;
    } else {
      dP1 = -u_b * deltaP * u_ijC_x / u_ijC_mag;
      if (Math.abs(u_ijC_z) < 1e-16) {
        dP2 = 0; dPix = dPiy = dPjx = dPjy = 0;
      } else {
        dP2 = -u_b * deltaP * u_ijC_z / u_ijC_mag;
        if (dP2 > 0) {
          dPix = dPiy = 0;
          if (u_jR_mag === 0) { dPjx = dPjy = 0; }
          else { dPjx = -u_s2 * (u_jR_x / u_jR_mag) * dP2; dPjy = -u_s2 * (u_jR_y / u_jR_mag) * dP2; }
        } else {
          dPjx = dPjy = 0;
          if (u_iR_mag === 0) { dPix = dPiy = 0; }
          else { dPix = u_s1 * (u_iR_x / u_iR_mag) * dP2; dPiy = u_s1 * (u_iR_y / u_iR_mag) * dP2; }
        }
      }
    }
    v_ix += (dP1 + dPix) / M;   v_iy += (-deltaP + dPiy) / M;
    v_jx += (-dP1 + dPjx) / M;  v_jy += (deltaP + dPjy) / M;
    w_ix += C * (dP2 + dPiy);   w_iy += C * (-dPix);   w_iz += C * (-dP1);
    w_jx += C * (dP2 + dPjy);   w_jy += C * (-dPjx);   w_jz += C * (-dP1);
    // refresh slips
    u_iR_x = v_ix + R * w_iy; u_iR_y = v_iy - R * w_ix;
    u_jR_x = v_jx + R * w_jy; u_jR_y = v_jy - R * w_jx;
    u_iR_mag = hyp(u_iR_x, u_iR_y); u_jR_mag = hyp(u_jR_x, u_jR_y);
    u_ijC_x = v_ix - v_jx - R * (w_iz + w_jz);
    u_ijC_z = R * (w_ix + w_jx);
    u_ijC_mag = hyp(u_ijC_x, u_ijC_z);
    const v_ijy0 = v_ijy;
    v_ijy = v_jy - v_iy;
    W += 0.5 * deltaP * Math.abs(v_ijy0 + v_ijy);
    if (W_c === null && v_ijy > 0) { W_c = W; W_f = (1 + e_b * e_b) * W_c; }
    if (++niters > 20 * N) break;               // safety cap (spec flag D2)
  }
  // back to table frame
  b1.vx = v_ix * xl[0] + v_iy * yl[0]; b1.vy = v_ix * xl[1] + v_iy * yl[1];
  b2.vx = v_jx * xl[0] + v_jy * yl[0]; b2.vy = v_jx * xl[1] + v_jy * yl[1];
  b1.wx = w_ix * xl[0] + w_iy * yl[0]; b1.wy = w_ix * xl[1] + w_iy * yl[1]; b1.wz = w_iz;
  b2.wx = w_jx * xl[0] + w_jy * yl[0]; b2.wy = w_jx * xl[1] + w_jy * yl[1]; b2.wz = w_jz;
  resolveContinuallyTouching(b1, b2);
  b1.state = SLIDING; b2.state = SLIDING;
}

// --- Ball-ball fallback: frictional inelastic (pooltool _resolve_ball_ball port)
function resolveBallBallInelastic(b1, b2) {
  const R = BALL.R;
  makeKiss(b1, b2);
  const theta = angleOf(b2.x - b1.x, b2.y - b1.y);
  // rotate velocities & spins into line-of-centers frame
  let v1 = rot2(b1.vx, b1.vy, -theta), w1xy = rot2(b1.wx, b1.wy, -theta);
  let v2 = rot2(b2.vx, b2.vy, -theta), w2xy = rot2(b2.wx, b2.wy, -theta);
  let V1 = [v1[0], v1[1], 0], W1 = [w1xy[0], w1xy[1], b1.wz];
  let V2 = [v2[0], v2[1], 0], W2 = [w2xy[0], w2xy[1], b2.wz];

  // Alciatore friction from relative tangent surface speed (pre-collision)
  const xhat = [1, 0, 0];
  const tsv = (V, W, dSign) => {
    // v_t + w x (R d), with v_t = v - (v.d)d ; d = ±x̂
    const vt = [0, V[1], V[2]];
    const wxd = cross(W, [dSign * R, 0, 0]);
    return [vt[0] + wxd[0] - (dSign > 0 ? V[0] - V[0] : 0), vt[1] + wxd[1], vt[2] + wxd[2]];
  };
  const s1 = tsv(V1, W1, +1), s2 = tsv(V2, W2, -1);
  const relSurf = hyp(s1[0] - s2[0], s1[1] - s2[1], s1[2] - s2[2]);
  const u_b = 9.951e-3 + 0.108 * Math.exp(-1.088 * relSurf);
  const e_b = BALL.e_b;

  // normal components
  const v1n = V1[0], v2n = V2[0];
  const v1nf = 0.5 * ((1 - e_b) * v1n + (1 + e_b) * v2n);
  const v2nf = 0.5 * ((1 + e_b) * v1n + (1 - e_b) * v2n);
  const Dvn = Math.abs(v2nf - v1nf);
  const w1n = W1[0], w2n = W2[0];

  // zero normal components
  V1[0] = 0; V2[0] = 0; W1[0] = 0; W2[0] = 0;
  let V1f = V1.slice(), V2f = V2.slice(), W1f = W1.slice(), W2f = W2.slice();

  const surfVel = (V, W, dSign) => {   // v + w x (R d)
    const wxd = cross(W, [dSign * R, 0, 0]);
    return [V[0] + wxd[0], V[1] + wxd[1], V[2] + wxd[2]];
  };
  const c1 = surfVel(V1, W1, +1), c2 = surfVel(V2, W2, -1);
  const v12 = [c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]];
  const v12n = hyp(...v12);
  const hasRel = v12n > EPS;
  let v12slip = null;
  if (hasRel) {
    const hat = v12.map(q => q / v12n);
    const Dv1t = hat.map(q => -u_b * Dvn * q);
    const Dw1 = cross(xhat, Dv1t).map(q => 2.5 / R * q);
    V1f = V1.map((q, i) => q + Dv1t[i]); W1f = W1.map((q, i) => q + Dw1[i]);
    V2f = V2.map((q, i) => q - Dv1t[i]); W2f = W2.map((q, i) => q + Dw1[i]);
    const c1s = surfVel(V1f, W1f, +1), c2s = surfVel(V2f, W2f, -1);
    v12slip = [c1s[0] - c2s[0], c1s[1] - c2s[1], c1s[2] - c2s[2]];
  }
  if (!hasRel || (v12[0] * v12slip[0] + v12[1] * v12slip[1] + v12[2] * v12slip[2]) <= 0) {
    // no-slip (gearing) condition
    const relV = [V1[0] - V2[0], V1[1] - V2[1], V1[2] - V2[2]];
    const wSum = [W1[0] + W2[0], W1[1] + W2[1], W1[2] + W2[2]];
    const crossWx = cross(wSum, xhat);
    const Dv1t = relV.map((q, i) => -(1 / 7) * (q + R * crossWx[i]));
    const crossXV = cross(xhat, relV);
    const Dw1 = crossXV.map((q, i) => -(5 / 14) * (q / R + wSum[i]));
    V1f = V1.map((q, i) => q + Dv1t[i]); W1f = W1.map((q, i) => q + Dw1[i]);
    V2f = V2.map((q, i) => q - Dv1t[i]); W2f = W2.map((q, i) => q + Dw1[i]);
  }
  // reintroduce normal components
  V1f[0] = v1nf; V2f[0] = v2nf; W1f[0] = w1n; W2f[0] = w2n;
  // rotate back
  const rv1 = rot2(V1f[0], V1f[1], theta), rw1 = rot2(W1f[0], W1f[1], theta);
  const rv2 = rot2(V2f[0], V2f[1], theta), rw2 = rot2(W2f[0], W2f[1], theta);
  b1.vx = rv1[0]; b1.vy = rv1[1]; b1.wx = rw1[0]; b1.wy = rw1[1]; b1.wz = W1f[2];
  b2.vx = rv2[0]; b2.vy = rv2[1]; b2.wx = rw2[0]; b2.wy = rw2[1]; b2.wz = W2f[2];
  b1.state = SLIDING; b2.state = SLIDING;
}

// --- Ball-cushion: Mathavan et al. 2010 (exact port of pooltool implementation)
function mathavanSolve(M, R, h, ee, mu_s, mu_w, vx, vy, wx, wy, wz, maxSteps = 1000, deltaP0 = 0.001) {
  const sinT = (h - R) / R, cosT = Math.sqrt(1 - sinT * sinT);

  // Dying-speed fallback (verified finding R3): below ~5 mm/s normal speed the
  // absolute impulse-step floor would CREATE energy (effective restitution up
  // to 22x). Use simple restitution reflection instead — friction is
  // negligible at these speeds.
  if (Math.abs(vy) < 5e-3) {
    return [vx, -ee * vy, wx, wy, wz];
  }

  // Returns slip angles AND per-step effective frictions: a contact with zero
  // slip speed exerts no sliding friction (verified finding R5 — atan2(0,0)=0
  // would otherwise inject friction along +x and break mirror symmetry).
  const slipState = (vx, vy, wx, wy, wz) => {
    const vxI = vx + wy * R * sinT - wz * R * cosT;
    const vyI = -vy * sinT + wx * R;
    const vxC = vx - wy * R;
    const vyC = vy + wx * R;
    let sa = Math.atan2(vyI, vxI); if (sa < 0) sa += 2 * Math.PI;
    let sap = Math.atan2(vyC, vxC); if (sap < 0) sap += 2 * Math.PI;
    const muW = hyp(vxI, vyI) < 1e-12 ? 0 : mu_w;
    const muS = hyp(vxC, vyC) < 1e-12 ? 0 : mu_s;
    return [sa, sap, muW, muS];
  };
  const updV = (vx, vy, sa, sap, dp, muW, muS) => {
    const term = sinT + muW * Math.sin(sa) * cosT;
    const nvx = vx - (1 / M) * (muW * Math.cos(sa) + muS * Math.cos(sap) * term) * dp;
    const nvy = vy - (1 / M) * (cosT - muW * sinT * Math.sin(sa) + muS * Math.sin(sap) * term) * dp;
    return [nvx, nvy];
  };
  const updW = (wx, wy, wz, sa, sap, dp, muW, muS) => {
    const f = 5 / (2 * M * R);
    const term = sinT + muW * Math.sin(sa) * cosT;
    return [
      wx - f * (muW * Math.sin(sa) + muS * Math.sin(sap) * term) * dp,
      wy - f * (muW * Math.cos(sa) * sinT - muS * Math.cos(sap) * term) * dp,
      wz + f * (muW * Math.cos(sa) * cosT) * dp,
    ];
  };
  const work = (vy, dp) => dp * Math.abs(vy) * cosT;

  // ---- compression phase: until vy <= 0
  let WzI = 0, steps = 0;
  let dp = Math.max(M * vy / maxSteps, deltaP0);
  while (vy > 0) {
    const [sa, sap, muW, muS] = slipState(vx, vy, wx, wy, wz);
    const [nvx, nvy] = updV(vx, vy, sa, sap, dp, muW, muS);
    if (vy > 0 && nvy <= 0) {
      // binary refinement toward the crossing
      let rvx = vx, rvy = vy, rwx = wx, rwy = wy, rwz = wz, rW = WzI, rdp = dp;
      for (let k = 0; k < 8; k++) {
        rdp /= 2;
        const [rsa, rsap, rmuW, rmuS] = slipState(rvx, rvy, rwx, rwy, rwz);
        const [tvx, tvy] = updV(rvx, rvy, rsa, rsap, rdp, rmuW, rmuS);
        if (tvy <= 0) continue;
        rvx = tvx; rvy = tvy;
        const W = updW(rwx, rwy, rwz, rsa, rsap, rdp, rmuW, rmuS);
        rwx = W[0]; rwy = W[1]; rwz = W[2];
        rW += work(rvy, rdp);
      }
      vx = rvx; vy = rvy; wx = rwx; wy = rwy; wz = rwz; WzI = rW;
      break;
    }
    vx = nvx; vy = nvy;
    const W = updW(wx, wy, wz, sa, sap, dp, muW, muS);
    wx = W[0]; wy = W[1]; wz = W[2];
    WzI += work(vy, dp);
    if (++steps > 10 * maxSteps) break;
  }

  // ---- restitution phase: until work reaches ee^2 * WzI
  const target = ee * ee * WzI;
  let W2 = 0; steps = 0;
  dp = Math.max(target / maxSteps, deltaP0);
  while (W2 < target) {
    const [sa, sap, muW, muS] = slipState(vx, vy, wx, wy, wz);
    const nextW = work(vy, dp);
    if (W2 + nextW > target) {
      const remaining = target - W2;
      const rdp = remaining / (Math.abs(vy) * cosT);
      const [nvx, nvy] = updV(vx, vy, sa, sap, rdp, muW, muS);
      const W = updW(wx, wy, wz, sa, sap, rdp, muW, muS);
      return [nvx, nvy, W[0], W[1], W[2]];
    }
    const [nvx, nvy] = updV(vx, vy, sa, sap, dp, muW, muS);
    vx = nvx; vy = nvy;
    const W = updW(wx, wy, wz, sa, sap, dp, muW, muS);
    wx = W[0]; wy = W[1]; wz = W[2];
    W2 += work(vy, dp);
    if (++steps > 10 * maxSteps) break;
  }
  return [vx, vy, wx, wy, wz];
}

// rail: 'L'|'R'|'B'|'T'. Rotate so the cushion normal (pointing INTO the rail,
// i.e. along ball approach) maps to +y, run Mathavan, rotate back.
function resolveCushion(b, rail) {
  // normal pointing from table into the cushion
  let nx = 0, ny = 0;
  if (rail === 'L') { nx = -1; ny = 0; b.x = BALL.R + MIN_DIST; }
  else if (rail === 'R') { nx = 1; ny = 0; b.x = TABLE.W - BALL.R - MIN_DIST; }
  else if (rail === 'B') { nx = 0; ny = -1; b.y = BALL.R + MIN_DIST; }
  else { nx = 0; ny = 1; b.y = TABLE.L - BALL.R - MIN_DIST; }
  // flip normal to align with velocity if needed (pooltool convention)
  if (nx * b.vx + ny * b.vy <= 0) { nx = -nx; ny = -ny; }
  const psi = angleOf(nx, ny);
  const rotA = Math.PI / 2 - psi;
  const [vx, vy] = rot2(b.vx, b.vy, rotA);
  const [wx, wy] = rot2(b.wx, b.wy, rotA);
  const res = mathavanSolve(BALL.m, BALL.R, TABLE.h, BALL.e_c, BALL.u_s, BALL.f_c,
    vx, vy, wx, wy, b.wz);
  const [vxf, vyf] = rot2(res[0], res[1], -rotA);
  const [wxf, wyf] = rot2(res[2], res[3], -rotA);
  b.vx = vxf; b.vy = vyf; b.wx = wxf; b.wy = wyf; b.wz = res[4];
  b.state = SLIDING;
}

// ----------------------------- Event loop ----------------------------------
// Returns { events, segments, duration, cueBandCount, firstContact }
// segments: per ball: [{t, snap:{x,y,vx,...,state}}...] — evaluate positions by
// evolveBall(snap, tQuery - t).
function simulateShot(balls, opts = {}) {
  const maxEvents = opts.maxEvents || 4000;
  const maxT = opts.maxT || 120;
  let t = 0;
  const events = [];
  const segments = balls.map(b => [{ t: 0, snap: { ...b } }]);

  const settle = () => {
    // consume zero-duration transitions to avoid event spam
    for (const b of balls) {
      let guard = 0;
      while (guard++ < 8) {
        const d = transitionTime(b);
        if (d > 1e-12 || b.state === STATIONARY) break;
        const nb = evolveBall(b, d + 1e-15);
        Object.assign(b, nb);
      }
    }
  };
  settle();

  let count = 0;
  const lastPair = new Map();   // pair-key -> last collision time (storm debounce)
  while (count++ < maxEvents && t < maxT) {
    let bestT = Infinity, best = null;
    for (let i = 0; i < balls.length; i++) {
      const d = transitionTime(balls[i]);
      if (d < bestT) { bestT = d; best = { type: 'transition', i }; }
    }
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const d = ballBallTime(balls[i], balls[j]);
        if (d < bestT) { bestT = d; best = { type: 'ball', i, j }; }
      }
    }
    for (let i = 0; i < balls.length; i++) {
      for (const { t: d, rail } of ballRailTimes(balls[i])) {
        if (d < bestT) { bestT = d; best = { type: 'cushion', i, rail }; }
      }
    }
    if (!best || !isFinite(bestT)) break;

    // advance all balls to event time (exact analytic evolution)
    for (let i = 0; i < balls.length; i++) {
      const nb = evolveBall(balls[i], bestT);
      Object.assign(balls[i], nb);
    }
    t += bestT;
    // belt-and-braces: with immediate-event detection this should never fire,
    // but never let a ball rest outside the table
    for (const b of balls) {
      if (b.x < BALL.R - 1e-9 || b.x > TABLE.W - BALL.R + 1e-9 ||
          b.y < BALL.R - 1e-9 || b.y > TABLE.L - BALL.R + 1e-9) clampIntoTable(b);
    }

    if (best.type === 'transition') {
      // state already advanced by evolveBall at exact boundary; nudge if not
      const b = balls[best.i];
      const nb = evolveBall(b, 1e-15);
      Object.assign(b, nb);
    } else if (best.type === 'ball') {
      // Storm debounce (verified finding R4): a same-pair re-contact within
      // 1 ms at < 2 cm/s approach is persistent touching, not a new collision.
      const b1 = balls[best.i], b2 = balls[best.j];
      const key = best.i + '-' + best.j;
      const dx = b2.x - b1.x, dy = b2.y - b1.y, dm = hyp(dx, dy) || 1e-12;
      const approach = -((b2.vx - b1.vx) * dx + (b2.vy - b1.vy) * dy) / dm;
      const prev = lastPair.get(key);
      if (prev !== undefined && t - prev < 1e-3 && approach < 0.02) microContact(b1, b2);
      else resolveBallBall(b1, b2);
      lastPair.set(key, t);
    } else {
      resolveCushion(balls[best.i], best.rail);
    }
    settle();
    events.push({ t, ...best });
    for (let i = 0; i < balls.length; i++) segments[i].push({ t, snap: { ...balls[i] } });

    if (balls.every(b => b.state === STATIONARY)) break;
  }
  return {
    events, segments, duration: t,
    positionAt(iBall, tq) {
      const segs = segments[iBall];
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].t <= tq) lo = mid; else hi = mid - 1; }
      const s = segs[lo];
      return evolveBall(s.snap, Math.max(0, tq - s.t));
    },
  };
}

function mkBall(x, y) { return { x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, state: STATIONARY }; }

// ----------------------------- Exports -------------------------------------
const api = {
  BALL, CUE, TABLE, g,
  STATIONARY, SPINNING, SLIDING, ROLLING,
  mkBall, strike, simulateShot, evolveBall,
  resolveBallBall, resolveBallBallInelastic, resolveCushion, mathavanSolve,
  ballBallTime, ballRailTimes, transitionTime, motionCoeffs,
  polyRootsDK, smallestRealPositive, quadRoots, relVelocity,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.CarambaEngine = api;
