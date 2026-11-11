// 歩行解析ロジック（gait_analysis.py の移植）。DOMに依存しない純粋関数。
export let VISIBILITY_THRESHOLD = 0.5;
let ENGINE_NOTE = "MediaPipe Pose Landmarker による動画各フレームの2D推定値";
// 解析エンジンの切り替え（RTMPoseは信頼度の目安が違うため閾値を変える）
export function setEngine(engine) {
  if (engine === "rtmpose") {
    VISIBILITY_THRESHOLD = 0.3;
    ENGINE_NOTE = "RTMPose（Halpe26、人物検出はYOLOX）による動画各フレームの2D推定値。MediaPipe Poseと同じ33点の並びに変換して出力（foot_indexは母趾、visibilityはRTMPoseの信頼度を0〜1に収めた値）。";
  } else {
    VISIBILITY_THRESHOLD = 0.5;
    ENGINE_NOTE = "MediaPipe Pose Landmarker による動画各フレームの2D推定値";
  }
}
export const SKELETON_CONNECTIONS = [
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [27, 29], [29, 31], [24, 26], [26, 28], [28, 30], [30, 32],
];
export const IDS = {
  left: { shoulder: 11, hip: 23, knee: 25, ankle: 27, heel: 29, foot_index: 31 },
  right: { shoulder: 12, hip: 24, knee: 26, ankle: 28, heel: 30, foot_index: 32 },
};
const SIDES = ["left", "right"];
const XY_JOINTS = ["shoulder", "hip", "knee", "ankle"];

const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function angleDegrees(a, b, c) {
  if (!a || !b || !c) return null;
  const ba = [a[0] - b[0], a[1] - b[1]];
  const bc = [c[0] - b[0], c[1] - b[1]];
  const nba = Math.hypot(...ba), nbc = Math.hypot(...bc);
  if (nba < 1e-9 || nbc < 1e-9) return null;
  const cos = (ba[0] * bc[0] + ba[1] * bc[1]) / (nba * nbc);
  const included = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  return round(180 - included, 2); // 伸展位≈0度
}

function vis(lm) { return lm.visibility ?? 1.0; }

export function getPoint(landmarks, id, w, h) {
  const lm = landmarks[id];
  const v = vis(lm);
  if (v != null && v < VISIBILITY_THRESHOLD) return [null, null];
  return [[lm.x * w, lm.y * h], Number(v || 0)];
}

function hipCenter(landmarks, w, h) {
  const pts = [23, 24].map((id) => getPoint(landmarks, id, w, h)[0]).filter(Boolean);
  if (!pts.length) return null;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

export function chooseLeadingPose(poses, w, h, direction) {
  if (!poses || !poses.length) return null;
  let best = null, bestVal = -Infinity;
  poses.forEach((pose, i) => {
    const c = hipCenter(pose, w, h) || bodyCenter(pose, w, h);
    if (c && c[0] * direction > bestVal) { bestVal = c[0] * direction; best = i; }
  });
  return best === null ? null : poses[best];
}

// ---------- 対象者の追跡 ----------
// 体幹の中心（両肩・両股の平均）。可視性に関係なく推定位置を使う
export function bodyCenter(pose, w, h) {
  const ids = [11, 12, 23, 24].filter((i) => pose[i] && Number.isFinite(pose[i].x));
  if (!ids.length) return null;
  return [ids.reduce((s, i) => s + pose[i].x * w, 0) / ids.length, ids.reduce((s, i) => s + pose[i].y * h, 0) / ids.length];
}
function bodySize(pose, w, h) { // 肩の中点〜足首の中点の距離（px）
  const m = (a, b) => [((pose[a].x + pose[b].x) / 2) * w, ((pose[a].y + pose[b].y) / 2) * h];
  const s = m(11, 12), a = m(27, 28);
  const d = Math.hypot(s[0] - a[0], s[1] - a[1]);
  return Number.isFinite(d) && d > 1 ? d : h * 0.3;
}
function bboxContains(pose, w, h, x, y, pad = 0.1) {
  const xs = pose.map((p) => p.x * w), ys = pose.map((p) => p.y * h);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const px = (x1 - x0) * pad, py = (y1 - y0) * pad;
  return x >= x0 - px && x <= x1 + px && y >= y0 - py && y <= y1 + py;
}
// 指定した点（タップ位置）の人。骨格の範囲にタップ位置が入っているか、体幹中心のすぐ近くの人だけを選ぶ
// （その人が検出されていないフレームで、別の人を選ばないため）
export function choosePoseAtPoint(poses, w, h, x, y) {
  let best = null, bestD = Infinity;
  for (const p of poses || []) {
    const c = bodyCenter(p, w, h);
    if (!c) continue;
    const d = Math.hypot(c[0] - x, c[1] - y) / bodySize(p, w, h);
    const inside = bboxContains(p, w, h, x, y, 0);
    if (!inside && d > 0.12) continue;
    const score = d - (inside ? 1 : 0);
    if (score < bestD) { bestD = score; best = p; }
  }
  return best;
}
// フレームをまたいで同じ人を追い続ける。見失ったフレームは null（他の人に乗り換えない）。
// 1秒以上見失ったら、その時点の進行方向で先頭の人を選び直す。
export class TargetTracker {
  constructor(w, h, fps) { this.w = w; this.h = h; this.fps = fps; this.state = null; this.seed = null; this.lost = 0; this.reacquired = 0; }
  seedPoint(x, y) { this.seed = [x, y]; this.state = null; }
  step(poses, frame, dir) {
    const w = this.w, h = this.h;
    poses = poses || [];
    if (!this.state) {
      let p = null;
      if (this.seed) { p = choosePoseAtPoint(poses, w, h, this.seed[0], this.seed[1]); if (p) this.seed = null; }
      else p = chooseLeadingPose(poses, w, h, dir);
      if (p) this._set(p, frame, [0, 0]);
      return p;
    }
    // 前回の骨格を移動量だけずらした予測と、各候補の主要関節（肩・股・膝・足首）の平均距離で比べる
    const st = this.state, df = frame - st.frame || 1, gap = Math.abs(df);
    const gate = Math.max(0.1 * st.size, 0.02 * w) * (1 + 0.05 * (gap - 1));
    let best = null, bestD = Infinity;
    for (const p of poses) {
      const d = poseDistance(p, st.pose, st.v, df, w, h);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best && bestD <= gate) {
      const c = bodyCenter(best, w, h);
      const v = [0.5 * st.v[0] + 0.5 * ((c[0] - st.c[0]) / df), 0.5 * st.v[1] + 0.5 * ((c[1] - st.c[1]) / df)];
      this._set(best, frame, v, st.size);
      return best;
    }
    this.lost++;
    if (gap > this.fps) { // 1秒以上見失った → 選び直し
      this.state = null;
      const p = this.step(poses, frame, dir);
      if (p) this.reacquired++;
      return p;
    }
    return null;
  }
  _set(p, frame, v, prevSize) {
    const size = bodySize(p, this.w, this.h);
    this.state = { pose: p, c: bodyCenter(p, this.w, this.h), v, frame, size: prevSize ? 0.8 * prevSize + 0.2 * size : size };
  }
}
// 左右ペア（肩・股・膝・足首）。横からの映像では左右の取り違えが起きやすいため、
// ペアごとに「そのまま」と「左右入れ替え」の近いほうで距離を測る。体幹（肩・股）を重めにする。
const TRACK_PAIRS = [[11, 12, 2], [23, 24, 2], [25, 26, 1], [27, 28, 1]];
function poseDistance(p, last, v, df, w, h) {
  const d = (a, b) => (p[a] && last[b] ? Math.hypot(p[a].x * w - (last[b].x * w + v[0] * df), p[a].y * h - (last[b].y * h + v[1] * df)) : NaN);
  let s = 0, n = 0;
  for (const [a, b, wt] of TRACK_PAIRS) {
    const straight = (d(a, a) + d(b, b)) / 2, swapped = (d(a, b) + d(b, a)) / 2;
    const m = Math.min(straight, swapped);
    if (Number.isFinite(m)) { s += m * wt; n += wt; }
  }
  return n ? s / n : Infinity;
}
// 全フレームの候補から対象者を選ぶ。
// 指定なし：最初の2秒で人数が最も多いフレームで進行方向の先頭の人を選び、そこから前後両方向に追跡。
// タップ指定あり：指定フレームでタップ位置に近い人を選び、そこから前後に追跡。
export function trackAll(cands, w, h, fps, dirAt, seed = null) {
  const n = cands.length, sel = new Array(n).fill(null);
  let start;
  if (seed) start = Math.min(n - 1, Math.max(0, seed.frame));
  else {
    start = -1; let most = 0;
    for (let i = 0; i < Math.min(n, Math.round(fps * 2)); i++) if ((cands[i] || []).length > most) { most = cands[i].length; start = i; }
    if (start < 0) start = cands.findIndex((c) => c && c.length);
  }
  if (start < 0) return { sel, lost: 0, reacquired: 0, seeded: false };
  const fwd = new TargetTracker(w, h, fps);
  if (seed) fwd.seedPoint(seed.x * w, seed.y * h);
  let first = fwd.step(cands[start], start, dirAt(start));
  for (let k = 1; !first && k < fps && start + 1 < n; k++) { start += 1; first = fwd.step(cands[start], start, dirAt(start)); }
  sel[start] = first;
  const bwd = new TargetTracker(w, h, fps);
  if (fwd.state) bwd.state = { ...fwd.state };
  for (let i = start + 1; i < n; i++) sel[i] = fwd.step(cands[i], i, dirAt(i));
  for (let i = start - 1; i >= 0; i--) sel[i] = bwd.step(cands[i], i, dirAt(i));
  return { sel, lost: fwd.lost + bwd.lost, reacquired: fwd.reacquired + bwd.reacquired, seeded: !!seed };
}
// 対象者の骨盤中心が最初の進行方向に最も進んだフレーム（往復の折り返し点）
export function turnFrameFromSelection(sel, w, h, dir1, fps) {
  const xs = sel.map((p) => (p ? (hipCenter(p, w, h) || bodyCenter(p, w, h) || [null])[0] : null));
  const sm = smoothSeries(xs, fps);
  if (!sm) return null;
  let best = 0;
  sm.forEach((x, i) => { if (x * dir1 > sm[best] * dir1) best = i; });
  // 端の場合は折り返しなし
  if (best < fps * 0.5 || best > sm.length - 1 - fps * 0.5) return null;
  const peak = sm[best] * dir1, after = Math.min(...sm.slice(best).map((x) => x * dir1));
  return peak - after > w * 0.05 ? best : null;
}

// 出力列（Pythonの行dictのキー順に合わせる）
export function exportColumns() {
  const cols = ["frame", "time_seconds", "timestamp_ms", "image_width_px", "image_height_px"];
  for (const s of SIDES) {
    for (const j of XY_JOINTS) for (const a of ["x_norm", "y_norm", "x_px", "y_px", "visibility"]) cols.push(`${s}_${j}_${a}`);
    cols.push(`${s}_hip_flexion_deg`, `${s}_knee_flexion_deg`);
    for (const a of ["x_norm", "y_norm", "x_px", "y_px"]) cols.push(`${s}_foot_index_${a}`);
  }
  return cols;
}

export function buildRow(frameIndex, fps, timestampMs, w, h, pose) {
  const row = { frame: frameIndex, time_seconds: round(frameIndex / fps, 4), timestamp_ms: timestampMs, image_width_px: w, image_height_px: h };
  for (const s of SIDES) {
    const id = IDS[s];
    if (pose) {
      for (const j of [...XY_JOINTS, "foot_index"]) {
        const lm = pose[id[j]];
        row[`${s}_${j}_x_norm`] = round(lm.x, 6);
        row[`${s}_${j}_y_norm`] = round(lm.y, 6);
        row[`${s}_${j}_x_px`] = round(lm.x * w, 2);
        row[`${s}_${j}_y_px`] = round(lm.y * h, 2);
        row[`${s}_${j}_visibility`] = lm.visibility != null ? round(lm.visibility, 4) : null;
      }
      const [sh, shv] = getPoint(pose, id.shoulder, w, h);
      const [hp, hpv] = getPoint(pose, id.hip, w, h);
      const [kn, knv] = getPoint(pose, id.knee, w, h);
      const [an, anv] = getPoint(pose, id.ankle, w, h);
      const [ft, ftv] = getPoint(pose, id.foot_index, w, h);
      row[`${s}_hip_flexion_deg`] = angleDegrees(sh, hp, kn);
      row[`${s}_knee_flexion_deg`] = angleDegrees(hp, kn, an);
      // 可視性0.5未満は空欄（Python版と同じ上書き）
      row[`${s}_shoulder_visibility`] = shv;
      row[`${s}_hip_visibility`] = hpv;
      row[`${s}_knee_visibility`] = knv;
      row[`${s}_ankle_visibility`] = anv;
      row[`_${s}_foot_index_x`] = ft ? ft[0] : null;
      row[`_${s}_foot_index_visibility`] = ftv;
      row[`_${s}_hip_x`] = hp ? hp[0] : null;
      const [he] = getPoint(pose, id.heel, w, h);
      row[`_${s}_heel_x`] = he ? he[0] : null;
      row[`_${s}_heel_y`] = he ? he[1] : null;
      row[`_${s}_toe_y`] = ft ? ft[1] : null;
    } else {
      row[`${s}_hip_flexion_deg`] = null;
      row[`${s}_knee_flexion_deg`] = null;
      row[`_${s}_foot_index_x`] = null;
      row[`_${s}_foot_index_visibility`] = null;
      row[`_${s}_hip_x`] = null;
    }
  }
  return row;
}

// pandas: interpolate(method="linear", limit_direction="both")
export function interpolateBoth(values) {
  const v = values.map((x) => (isNum(x) ? x : NaN));
  const valid = [];
  v.forEach((x, i) => { if (!Number.isNaN(x)) valid.push(i); });
  if (!valid.length) return v;
  const out = v.slice();
  for (let i = 0; i < valid[0]; i++) out[i] = v[valid[0]];
  const last = valid[valid.length - 1];
  for (let i = last + 1; i < v.length; i++) out[i] = v[last];
  for (let k = 0; k < valid.length - 1; k++) {
    const a = valid[k], b = valid[k + 1];
    for (let i = a + 1; i < b; i++) out[i] = v[a] + ((v[b] - v[a]) * (i - a)) / (b - a);
  }
  return out;
}

const pyRound = (x) => { // Pythonのround（偶数丸め）
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-12) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
};

export function contactFrames(values, fps, width, direction) {
  const n = values.length;
  const filled = interpolateBoth(values);
  if (n < 3 || !filled.every((x) => Number.isFinite(x))) return [];
  const win = Math.max(3, pyRound(fps * 0.12) | 1);
  const half = Math.floor(win / 2);
  const smooth = filled.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + (win - 1 - half)); j++) { s += filled[j]; c++; }
    return s / c;
  });
  const sign = direction >= 0 ? 1 : -1;
  const fwd = smooth.map((x) => x * sign);
  const minGap = Math.max(3, Math.trunc(fps * 0.5));
  const radius = Math.max(minGap, Math.trunc(fps * 0.45));
  const prominence = width * 0.02;
  const excl = Math.max(1, Math.floor(minGap / 3));
  const cand = [];
  for (let i = 1; i < n - 1; i++) {
    if (fwd[i] < fwd[i - 1] || fwd[i] < fwd[i + 1]) continue;
    const L = Math.max(0, i - radius), R = Math.min(n, i + radius + 1);
    let localMin = Infinity, any = false;
    for (let j = L; j < R; j++) if (Math.abs(j - i) >= excl) { any = true; if (fwd[j] < localMin) localMin = fwd[j]; }
    if (!any) continue;
    if (fwd[i] - localMin >= prominence) cand.push([i, fwd[i] - localMin]);
  }
  cand.sort((a, b) => b[1] - a[1]);
  const sel = [];
  for (const [f] of cand) if (sel.every((k) => Math.abs(f - k) >= minGap)) sel.push(f);
  return sel.sort((a, b) => a - b);
}

function interp(x, xp, fp) {
  if (x <= xp[0]) return fp[0];
  if (x >= xp[xp.length - 1]) return fp[fp.length - 1];
  let k = 0;
  while (xp[k + 1] < x) k++;
  const t = (x - xp[k]) / (xp[k + 1] - xp[k]);
  return fp[k] + t * (fp[k + 1] - fp[k]);
}

export function normalizedCycles(rows, side, fps, width) {
  const hipX = rows.map((r) => r[`_${side}_hip_x`]).filter(isNum);
  const direction = hipX.length > 1 ? hipX[hipX.length - 1] - hipX[0] : 1.0;
  const events = contactFrames(rows.map((r) => r[`_${side}_foot_index_x`]), fps, width, direction);
  const cycles = [];
  for (let k = 0; k < events.length - 1; k++) if (events[k + 1] - events[k] >= fps * 0.5) cycles.push([events[k], events[k + 1]]);
  if (!cycles.length) {
    throw new Error(`${side === "left" ? "左" : "右"}側の足の接地を2回以上検出できず、1歩行周期を作れませんでした。全身と足先が見える横向きの動画を使い、動画の前後に歩行中の区間を含めてください。`);
  }
  const phase = Array.from({ length: 101 }, (_, i) => i);
  const cycleData = phase.map((p) => ({ gait_cycle_percent: p }));
  for (const s of SIDES) for (const joint of ["knee", "hip"]) {
    const series = rows.map((r) => r[`${s}_${joint}_flexion_deg`]);
    const mats = cycles.map(([a, b]) => {
      const seg = interpolateBoth(series.slice(a, b + 1));
      if (seg.length < 2 || seg.every(Number.isNaN)) return phase.map(() => NaN);
      const xp = seg.map((_, o) => (100 * o) / (seg.length - 1));
      return phase.map((p) => interp(p, xp, seg));
    });
    phase.forEach((p) => {
      const vals = mats.map((m) => m[p]).filter((x) => !Number.isNaN(x));
      cycleData[p][`${s}_${joint}_mean_deg`] = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    });
  }
  const r3 = (x) => round(x, 3);
  const eventsTable = cycles.map(([a, b], i) => ({
    side, cycle: i + 1, start_contact_frame: a, start_time_seconds: r3(a / fps),
    next_contact_frame: b, next_contact_time_seconds: r3(b / fps), cycle_duration_seconds: r3((b - a) / fps),
  }));
  return { cycleData, events: eventsTable };
}

export function chooseCycleSide(rows) {
  const score = (s) => rows.reduce((t, r) => t + (isNum(r[`_${s}_foot_index_visibility`]) ? r[`_${s}_foot_index_visibility`] : 0), 0) / rows.length;
  return score("right") > score("left") ? "right" : "left";
}

export function notesTable(cycleSide, nCycles, perCycleRef = null) {
  const rows = [
    ["内容", ENGINE_NOTE],
    ["角度の定義", "膝・股関節とも、伸展位を約0度とする屈曲方向の角度（度）。股関節は肩-股-膝の2D角度から算出。"],
    ["欠損値", `ランドマークが見えない、または可視性が${VISIBILITY_THRESHOLD}未満の場合は空欄`],
    ["歩行周期", `${cycleSide}足の足先位置の前方極値から接地を推定し、連続する接地間を0〜100%に正規化。検出周期数: ${nCycles}。接地タイミングは推定値です。`],
    ["座標", "関節点ごとに画像内の正規化X/Y（0〜1）とピクセルX/Yを記録。画像左上が(0,0)、右下方向へ値が増加します。visibilityは推定可視性です。"],
    ["注意", "横からの単眼動画による推定であり、臨床測定・診断には使用できません。撮影角度、隠れ、衣服、左右の重なり等で誤差が生じます。"],
  ];
  if (perCycleRef) rows[3] = ["歩行周期", perCycleNote(perCycleRef) + ` 検出周期数: ${nCycles}。`];
  return rows;
}

// ---------- 一歩行周期ごとの解析（踵・つま先の最下点による周期の開始） ----------
// 基準足が対側足より前にある区間で、最も前に出た（前方位置が最大に達した最初の）時点の踵とつま先の高さを比べ、
// 踵が低ければ踵、つま先が低ければつま先の上下座標が最下点に達した最初のフレームを周期の開始とする。
// 画像座標はyが下向きに増えるので、「低い」「最下点」はyが大きいことを意味する。
function smoothSeries(values, fps) {
  const v = interpolateBoth(values);
  if (!v.length || !v.every(Number.isFinite)) return null;
  const win = Math.max(3, pyRound(fps * 0.12) | 1), half = Math.floor(win / 2), n = v.length;
  return v.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += v[j]; c++; }
    return s / c;
  });
}
export const LOWEST_TOLERANCE_RATIO = 0.003; // 最下点の判定幅（画像の高さに対する比）

export function heelToeContacts(rows, refSide, direction, fps, height) {
  const oth = refSide === "left" ? "right" : "left";
  const S = (k) => smoothSeries(rows.map((r) => r[k]), fps);
  const rHx = S(`_${refSide}_heel_x`), rTx = S(`_${refSide}_foot_index_x`);
  const rHy = S(`_${refSide}_heel_y`), rTy = S(`_${refSide}_toe_y`);
  const rawHy = interpolateBoth(rows.map((r) => r[`_${refSide}_heel_y`])), rawTy = interpolateBoth(rows.map((r) => r[`_${refSide}_toe_y`]));
  const oHx = S(`_${oth}_heel_x`), oTx = S(`_${oth}_foot_index_x`);
  if (!rHx || !rTx || !rHy || !rTy || !oHx || !oTx) return [];
  const n = rows.length, dir = direction >= 0 ? 1 : -1;
  const posR = rHx.map((x, i) => ((x + rTx[i]) / 2) * dir);
  const posO = oHx.map((x, i) => ((x + oTx[i]) / 2) * dir);
  const minLen = Math.max(3, Math.round(fps * 0.1));
  const segs = [];
  let st = -1;
  for (let i = 0; i <= n; i++) {
    const f = i < n && posR[i] > posO[i];
    if (f && st < 0) st = i;
    if (!f && st >= 0) { if (i - st >= minLen) segs.push([st, i - 1]); st = -1; }
  }
  const tol = height * LOWEST_TOLERANCE_RATIO;
  const tolX = height * LOWEST_TOLERANCE_RATIO;
  const out = [];
  for (const [a, b] of segs) {
    // 「最も前に出た時点」＝前方位置が区間の最大値に最初に達したフレーム（立脚中は足が止まるため最初の到達点を使う）
    let pmax = -Infinity;
    for (let i = a; i <= b; i++) pmax = Math.max(pmax, posR[i]);
    let peak = a;
    for (let i = a; i <= b; i++) if (posR[i] >= pmax - tolX) { peak = i; break; }
    let hy = 0, ty = 0, c = 0;
    for (let i = Math.max(a, peak - 2); i <= Math.min(b, peak + 2); i++) { hy += rHy[i]; ty += rTy[i]; c++; }
    const type = hy / c >= ty / c ? "heel" : "toe";
    const y = type === "heel" ? rHy : rTy;
    let ymax = -Infinity;
    for (let i = a; i <= b; i++) ymax = Math.max(ymax, y[i]);
    let frame = a;
    for (let i = a; i <= b; i++) if (y[i] >= ymax - tol) { frame = i; break; }
    // 平滑化による遅れを補正：平滑化前の座標で、同じ高さに最初に達したフレームまでさかのぼる
    const raw = type === "heel" ? rawHy : rawTy, half = Math.floor(Math.max(3, pyRound(fps * 0.12) | 1) / 2);
    for (let i = Math.max(a, frame - half); i <= frame; i++) if (Number.isFinite(raw[i]) && raw[i] >= ymax - tol) { frame = i; break; }
    // 区間の端（動画の最初・最後で途切れた区間）は除外
    if (a === 0 || b === n - 1) continue;
    out.push({ frame, type, front_start: a, front_end: b, most_forward: peak });
  }
  return out;
}

function normalize101(series) {
  const phase = Array.from({ length: 101 }, (_, i) => i);
  const seg = interpolateBoth(series);
  if (seg.length < 2 || seg.every(Number.isNaN)) return phase.map(() => NaN);
  const xp = seg.map((_, o) => (100 * o) / (seg.length - 1));
  return phase.map((p) => interp(p, xp, seg));
}

export function perCycleAnalysis(rows, refSide, direction, fps, height, segments = null) {
  // segments: [{a, b, dir, label}]（往復のとき）。片道は全体を1区間とする
  const segs = segments || [{ a: 0, b: rows.length - 1, dir: direction, label: "片道" }];
  const contacts = [], cycles = [];
  for (const sg of segs) {
    const sub = rows.slice(sg.a, sg.b + 1);
    const cs = heelToeContacts(sub, refSide, sg.dir, fps, height).map((c) => ({ ...c, frame: c.frame + sg.a, segment: sg.label }));
    contacts.push(...cs);
    for (let k = 0; k < cs.length - 1; k++) {
      const a = cs[k].frame, b = cs[k + 1].frame, dur = (b - a) / fps;
      if (dur < 0.5 || dur > 5) continue;
      cycles.push({ a, b, type: cs[k].type, nextType: cs[k + 1].type, segment: sg.label });
    }
  }
  if (!cycles.length) {
    throw new Error(`${refSide === "left" ? "左" : "右"}足を基準にした歩行周期を検出できませんでした。踵とつま先が見える真横からの動画で、基準足が2回以上接地する区間を含めてください。`);
  }
  const keys = [];
  for (const s of SIDES) for (const j of ["knee", "hip"]) keys.push([s, j]);
  const r3 = (x) => round(x, 3), r2 = (x) => (Number.isFinite(x) ? round(x, 2) : null);
  const typeJ = (t) => (t === "heel" ? "踵" : "つま先");
  const list = cycles.map((c, idx) => {
    const norm = Array.from({ length: 101 }, (_, p) => ({ cycle: idx + 1, segment: c.segment, gait_cycle_percent: p }));
    const summary = {
      cycle: idx + 1, segment: c.segment, reference_side: refSide, start_contact: typeJ(c.type),
      start_frame: c.a, start_time_seconds: r3(c.a / fps), end_frame: c.b, end_time_seconds: r3(c.b / fps),
      cycle_duration_seconds: r3((c.b - c.a) / fps),
    };
    let det = 0;
    for (let i = c.a; i <= c.b; i++) if (rows[i].left_knee_flexion_deg != null || rows[i].right_knee_flexion_deg != null) det++;
    summary.detected_frames_percent = round((100 * det) / (c.b - c.a + 1), 1);
    for (const [s, j] of keys) {
      const raw = rows.slice(c.a, c.b + 1).map((r) => r[`${s}_${j}_flexion_deg`]);
      const nv = normalize101(raw);
      nv.forEach((v, p) => (norm[p][`${s}_${j}_deg`] = Number.isNaN(v) ? null : v));
      const valid = raw.filter(isNum);
      const mx = valid.length ? Math.max(...valid) : NaN, mn = valid.length ? Math.min(...valid) : NaN;
      summary[`${s}_${j}_max_deg`] = r2(mx);
      summary[`${s}_${j}_min_deg`] = r2(mn);
      summary[`${s}_${j}_range_deg`] = r2(mx - mn);
    }
    return { summary, norm, a: c.a, b: c.b };
  });
  const cycleData = meanOfNorms(list.map((c) => c.norm));
  const events = list.map((c) => ({
    side: refSide, cycle: c.summary.cycle, start_contact_frame: c.a, start_time_seconds: c.summary.start_time_seconds,
    next_contact_frame: c.b, next_contact_time_seconds: c.summary.end_time_seconds, cycle_duration_seconds: c.summary.cycle_duration_seconds,
    start_contact: c.summary.start_contact, segment: c.summary.segment,
  }));
  return { list, cycleData, events, contacts };
}

export const SUMMARY_COLUMNS = (() => {
  const c = ["cycle", "segment", "reference_side", "start_contact", "start_frame", "start_time_seconds", "end_frame", "end_time_seconds", "cycle_duration_seconds", "detected_frames_percent"];
  for (const s of SIDES) for (const j of ["knee", "hip"]) c.push(`${s}_${j}_max_deg`, `${s}_${j}_min_deg`, `${s}_${j}_range_deg`);
  return c;
})();
export const NORM_COLUMNS = ["cycle", "segment", "gait_cycle_percent", "left_knee_deg", "left_hip_deg", "right_knee_deg", "right_hip_deg"];

export function perCycleNote(refSide) {
  return `${refSide === "left" ? "左" : "右"}足を基準足とし、基準足が対側足より前にある区間で最も前に出た時点の踵とつま先の高さを比較。踵が低ければ踵、つま先が低ければつま先の上下座標が最下点（画像の高さの${LOWEST_TOLERANCE_RATIO * 100}%以内）に最初に達したフレームを周期の開始とし、次の開始までを1周期（0〜100%）とした。座標は移動平均で平滑化。`;
}

// 周期別の正規化データの平均（従来の正規化グラフと同じ列名）
export function meanOfNorms(norms) {
  return Array.from({ length: 101 }, (_, p) => {
    const o = { gait_cycle_percent: p };
    for (const s of SIDES) for (const j of ["knee", "hip"]) {
      const vals = norms.map((n) => n[p][`${s}_${j}_deg`]).filter(isNum);
      o[`${s}_${j}_mean_deg`] = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    }
    return o;
  });
}

// ---------- 往復歩行 ----------
// 解析中（オンライン）に折り返しを見つけて、先頭の人物を選ぶ向きを切り替える
export class TurnTracker {
  constructor(dir1, dir2, width) { this.dir1 = dir1; this.dir2 = dir2; this.dir = dir1; this.width = width; this.max = -Infinity; this.maxFrame = null; this.turnFrame = null; }
  update(frame, pose, w, h) {
    if (this.dir2 == null || this.turnFrame != null || !pose) return;
    const c = hipCenter(pose, w, h);
    if (!c) return;
    const p = c[0] * this.dir1;
    if (p > this.max) { this.max = p; this.maxFrame = frame; }
    else if (this.max - p > this.width * 0.05) { this.turnFrame = this.maxFrame; this.dir = this.dir2; }
  }
}
// 折り返し点の前後で、骨盤中心の水平速度が歩行速度の30%未満の区間（＋0.2秒）を方向転換として除外
export function roundTripSegments(rows, turnFrame, dir1, dir2, fps) {
  const n = rows.length;
  const hx = smoothSeries(rows.map((r) => {
    const a = r._left_hip_x, b = r._right_hip_x;
    return isNum(a) && isNum(b) ? (a + b) / 2 : isNum(a) ? a : isNum(b) ? b : null;
  }), fps);
  if (!hx) return null;
  const v = hx.map((x, i) => Math.abs((hx[Math.min(n - 1, i + 1)] - hx[Math.max(0, i - 1)]) * fps / 2));
  const far = v.filter((_, i) => Math.abs(i - turnFrame) > fps);
  const ref = far.length ? far.slice().sort((a, b) => a - b)[Math.floor(far.length / 2)] : 0;
  const thr = ref * 0.3, margin = Math.round(fps * 0.2);
  // 折り返し点に最も近い「遅い」フレームから広げる（折り返し点自体の速度がノイズで高い場合に備える）
  let c0 = turnFrame;
  for (let d = 0; d <= Math.round(fps); d++) {
    if (turnFrame - d >= 0 && v[turnFrame - d] < thr) { c0 = turnFrame - d; break; }
    if (turnFrame + d < n && v[turnFrame + d] < thr) { c0 = turnFrame + d; break; }
  }
  let s = c0, e = c0;
  while (s > 0 && v[s - 1] < thr) s--;
  while (e < n - 1 && v[e + 1] < thr) e++;
  s = Math.max(0, s - margin); e = Math.min(n - 1, e + margin);
  const segs = [];
  if (s - 1 >= 1) segs.push({ a: 0, b: s - 1, dir: dir1, label: "往路" });
  if (e + 1 <= n - 2) segs.push({ a: e + 1, b: n - 1, dir: dir2, label: "復路" });
  return { segments: segs, turnStart: s, turnEnd: e, turnFrame };
}
export function roundTripNote(dir1) {
  const d = (x) => (x > 0 ? "右" : "左");
  return `往復（${d(dir1)}へ→${d(-dir1)}へ）。骨盤中心が${d(dir1)}方向に最も進んだ時点を折り返し点とし、その前後で骨盤中心の水平速度が歩行時の中央値の30%未満の区間に前後0.2秒を加えた範囲を方向転換として除外。往路・復路それぞれで歩行周期を検出し、方向転換をまたぐ周期は作らない。複数人が映る場合、往路は${d(dir1)}方向、復路は${d(-dir1)}方向で先頭の人物を追跡。`;
}

// ---------- 光刺激の検出 ----------
// 指定した範囲の平均輝度（0〜255）から、光が点いた瞬間（立ち上がり）を検出する。
// 基準（消灯）＝下位10%の値、振幅＝最大値−基準。振幅が12未満なら光なしとみなす。
// 50%を超えたら点灯、30%を下回ったら消灯（ヒステリシス）。点灯の開始は、立ち上がりをさかのぼって
// 「基準＋max(振幅の15%, 消灯時のばらつき×3)」を最初に超えたフレームとする。
export function detectLightEvents(vals, fps, f0 = 0) {
  const n = vals.length;
  if (!n) return { events: [], on: [], info: null };
  const sorted = vals.slice().sort((a, b) => a - b);
  const base = sorted[Math.floor(n * 0.1)], peak = sorted[n - 1], amp = peak - base;
  const offVals = vals.filter((v) => v <= base + amp * 0.2);
  const mean = offVals.reduce((s, v) => s + v, 0) / Math.max(1, offVals.length);
  const sd = Math.sqrt(offVals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, offVals.length));
  const info = { base: round(base, 1), peak: round(peak, 1), amplitude: round(amp, 1) };
  const on = new Array(n).fill(0);
  if (amp < 12) return { events: [], on, info: { ...info, note: "明るさの変化が小さく、光刺激を検出できませんでした" } };
  const thrOn = base + amp * 0.5, thrOff = base + amp * 0.3, thrStart = base + Math.max(amp * 0.15, sd * 3);
  const events = [];
  let state = false, cur = null;
  for (let i = 0; i < n; i++) {
    if (!state && vals[i] >= thrOn) {
      let s = i;
      while (s > 0 && vals[s - 1] >= thrStart && (events.length === 0 || s - 1 > events[events.length - 1]._off)) s--;
      cur = { _on: s, _peak: vals[i] }; state = true;
    } else if (state) {
      cur._peak = Math.max(cur._peak, vals[i]);
      if (vals[i] < thrOff) { cur._off = i; events.push(cur); state = false; cur = null; }
    }
  }
  if (state) { cur._off = null; events.push(cur); }
  const r3 = (x) => round(x, 3);
  const out = events.map((e, k) => {
    const endIdx = e._off == null ? n : e._off;
    for (let i = e._on; i < endIdx; i++) on[i] = 1;
    const onF = e._on + f0, offF = e._off == null ? null : e._off + f0;
    return {
      event: k + 1, onset_frame: onF, onset_time_seconds: r3(onF / fps),
      offset_frame: offF, offset_time_seconds: offF == null ? null : r3(offF / fps),
      duration_seconds: offF == null ? null : r3((offF - onF) / fps), peak_brightness: round(e._peak, 1),
    };
  });
  return { events: out, on, info: { ...info, threshold_on: round(thrOn, 1), threshold_start: round(thrStart, 1) } };
}
export const LIGHT_COLUMNS = ["event", "onset_frame", "onset_time_seconds", "offset_frame", "offset_time_seconds", "duration_seconds", "peak_brightness"];
export const LIGHT_NOTE = "指定した範囲の平均輝度（0.299R+0.587G+0.114B、0〜255）をフレームごとに計算。下位10%の値を消灯時の基準、最大値との差を振幅とし、振幅の50%を超えたら点灯と判定（30%を下回ったら消灯）。点灯の開始フレームは、立ち上がりをさかのぼって基準＋max(振幅の15%, 消灯時のばらつき×3)を最初に超えたフレーム。時刻の精度は1フレーム（30fpsで約33ms、60fpsで約17ms）。";
