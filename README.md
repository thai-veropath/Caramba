# Caramba Sim — Mô phỏng bi-a 3 băng

Web app mô phỏng carom/3-cushion billiards với engine vật lý **event-based**
(không tích phân theo bước thời gian — giải nghiệm giải tích cho từng chuyển
động và từng sự kiện), port từ [pooltool](https://github.com/ekiefl/pooltool),
bản mô phỏng bi-a tham chiếu mã nguồn mở.

**Chơi tại:** https://thai-veropath.github.io/Caramba/

## Kiến trúc

- `engine.js` — engine vật lý (đơn vị SI: mét, kg, rad/s; chạy được cả Node lẫn browser)
- `index.html` — UI (canvas, nhắm bằng kéo tay, chọn điểm chạm cơ, đường dự đoán)

## Mô hình vật lý

| Thành phần | Mô hình | Nguồn |
|---|---|---|
| Chuyển động bi | Nghiệm giải tích trượt → lăn → xoay → dừng | pooltool `physics/evolve` |
| Phát hiện sự kiện | Va bi: nghiệm quartic; va băng: nghiệm quadratic; chuyển pha: công thức đóng | pooltool `evolution/event_based/solve` |
| Cú đánh | Instantaneous-point + độ lệch squirt | Alciatore TP A-30, A-31 |
| Va bi | Mathavan et al. 2014 (tích phân xung lực, ma sát bi–bi và bi–bàn trong va chạm) | [Sports Eng 17, 227–237](https://doi.org/10.1007/s12283-014-0158-y) |
| Va băng | Mathavan et al. 2010 (nén + hồi phục theo công, băng chạm trên tâm bi) | [Proc IMechE Part C 224(9)](https://doi.org/10.1243/09544062JMES1964) |
| Ma sát bi–bi | Đường cong Alciatore μ(v) phụ thuộc tốc độ trượt | TP A-14 |

Thông số: bi carom Ø61.5mm, 210g; bàn 2.84×1.42m; băng cao 37mm;
e_băng=0.98, μ_băng=0.14 (giá trị đo thực nghiệm trong Mathavan 2010).

## Kiểm chứng

Port được kiểm chứng đối kháng bằng harness Node độc lập:

- `mathavanSolve` trùng pooltool (chạy qua numba) tới **1.8e-14** trên 64+300 ca.
- Hệ số quartic va bi trùng tới 1.4e-14; resolver va bi trùng tới 2.4e-13 (540 ca).
- 200 cú ngẫu nhiên: **0** vi phạm bảo toàn năng lượng tại mọi sự kiện, **0** bi
  ra ngoài bàn, **0** NaN, tất cả kết thúc; ~1.8ms/cú.
- Hành vi thật: follow/stun/draw đúng gradient; quy tắc 90°; băng "ăn ngắn" khi
  không xoáy; ép phê thuận mở góc/ăn dài, ép phê nghịch khép góc/hụt lực;
  topspin tăng tốc độ bật băng; throw 2–5° ở tốc độ chậm.
- Các ca biên đã xử lý: bi dính băng/dính nhau bị đánh thẳng vào, chuỗi bi sát
  nhau (chống bão sự kiện), bi chết dần ở băng (chống sinh năng lượng),
  va vuông góc đối xứng gương.

## Chạy thử local

```bash
python3 -m http.server 8000   # rồi mở http://localhost:8000
```

Test engine trong Node:

```js
const E = require('./engine.js');
const cue = E.mkBall(0.71, 1.0);
E.strike(cue, 3.0, Math.PI/2, 0, 0.3);   // V0=3 m/s, hướng +y, follow
const res = E.simulateShot([cue]);
console.log(res.events.length, 'events,', res.duration.toFixed(2), 's');
```
