# HANDOVER — Tích hợp Physics Engine vào Caramba Billiards

> Tài liệu bàn giao cho session làm việc trên repo **Caramba Billiards**
> (file `carambanotebook.html`, app Capacitor/WKWebView đã release App Store).
> Đích: 3 tính năng — (1) tự vẽ đường bi từ aim/english/speed → Accept & Save,
> (2) mô phỏng cú đánh trong lúc vẽ, (3) chế độ giải trí.

---

## 1. Bàn giao gồm những gì

| File | Vai trò | Trạng thái |
|---|---|---|
| `engine.js` | Engine vật lý event-based, vanilla JS, 0 dependency, chạy Node + browser | **Đã kiểm chứng** (xem §5) |
| `caramba-bridge.js` | Adapter: schema Caramba (u,v) ↔ engine (mét SI), mapping english/speed, chấm điểm 3 băng, xuất `path.points` | Đã test với dữ liệu seed thật của app |
| `HANDOVER.md` | Tài liệu này | — |

Repo tham chiếu (prototype đứng độc lập đã chạy tốt các API này):
`thai-veropath/Caramba`, branch `claude/billiard-ball-physics-g3xy7c`
(demo sống: https://thai-veropath.github.io/Caramba/ — `index.html` ở đó là
ví dụ hoàn chỉnh về cách gọi engine: strike → simulateShot → vẽ + animate).

---

## 2. Kết luận khả thi (đã xác minh trong source app)

Cả 3 mục tiêu đều khả thi với **rủi ro thấp**, vì đã xác minh trực tiếp trong
`carambanotebook.html`:

- App là **vanilla JS một file** (23.8k dòng, section markers `═══`), đóng gói
  Capacitor → engine nhúng thẳng, không cần build tool.
- **Schema drawing v2** lưu bi dạng `balls:[{type:'cue'|'yellow'|'red', u, v}]`
  và đường dạng `path:{mode, points:[{u,v,...}]}` — engine xuất ra đúng format
  này (bridge lo việc đó).
- **`u` chạy dọc TRỤC DÀI, `v` dọc TRỤC NGẮN**, chuẩn hóa 0..1
  (xác minh tại `uvToCanvas`, ~dòng 10075: portrait `x = feltX + v·feltW`,
  `y = feltY + (1−u)·feltH`). Orientation/mirror chỉ là chuyện render —
  dữ liệu canonical không đổi → bridge không cần quan tâm orientation.
- App đã có **English Compass** (section ~dòng 15786) và **speed widget** →
  đủ input cho một cú đánh, chỉ thiếu "hướng nhắm" khi ở các mode mới.
- Mô phỏng ~**2ms/cú** trên desktop (WKWebView chậm hơn, ước < 10ms) → chạy
  live khi kéo nhắm được, có debounce càng tốt.

---

## 3. Hợp đồng tích hợp (contract)

### 3.1 Tọa độ
```
engine.x = v · 1.42   (mét, trục ngắn)      u = engine.y / 2.84
engine.y = u · 2.84   (mét, trục dài)       v = engine.x / 1.42
```
Bridge làm sẵn: `CarambaBridge.uvToM(u,v)` / `mToUV(x,y)`.
Round-trip đã test: sai số ~1e-17.

### 3.2 Input một cú đánh
```js
const result = CarambaBridge.simulate(drawing.balls, {
  aimU, aimV,        // điểm nhắm trên vải (uv) — HOẶC aimAngleRad
  tipX, tipY,        // English Compass, chuẩn hóa [-1,1], phải/trên dương
  power,             // 0..1 — map từ speed widget hiện có
  pathEpsilonMm,     // optional, mặc định 1.5mm (độ rút gọn polyline)
});
```
- English: `a = −tipX·0.5`, `b = tipY·0.5` (0.5R = ngưỡng miscue; quy ước
  pooltool a dương = ép TRÁI — bridge đã xử lý, đừng đổi dấu lần nữa).
- Speed: `V0 = 0.35 + power·(6.5 − 0.35)` m/s. V0MAX 6.5 cho ~8–10 băng ở
  100% — khớp yêu cầu đã chốt ở prototype.

### 3.3 Output
```js
result = {
  ok, duration, events,          // events: [{t, type:'ball'|'cushion'|'transition', i, j?, rail?}]
  score: {                       // luật 3 băng, tính sẵn cho goal 3
    valid,                       // cue chạm ≥3 băng trước bi mục tiêu thứ 2?
    firstHit, bothBallsHit,
    cushionsBeforeSecond, totalCushions,
  },
  paths: { cue, yellow, red },   // mỗi cái: [{u,v}] — ĐÚNG format path.points
  positionsAt(t),                // {cue:{u,v}, yellow:{u,v}, red:{u,v}} để animate
}
```
`paths.*` đã: (a) sample theo từng đoạn sự kiện nên **đỉnh chạm băng nằm chính
xác trên đường tiếp xúc** (đừng sample đều theo thời gian — sẽ cắt góc);
(b) rút gọn Ramer–Douglas–Peucker 1.5mm nên drawing lưu ra nhẹ.

### 3.4 Tính chất quan trọng
- **Deterministic**: cùng input → cùng output tuyệt đối → replay/share/library
  ổn định, có thể lưu chỉ input (aim/english/power) thay vì cả path.
- **Không đụng DOM/state**: engine + bridge là hàm thuần → không thể phá gì
  trong app; gate bằng feature flag dễ dàng.
- Quỹ đạo bi trả về là **giải tích** (không sai số tích phân) — sample dày
  bao nhiêu tùy render.

---

## 4. Thiết kế đề xuất cho 3 goal

### Goal 1 — Auto-draw path → Accept & Save
1. Thêm mode "⚡ Auto" cạnh các mode vẽ hiện có (move/path/label).
2. User đặt 3 bi (đã có), chỉnh English Compass (đã có), speed (đã có),
   và kéo trên vải để chọn **hướng nhắm** (chỉ cần 1 gesture mới: điểm chạm
   → `aimU/aimV`).
3. Mỗi lần thay đổi → `simulate(...)` → vẽ preview `paths.cue` (nét đứt) +
   `paths.yellow/red` (nét mờ màu bi) bằng đúng pipeline SVG path hiện có.
4. **Accept** → ghi `paths.cue` vào `drawing.path.points` (giữ nguyên schema —
   library, thumbnail, PNG export, share... hoạt động y nguyên, không đụng gì).
   Khuyến nghị lưu kèm metadata cú đánh để tái mô phỏng:
   `drawing.sim = {aimU, aimV, tipX, tipY, power, engineVersion}`.

### Goal 2 — Mô phỏng trong lúc vẽ
- Nút "▶" trên Capture screen: chạy `simulate`, animate bằng
  `positionsAt(t)` trong `requestAnimationFrame` — di chuyển 3 node SVG bi
  hiện có (hoặc clone tạm để không đụng state), xong trả về vị trí cũ.
- Giá trị dạy học đặc biệt: vẽ tay đường lý thuyết trước, rồi bấm ▶ để so
  **đường lý thuyết vs đường vật lý** trên cùng một hình.

### Goal 3 — Giải trí
- Mode "Chơi": chọn aim/english/speed → animate → chấm điểm bằng
  `result.score.valid` (đã tính sẵn luật 3 băng: cue chạm ≥3 băng trước khi
  trúng bi mục tiêu thứ hai).
- Vì deterministic: làm được **daily challenge** (cùng thế bi cho mọi người),
  đếm series, replay cú đánh đẹp — chỉ cần lưu input.

### Cách nhúng vào file
Thêm 2 section mới trong `<script>` (đúng phong cách section `═══` hiện có):
`PHYSICS ENGINE (engine.js — KHÔNG SỬA TAY, xem handover §6)` và
`PHYSICS BRIDGE (caramba-bridge.js)`. Bỏ wrapper UMD của 2 file khi paste
inline (giữ phần `factory` gán vào `window.CarambaEngine`/`CarambaBridge`),
hoặc giữ nguyên file rời + `<script src>` nếu cấu trúc Capacitor cho phép.

---

## 5. Engine là gì & đã kiểm chứng thế nào

### Mô hình (port nguyên văn từ pooltool — thư viện mô phỏng bi-a tham chiếu)
| Thành phần | Mô hình | Nguồn |
|---|---|---|
| Chuyển động | Nghiệm giải tích trượt→lăn→xoay→dừng, mô phỏng theo SỰ KIỆN (không dt) | pooltool `physics/evolve`, `evolution/event_based` |
| Cú đánh | Instantaneous-point + squirt (lệch hướng khi ép phê) | Alciatore TP A-30, A-31 |
| Va bi | Mathavan 2014 — tích phân xung lực, ma sát bi–bi VÀ bi–bàn trong va chạm | Sports Eng 17, 227–237 |
| Va băng | Mathavan 2010 — nén/hồi phục theo công, băng chạm TRÊN tâm bi | Proc IMechE C 224(9) |
| Ma sát bi–bi | Alciatore μ(v) phụ thuộc tốc độ trượt | TP A-14 |

Thông số: bi carom Ø61.5mm/210g; bàn 2.84×1.42m; băng cao 37mm;
e_băng=0.98, μ_băng=0.14 (giá trị ĐO THỰC NGHIỆM trong paper Mathavan 2010);
u_s=0.2, u_r=0.01 (pooltool defaults).

### Kiểm chứng (chiến dịch 5 verifier đối kháng độc lập)
- `mathavanSolve` (va băng) trùng pooltool chạy bằng Python/numba tới
  **1.8e-14** trên 364 ca — bit-faithful.
- Resolver va bi trùng 2.4e-13 (540 ca); hệ số quartic trùng 1.4e-14.
- Hành vi thật: follow/stun/draw đúng gradient; quy tắc 90°; băng "ăn ngắn";
  ép thuận mở góc/ăn dài, ép nghịch khép góc/hụt lực; topspin tăng tốc bật
  băng; throw 2–5° ở tốc độ chậm, giảm theo tốc độ.
- Gate cuối: 200 cú ngẫu nhiên — **0** vi phạm bảo toàn năng lượng tại mọi
  sự kiện, **0** bi ra ngoài bàn, **0** NaN, tất cả kết thúc, ~1.8ms/cú.
- Các ca biên ĐÃ SỬA (đừng "tối ưu" lại các đoạn có comment "verified
  finding R1..R7"): bi dính băng/dính nhau bị đánh vào, chuỗi bi sát nhau
  (chống bão sự kiện), bi chết dần ở băng (chống sinh năng lượng), va vuông
  góc đối xứng gương, đánh bóng nghiệm quartic kép.

### Giới hạn cần biết (trung thực)
- **2D**: không có bi nhảy; massé chỉ ở mức "curve khi trượt" (strike hỗ trợ
  theta cơ nghiêng nhưng bàn mô phỏng phẳng).
- Mathavan 2010 được xác nhận thực nghiệm với vận tốc pháp tuyến < 2.5 m/s;
  cú mạnh hơn vẫn chạy ổn định nhưng là ngoại suy.
- Thông số nỉ/băng là bàn "nóng" tiêu chuẩn — muốn bàn cũ/chậm chỉnh
  `BALL.u_r` (lăn), `BALL.e_c` (độ nảy băng) trong engine.js.
- Đường vật lý sẽ KHÔNG trùng khít đường hệ diamond (5−4=1...) — hệ diamond
  là xấp xỉ hình học. Đây là feature (so sánh lý thuyết vs thật), không phải bug.

---

## 6. API engine (nếu cần gọi trực tiếp, không qua bridge)

```js
const E = window.CarambaEngine;           // hoặc require('./engine.js')
const b = E.mkBall(x, y);                 // mét
E.strike(b, V0, phi, a, bTip, theta=0);   // V0 m/s; phi rad; a,b tip offset [-1,1]
const res = E.simulateShot([cue, b2, b3], {maxEvents:3000, maxT:60});
res.events;                                // [{t, type, i, j?, rail?}]
res.duration;                              // giây
res.positionAt(iBall, t);                  // trạng thái giải tích chính xác tại t
```
Hằng số: `E.TABLE = {W:1.42, L:2.84}`, `E.BALL.R = 0.03075`.
States: 0 STATIONARY, 1 SPINNING, 2 SLIDING, 3 ROLLING.
**Không sửa engine bằng tay** ngoài khối tham số `BALL`/`CUE`/`TABLE` —
mọi công thức đã được đối chiếu số với pooltool.

---

## 7. Kế hoạch việc cho session mới (gợi ý thứ tự)

1. Nhúng `engine.js` + `caramba-bridge.js` vào `carambanotebook.html`
   (section mới, feature flag `SIM_ENABLED`). Smoke test: console gọi
   `CarambaBridge.simulate(state.currentDrawing.balls, {...})`.
2. Goal 2 trước (ít UX mới nhất): nút ▶ trên Capture screen + animation
   bằng `positionsAt`. Đọc English Compass + speed widget hiện có.
3. Goal 1: gesture chọn hướng nhắm + preview live (debounce ~50ms) +
   nút Accept ghi `paths.cue` vào `drawing.path.points` + lưu `drawing.sim`.
4. Goal 3: mode chơi + `score.valid` + đếm điểm.
5. Test trên WKWebView thật (Capacitor): đo thời gian `simulate` trên
   iPhone đời thấp nhất hỗ trợ; nếu > 16ms thì giảm tần suất preview
   (chỉ simulate khi thả tay).

Câu hỏi mở cho product (quyết trong session mới):
- Auto-path lưu THAY đường vẽ tay hay lưu SONG SONG (2 lớp so sánh)?
- Speed widget hiện tại thang gì (1–9?) → map tuyến tính hay theo cảm giác?
- Có cho chỉnh thông số bàn (nỉ nhanh/chậm) trong Settings không?
```
