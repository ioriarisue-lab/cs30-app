// RTMPose（Halpe26）による姿勢推定。rtmlib（BodyWithFeet）の前処理・後処理に準拠。
// 人物検出: YOLOX（humanart）→ 姿勢推定: RTMPose → MediaPipe Poseと同じ33点の並びに変換して返す。
let ort = null;
async function loadOrt() {
  if (ort) return ort;
  ort = await import("./ort.webgpu.min.mjs");
  ort.env.wasm.wasmPaths = new URL("./", location.href).href;
  ort.env.wasm.numThreads = 1; // GitHub Pagesではマルチスレッド不可
  ort.env.logLevel = "error";
  return ort;
}

export const RTM_VIS_THRESHOLD = 0.3; // rtmlibの既定のキーポイント閾値

// Halpe26 → MediaPipe 33点のインデックス対応
const MAP = {
  0: 0, 2: 1, 5: 2, 7: 3, 8: 4, // 鼻・目・耳
  11: 5, 12: 6, 13: 7, 14: 8, 15: 9, 16: 10, // 肩・肘・手首
  23: 11, 24: 12, 25: 13, 26: 14, 27: 15, 28: 16, // 股・膝・足首
  29: 24, 30: 25, // 踵
  31: 20, 32: 21, // 足先（母趾）
};

async function createSession(bytes, pref) {
  const o = await loadOrt();
  const tries = pref === "cpu" ? [["wasm"]] : ["gpu" in navigator ? ["webgpu"] : null, ["wasm"]].filter(Boolean);
  let last;
  for (const ep of tries) {
    try { const s = await o.InferenceSession.create(bytes, { executionProviders: ep, graphOptimizationLevel: "all" }); s._ep = ep[0]; return s; }
    catch (e) { last = e; }
  }
  throw last;
}

function inputHW(session, fallback) {
  try {
    const m = session.inputMetadata && session.inputMetadata[0];
    const sh = m && m.shape;
    if (sh && sh.length === 4 && Number.isFinite(sh[2]) && Number.isFinite(sh[3])) return [sh[2], sh[3]];
  } catch {}
  return fallback;
}

function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  return [c, c.getContext("2d", { willReadFrequently: true })];
}

export class RTMPoseEstimator {
  static async create(detBytes, poseBytes, pref = "auto") {
    const self = new RTMPoseEstimator();
    const wrap = async (b, label) => {
      try { return await createSession(b, pref); }
      catch (e) { throw new Error(`${label}を読み込めませんでした。rtmlibのonnx_sdk版の .onnx か確認してください（${typeof e === "object" && e && e.message ? e.message : "形式エラー"}）`); }
    };
    self.det = await wrap(detBytes, "人物検出モデル");
    self.pose = await wrap(poseBytes, "姿勢推定モデル");
    self.detHW = inputHW(self.det, null);
    self.poseHW = inputHW(self.pose, [256, 192]);
    if (!self.detHW) self.detHW = await self._probeDet();
    [self.dc, self.dctx] = makeCanvas(self.detHW[1], self.detHW[0]);
    [self.pc, self.pctx] = makeCanvas(self.poseHW[1], self.poseHW[0]);
    self.maxPersons = 3;
    return self;
  }
  get backend() { return this.det._ep === "webgpu" || this.pose._ep === "webgpu" ? "GPU (WebGPU)" : "CPU (WASM)"; }
  async _probeDet() { // 入力サイズが取れない場合に試す
    for (const s of [416, 640, 320]) {
      try { await this.det.run({ [this.det.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * s * s), [1, 3, s, s]) }); return [s, s]; } catch {}
    }
    return [640, 640];
  }
  close() { try { this.det.release(); this.pose.release(); } catch {} }

  // 人物検出（YOLOX）：上左寄せのレターボックス、パディング114、BGR・0〜255のまま
  async detect(src, W, H) {
    const [h, w] = this.detHW, ratio = Math.min(h / H, w / W);
    const ctx = this.dctx;
    ctx.fillStyle = "rgb(114,114,114)"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, W, H, 0, 0, Math.trunc(W * ratio), Math.trunc(H * ratio));
    const px = ctx.getImageData(0, 0, w, h).data, n = w * h, t = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { t[i] = px[i * 4 + 2]; t[n + i] = px[i * 4 + 1]; t[2 * n + i] = px[i * 4]; }
    const out = await this.det.run({ [this.det.inputNames[0]]: new ort.Tensor("float32", t, [1, 3, h, w]) });
    const o0 = out[this.det.outputNames[0]];
    const labels = this.det.outputNames[1] ? out[this.det.outputNames[1]] : null;
    return decodeDetections(o0, labels, ratio, h, w);
  }

  // 姿勢推定（RTMPose）：bbox→中心・スケール（1.25倍）→縦横比補正→切り出し、RGBを平均・標準偏差で正規化
  async estimate(src, W, H, box) {
    const [h, w] = this.poseHW;
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    let sw = (box[2] - box[0]) * 1.25, sh = (box[3] - box[1]) * 1.25;
    const ar = w / h;
    if (sw > sh * ar) sh = sw / ar; else sw = sh * ar;
    const ctx = this.pctx;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, cx - sw / 2, cy - sh / 2, sw, sh, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, n = w * h, t = new Float32Array(3 * n);
    const mean = [123.675, 116.28, 103.53], std = [58.395, 57.12, 57.375];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) t[c * n + i] = (px[i * 4 + c] - mean[c]) / std[c];
    const out = await this.pose.run({ [this.pose.inputNames[0]]: new ort.Tensor("float32", t, [1, 3, h, w]) });
    let sx = out.simcc_x, sy = out.simcc_y;
    if (!sx || !sy) {
      const [a, b] = this.pose.outputNames.map((k) => out[k]);
      [sx, sy] = a.dims[2] <= b.dims[2] ? [a, b] : [b, a];
    }
    return decodeSimcc(sx, sy, [w, h], [cx, cy], [sw, sh]);
  }

  // MediaPipeのdetectForVideoと同じ形で返す（landmarks: 33点×人数、x,yは0〜1）
  async detectForVideo(src) {
    const W = src.width, H = src.height;
    const boxes = (await this.detect(src, W, H)).slice(0, this.maxPersons);
    const landmarks = [];
    for (const b of boxes) {
      const { kpts, scores } = await this.estimate(src, W, H, b.box);
      landmarks.push(toMediaPipe(kpts, scores, W, H));
    }
    return { landmarks };
  }
}

export function decodeDetections(o0, labels, ratio, inH, inW) {
  const d = o0.data, dims = o0.dims, C = dims[dims.length - 1], N = dims[dims.length - 2];
  const res = [];
  if (C === 5) { // NMS済み（end2end）: x1,y1,x2,y2,score
    for (let i = 0; i < N; i++) {
      const s = d[i * 5 + 4];
      if (!(s > 0.3)) continue;
      if (labels && Number(labels.data[i]) !== 0) continue;
      res.push({ box: [d[i * 5] / ratio, d[i * 5 + 1] / ratio, d[i * 5 + 2] / ratio, d[i * 5 + 3] / ratio], score: s });
    }
  } else { // 生出力: グリッド復元＋NMS（score閾値0.7、IoU 0.45）
    const strides = [8, 16, 32], cand = [];
    let k = 0;
    for (const st of strides) {
      const hs = Math.floor(inH / st), ws = Math.floor(inW / st);
      for (let y = 0; y < hs; y++) for (let x = 0; x < ws; x++, k++) {
        const o = k * C;
        const score = d[o + 4] * (C > 5 ? d[o + 5] : 1); // personクラス
        if (!(score > 0.7)) continue;
        const bx = (d[o] + x) * st, by = (d[o + 1] + y) * st, bw = Math.exp(d[o + 2]) * st, bh = Math.exp(d[o + 3]) * st;
        cand.push({ box: [(bx - bw / 2) / ratio, (by - bh / 2) / ratio, (bx + bw / 2) / ratio, (by + bh / 2) / ratio], score });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    const iou = (a, b) => {
      const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1);
      const inter = ix * iy, ua = (a[2] - a[0] + 1) * (a[3] - a[1] + 1) + (b[2] - b[0] + 1) * (b[3] - b[1] + 1) - inter;
      return inter / ua;
    };
    for (const c of cand) if (res.every((r) => iou(r.box, c.box) <= 0.45)) res.push(c);
  }
  return res.sort((a, b) => b.score - a.score);
}

export function decodeSimcc(sx, sy, inputWH, center, scale, split = 2.0) {
  const K = sx.dims[1], Wx = sx.dims[2], Wy = sy.dims[2];
  const kpts = [], scores = [];
  for (let k = 0; k < K; k++) {
    let ix = 0, mx = -Infinity, iy = 0, my = -Infinity;
    for (let i = 0; i < Wx; i++) { const v = sx.data[k * Wx + i]; if (v > mx) { mx = v; ix = i; } }
    for (let i = 0; i < Wy; i++) { const v = sy.data[k * Wy + i]; if (v > my) { my = v; iy = i; } }
    const val = 0.5 * (mx + my); // rtmlibと同じ（x・yの最大値の平均）
    let lx = ix, ly = iy;
    if (val <= 0) { lx = -1; ly = -1; }
    kpts.push([(lx / split / inputWH[0]) * scale[0] + center[0] - scale[0] / 2, (ly / split / inputWH[1]) * scale[1] + center[1] - scale[1] / 2]);
    scores.push(val);
  }
  return { kpts, scores };
}

export function toMediaPipe(kpts, scores, W, H) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const [mp, h] of Object.entries(MAP)) {
    const p = kpts[h];
    if (!p) continue;
    lm[mp] = { x: p[0] / W, y: p[1] / H, z: 0, visibility: Math.max(0, Math.min(1, scores[h])) };
  }
  return lm;
}
