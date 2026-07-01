/* ============================================================================
 * CarambaBridge — adapter giữa Caramba Billiards (carambanotebook.html)
 * và engine vật lý event-based (engine.js).
 *
 * Hợp đồng tọa độ (đã xác minh trong source Caramba, hàm uvToCanvas ~L10075):
 *   - Drawing schema v2 lưu bi & điểm đường theo (u, v) chuẩn hóa trên mặt vải:
 *       u ∈ [0,1] dọc TRỤC DÀI của bàn, v ∈ [0,1] dọc TRỤC NGẮN.
 *   - Engine dùng mét SI: x ∈ [0, 1.42] (trục ngắn), y ∈ [0, 2.84] (trục dài).
 *   - Chuyển đổi:  x = v · TABLE.W ;  y = u · TABLE.L   (và ngược lại).
 *     Mirror/orientation khi render do app xử lý (dữ liệu canonical không đổi),
 *     nên bridge KHÔNG cần quan tâm orientation.
 *
 * Yêu cầu: engine.js đã được nạp trước (window.CarambaEngine hoặc require).
 * ==========================================================================*/
'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.CarambaBridge = factory(root.CarambaEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (E) {

  const { TABLE, BALL } = E;

  // ------------------------- coordinate mapping ---------------------------
  const uvToM = (u, v) => ({ x: v * TABLE.W, y: u * TABLE.L });
  const mToUV = (x, y) => ({ u: y / TABLE.L, v: x / TABLE.W });

  // ------------------------- input mapping --------------------------------
  /**
   * Map English Compass (tip offset chuẩn hóa, phải-dương / trên-dương,
   * bán kính ≤ 1) sang (a, b) của engine.
   * Quy ước pooltool: a DƯƠNG = ép trái  →  a = -tipX · MAX_TIP.
   * MAX_TIP = 0.5R là ngưỡng miscue thực tế.
   */
  const MAX_TIP = 0.5;
  function englishToAB(tipX, tipY) {
    let x = tipX || 0, y = tipY || 0;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    return { a: -x * MAX_TIP, b: y * MAX_TIP };
  }

  /**
   * Map speed/power của app (0..1) sang tốc độ đầu cơ V0 (m/s).
   * V0MAX 6.5 m/s ≈ cú đánh hết lực (đủ 8+ băng trên bàn nỉ nóng).
   */
  const V0_MAX = 6.5, V0_MIN = 0.35;
  const powerToV0 = f => V0_MIN + Math.max(0, Math.min(1, f)) * (V0_MAX - V0_MIN);

  // ------------------------- path post-processing --------------------------
  /** Ramer–Douglas–Peucker: rút gọn polyline (đơn vị mét). */
  function simplifyRDP(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      const ax = pts[i0].x, ay = pts[i0].y, bx = pts[i1].x, by = pts[i1].y;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-18;
      let worst = -1, wd = 0;
      for (let i = i0 + 1; i < i1; i++) {
        const t = ((pts[i].x - ax) * dx + (pts[i].y - ay) * dy) / len2;
        const px = ax + Math.max(0, Math.min(1, t)) * dx;
        const py = ay + Math.max(0, Math.min(1, t)) * dy;
        const d = Math.hypot(pts[i].x - px, pts[i].y - py);
        if (d > wd) { wd = d; worst = i; }
      }
      if (wd > eps && worst > 0) { keep[worst] = 1; stack.push([i0, worst], [worst, i1]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // ------------------------- scoring (giải trí) ----------------------------
  /**
   * Chấm điểm 3 băng từ chuỗi sự kiện: bi chủ (index 0) phải chạm ≥3 băng
   * TRƯỚC khi chạm bi mục tiêu THỨ HAI.
   */
  function score3Cushion(events) {
    let cushionsBeforeSecond = 0, cushions = 0;
    const hitBalls = new Set();
    let firstHit = null, valid = false;
    for (const e of events) {
      if (e.type === 'cushion' && e.i === 0) cushions++;
      if (e.type === 'ball' && (e.i === 0 || e.j === 0)) {
        const other = e.i === 0 ? e.j : e.i;
        if (!hitBalls.has(other)) {
          hitBalls.add(other);
          if (hitBalls.size === 1) firstHit = other;
          if (hitBalls.size === 2) {
            cushionsBeforeSecond = cushions;
            valid = cushions >= 3;
          }
        }
      }
    }
    return {
      valid,                     // ăn điểm 3 băng hợp lệ?
      firstHit,                  // index bi chạm đầu (1=vàng, 2=đỏ)
      bothBallsHit: hitBalls.size === 2,
      cushionsBeforeSecond,      // số băng trước khi chạm bi thứ 2
      totalCushions: cushions,
    };
  }

  // ------------------------- main API --------------------------------------
  /**
   * Mô phỏng một cú đánh từ drawing hiện tại của Caramba.
   *
   * @param drawingBalls  mảng balls của drawing: [{type:'cue'|'yellow'|'red', u, v}]
   * @param shot {
   *   aimU, aimV        — điểm nhắm trên mặt vải (uv), HOẶC:
   *   aimAngleRad       — góc đánh trực tiếp trong hệ mét (atan2(dy,dx)),
   *   tipX, tipY        — English Compass, chuẩn hóa [-1,1], phải/trên dương,
   *   power             — 0..1 (map từ widget speed hiện có),
   *   pathEpsilonMm     — độ rút gọn polyline (mặc định 1.5mm),
   * }
   * @returns {
   *   ok, duration, events,
   *   score: {valid, firstHit, bothBallsHit, cushionsBeforeSecond, totalCushions},
   *   paths: {cue, yellow, red}    — mỗi cái là mảng [{u,v}] sẵn để vẽ/lưu
   *                                   theo đúng format path.points của schema v2,
   *   positionsAt(t)               — {cue:{u,v}, yellow:{u,v}, red:{u,v}} để animate,
   * }
   */
  function simulate(drawingBalls, shot) {
    const order = ['cue', 'yellow', 'red'];
    const src = order.map(t => drawingBalls.find(b => b.type === t));
    if (src.some(b => !b)) return { ok: false, reason: 'missing-ball' };

    const balls = src.map(b => { const m = uvToM(b.u, b.v); return E.mkBall(m.x, m.y); });
    const cue = balls[0];

    let phi;
    if (typeof shot.aimAngleRad === 'number') phi = shot.aimAngleRad;
    else {
      const t = uvToM(shot.aimU, shot.aimV);
      phi = Math.atan2(t.y - cue.y, t.x - cue.x);
    }
    const { a, b } = englishToAB(shot.tipX, shot.tipY);
    E.strike(cue, powerToV0(shot.power), phi, a, b);

    const res = E.simulateShot(balls, { maxEvents: 3000, maxT: 60 });

    // sample theo từng đoạn sự kiện (đỉnh chạm băng chính xác), rồi rút gọn
    const eps = (shot.pathEpsilonMm ?? 1.5) / 1000;
    const bounds = [0, ...res.events.map(e => e.t), res.duration];
    const raw = [[], [], []];
    for (let s = 0; s < bounds.length - 1; s++) {
      const ta = bounds[s], tb = bounds[s + 1];
      if (tb - ta < 1e-9) continue;
      const k = Math.min(24, Math.max(2, Math.ceil((tb - ta) * 20)));
      for (let j = 0; j <= k; j++) {
        const t = ta + (tb - ta) * j / k;
        for (let i = 0; i < 3; i++) {
          const st = res.positionAt(i, t);
          raw[i].push({ x: st.x, y: st.y });
        }
      }
    }
    const toUVPath = pts => simplifyRDP(pts, eps).map(p => {
      const q = mToUV(p.x, p.y);
      return { u: +q.u.toFixed(5), v: +q.v.toFixed(5) };
    });

    return {
      ok: true,
      duration: res.duration,
      events: res.events,
      score: score3Cushion(res.events),
      paths: {
        cue: toUVPath(raw[0]),
        yellow: toUVPath(raw[1]),
        red: toUVPath(raw[2]),
      },
      positionsAt(t) {
        const out = {};
        for (let i = 0; i < 3; i++) {
          const st = res.positionAt(i, Math.max(0, Math.min(t, res.duration)));
          const q = mToUV(st.x, st.y);
          out[order[i]] = { u: q.u, v: q.v };
        }
        return out;
      },
    };
  }

  return { simulate, uvToM, mToUV, englishToAB, powerToV0, score3Cushion, simplifyRDP,
           V0_MAX, V0_MIN, MAX_TIP };
});
