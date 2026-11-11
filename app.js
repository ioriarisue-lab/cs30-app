import { PoseLandmarker } from "./vision_bundle.mjs";
import { Muxer, ArrayBufferTarget } from "./mp4-muxer.mjs";
import * as G from "./gait.js";
import { RTMPoseEstimator } from "./rtm.js";

const APP_VERSION = "1.10.0";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- IndexedDB ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open("gait-app", 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore("videos", { keyPath: "id" });
    db.createObjectStore("results", { keyPath: "id" });
    db.createObjectStore("kv");
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("保存に失敗しました（容量不足の可能性）"));
  });
}
const dbPut = (s, v, k) => tx(s, "readwrite", (o) => o.put(v, k));
const dbGet = (s, k) => tx(s, "readonly", (o) => o.get(k));
const dbDel = (s, k) => tx(s, "readwrite", (o) => o.delete(k));
const dbAll = (s) => tx(s, "readonly", (o) => o.getAll());

// ---------- 共通UI ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const fmtDate = (t) => new Date(t).toLocaleString("ja-JP");
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

async function saveFiles(files) {
  // iPhone/iPadでは共有シートから「ファイルに保存」「ビデオを保存」が選べる
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}

// ---------- タブ ----------
$$(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name !== "record" && !recorder) stopCamera();
  if (name === "library") renderVideos();
  if (name === "results") renderResults();
  if (name === "settings") renderSettings();
}

// ---------- 撮影 ----------
let stream = null, recorder = null, chunks = [], recStart = 0, recTick = null;
async function startCamera() {
  stopCamera();
  const h = Number($("#resSel").value), w = h === 1080 ? 1920 : 1280;
  const fps = Number($("#fpsSel").value);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: $("#facingSel").value, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } },
    });
  } catch (e) {
    $("#camMsg").textContent = "カメラを使えません: " + e.message; return;
  }
  $("#preview").srcObject = stream;
  $("#preview").onloadedmetadata = () => fitPreview();
  $("#camMsg").classList.add("hidden");
  $("#recBtn").disabled = false;
  $("#camBtn").textContent = "カメラ再起動";
  const s = stream.getVideoTracks()[0].getSettings();
  toast(`カメラ: ${s.width}×${s.height} / ${Math.round(s.frameRate || fps)} fps`);
  if ($("#liveChk").checked) startLive();
}

// ---------- リアルタイム骨格表示 ----------
const MODES = { r: [1, null], l: [-1, null], rl: [1, -1], lr: [-1, 1] };
let liveTracker = new G.TurnTracker(1, null, 1), liveMode = "r", liveFrameNo = 0, liveTarget = null;
function newLiveTarget() { const v = $("#preview"); liveTarget = new G.TargetTracker(v.videoWidth || 1920, v.videoHeight || 1080, 15); }
$(".camwrap").addEventListener("click", (e) => {
  if (!liveOn) return;
  const p = videoPointFromEvent($("#preview"), e);
  if (!p) return;
  const v = $("#preview");
  if (!liveTarget || liveTarget.w !== v.videoWidth) newLiveTarget();
  liveTarget.seedPoint(p[0] * v.videoWidth, p[1] * v.videoHeight);
  toast("タップした人を追跡します");
});
let liveLastPose = null, liveLm = null, liveOn = false, liveLastTs = 0, liveFrames = 0, liveFpsT = 0;
$$("#liveSeg button").forEach((b) => b.addEventListener("click", () => {
  liveMode = b.dataset.mode; resetLiveTracker(); newLiveTarget();
  $$("#liveSeg button").forEach((x) => x.classList.toggle("active", x === b));
}));
$("#liveChk").addEventListener("change", (e) => { if (e.target.checked) startLive(); else { if ($("#saveSkel").checked) $("#saveSkel").checked = false; stopLive(); } });
$("#saveSkel").addEventListener("change", (e) => { if (e.target.checked && !$("#liveChk").checked) { $("#liveChk").checked = true; startLive(); } });
async function startLive() {
  if (!stream || liveOn) return;
  liveOn = true;
  if (!liveLm) {
    $("#liveFps").classList.remove("hidden"); $("#liveFps").textContent = "骨格モデル準備中…";
    try { liveLm = await createLandmarker(); }
    catch (e) { toast(e.message, 5000); liveOn = false; $("#liveChk").checked = false; $("#liveFps").classList.add("hidden"); return; }
  }
  if (!liveOn || !stream) return;
  $("#liveFps").classList.remove("hidden");
  liveFrames = 0; liveFpsT = performance.now();
  const v = $("#preview");
  const next = (cb) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(cb) : requestAnimationFrame(cb));
  const step = () => {
    if (!liveOn || !stream) return;
    try {
      if (v.readyState >= 2 && v.videoWidth) {
        const ts = Math.max(performance.now(), liveLastTs + 1);
        liveLastTs = ts;
        const res = liveLm.detectForVideo(v, ts);
        if (!liveTarget || liveTarget.w !== v.videoWidth || liveTarget.h !== v.videoHeight) newLiveTarget();
        liveLastPose = liveTarget.step(res.landmarks || [], liveFrameNo, liveTracker.dir);
        liveTracker.update(liveFrameNo++, liveLastPose, v.videoWidth, v.videoHeight);
        drawLive(liveLastPose, v.videoWidth, v.videoHeight);
        liveFrames++;
        const now = performance.now();
        if (now - liveFpsT > 1000) { $("#liveFps").textContent = `骨格 ${Math.round((liveFrames * 1000) / (now - liveFpsT))} fps`; liveFrames = 0; liveFpsT = now; }
      }
    } catch (e) { console.warn(e); }
    next(step);
  };
  next(step);
}
function resetLiveTracker() {
  const [d1, d2] = MODES[liveMode];
  liveTracker = new G.TurnTracker(d1, d2, $("#preview").videoWidth || 1920); liveFrameNo = 0;
}
function stopLive() {
  liveOn = false; liveLastPose = null;
  const c = $("#liveCanvas"); c.getContext("2d").clearRect(0, 0, c.width, c.height);
  $("#liveFps").classList.add("hidden");
}
function drawLive(pose, W, H) {
  const c = $("#liveCanvas");
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  drawSkeleton(ctx, pose, W, H);
}
function drawSkeleton(ctx, pose, W, H) {
  if (!pose) return;
  const k = Math.max(1, W / 640);
  const xy = {};
  pose.forEach((lm, i) => { if ((lm.visibility ?? 1) >= G.VISIBILITY_THRESHOLD) xy[i] = [lm.x * W, lm.y * H]; });
  ctx.lineCap = "round"; ctx.lineWidth = 3 * k; ctx.strokeStyle = "rgb(80,230,70)";
  for (const [a, b] of G.SKELETON_CONNECTIONS) if (xy[a] && xy[b]) { ctx.beginPath(); ctx.moveTo(...xy[a]); ctx.lineTo(...xy[b]); ctx.stroke(); }
  ctx.fillStyle = "rgb(255,80,30)";
  for (const p of Object.values(xy)) { ctx.beginPath(); ctx.arc(p[0], p[1], 4 * k, 0, Math.PI * 2); ctx.fill(); }
}
function fitPreview() {
  const v = $("#preview"), w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return;
  $(".camwrap").style.aspectRatio = `${w} / ${h}`;
  $("#orientWarn").classList.toggle("hidden", w >= h);
}
$("#preview").addEventListener("resize", fitPreview);
window.addEventListener("orientationchange", () => setTimeout(() => stream && !recorder && startCamera(), 600));
function stopCamera() {
  stopLive();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; $("#preview").srcObject = null;
  $("#camMsg").classList.remove("hidden"); $("#camMsg").textContent = "「カメラ起動」を押してください";
  $("#recBtn").disabled = true; $("#camBtn").textContent = "カメラ起動";
}
$("#camBtn").onclick = startCamera;
["#resSel", "#fpsSel", "#facingSel"].forEach((s) => $(s).addEventListener("change", () => stream && !recorder && startCamera()));

function pickMime() {
  const list = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}
let skelRec = null, skelChunks = [], compLoopOn = false;
function makeRecorder(src, mimeType, store, onDone) {
  const r = new MediaRecorder(src, { mimeType, videoBitsPerSecond: 12_000_000 });
  r.ondataavailable = (e) => e.data.size && store.push(e.data);
  r.onstop = () => onDone(new Blob(store, { type: r.mimeType || mimeType || "video/mp4" }));
  return r;
}
$("#recBtn").onclick = async () => {
  if (recorder) { recorder.stop(); if (skelRec) skelRec.stop(); return; }
  if (!stream) return;
  const mimeType = pickMime();
  const name = `walk_${stamp()}`;
  const fpsSet = stream.getVideoTracks()[0].getSettings().frameRate;
  const ext = (t) => (t.includes("webm") ? "webm" : "mp4");
  let pending = 1;
  const finish = () => {
    if (--pending > 0) return;
    clearInterval(recTick); $("#recTimer").classList.add("hidden");
    $("#recBtn").textContent = "録画開始"; keepAwake(false);
    toast("端末内に保存しました（「動画」タブ）");
  };
  chunks = [];
  recorder = makeRecorder(stream, mimeType, chunks, async (blob) => {
    recorder = null;
    await addVideo(blob, `${name}.${ext(blob.type)}`, fpsSet ? Math.round(fpsSet) : null);
    finish();
  });
  // 骨格入り動画：映像と骨格をキャンバスに合成して同時に録画
  if ($("#saveSkel").checked) {
    if (!$("#liveChk").checked) { $("#liveChk").checked = true; }
    await startLive();
    const v = $("#preview"), comp = document.createElement("canvas");
    comp.width = v.videoWidth; comp.height = v.videoHeight;
    const cx = comp.getContext("2d");
    compLoopOn = true;
    const draw = () => {
      if (!compLoopOn) return;
      if (v.videoWidth) { cx.drawImage(v, 0, 0, comp.width, comp.height); drawSkeleton(cx, liveLastPose, comp.width, comp.height); }
      requestAnimationFrame(draw);
    };
    draw();
    try {
      skelChunks = [];
      skelRec = makeRecorder(comp.captureStream(Math.round(fpsSet || 30)), mimeType, skelChunks, async (blob) => {
        compLoopOn = false; skelRec = null;
        await addVideo(blob, `${name}_skeleton.${ext(blob.type)}`, fpsSet ? Math.round(fpsSet) : null, true);
        finish();
      });
      pending = 2;
    } catch (e) { compLoopOn = false; skelRec = null; toast("骨格入り動画を録画できません: " + e.message, 4000); }
  }
  resetLiveTracker(); // 往復は録画開始から折り返しを追跡
  recorder.start(1000);
  if (skelRec) skelRec.start(1000);
  recStart = Date.now(); keepAwake(true);
  $("#recBtn").textContent = "録画停止";
  $("#recTimer").classList.remove("hidden");
  recTick = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("#recTimer").textContent = `● ${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }, 250);
};

// ---------- 動画ライブラリ ----------
function loadVideoEl(blob, attach = false) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.setAttribute("playsinline", "");
    if (attach) { Object.assign(v.style, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none" }); document.body.appendChild(v); }
    v.onloadedmetadata = async () => {
      if (!Number.isFinite(v.duration)) { // MediaRecorder動画の長さ取得対策
        await new Promise((r) => { v.ontimeupdate = () => { v.ontimeupdate = null; r(); }; v.currentTime = 1e9; });
      }
      res(v);
    };
    v.onerror = () => rej(new Error("動画を開けません。MP4/MOV形式をお試しください。"));
    v.src = URL.createObjectURL(blob);
  });
}
function seekTo(v, t) {
  return new Promise((res) => {
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done);
    v.currentTime = t;
  });
}
function disposeVideo(v) { URL.revokeObjectURL(v.src); v.removeAttribute("src"); v.load(); v.remove(); }

async function makeThumb(blob) {
  try {
    const v = await loadVideoEl(blob, true);
    await seekTo(v, Math.min(0.2, v.duration / 2));
    const c = document.createElement("canvas"); c.width = 320; c.height = Math.round(320 * v.videoHeight / v.videoWidth) || 180;
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const meta = { thumb: c.toDataURL("image/jpeg", 0.7), duration: v.duration, width: v.videoWidth, height: v.videoHeight };
    disposeVideo(v); return meta;
  } catch { return {}; }
}

async function addVideo(blob, name, fps, skeleton = false) {
  const meta = await makeThumb(blob);
  await dbPut("videos", { id: uid(), name, created: Date.now(), type: blob.type, size: blob.size, blob, fps, skeleton, ...meta });
  renderVideos();
}
$("#importVideo").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  toast("読み込み中…");
  await addVideo(f, f.name, null);
  toast("端末内に保存しました");
};

async function renderVideos() {
  const list = (await dbAll("videos")).sort((a, b) => b.created - a.created);
  const ul = $("#videoList");
  if (!list.length) { ul.innerHTML = `<li class="empty">動画がありません。「撮影」タブで録画するか、読み込んでください。</li>`; return; }
  ul.innerHTML = list.map((v) => `
    <li data-id="${v.id}">
      ${v.thumb ? `<img class="thumb" src="${v.thumb}">` : `<div class="thumb"></div>`}
      <div class="meta"><b>${esc(v.name)}${v.skeleton ? ' <span class="tag">骨格入り</span>' : ""}</b>
        <span>${fmtDate(v.created)} ・ ${v.duration ? v.duration.toFixed(1) + " 秒" : ""} ・ ${v.width ? v.width + "×" + v.height : ""} ・ ${fmtSize(v.size)}${v.fps ? " ・ " + v.fps + " fps" : ""}</span></div>
      <div class="acts">
        ${v.skeleton ? "" : `<button class="btn small" data-act="analyze">解析</button>`}
        <button class="btn small sub" data-act="export">保存/共有</button>
        <button class="btn small sub" data-act="delete">削除</button>
      </div>
    </li>`).join("");
}
$("#videoList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest("li").dataset.id;
  const rec = await dbGet("videos", id);
  if (b.dataset.act === "analyze") openAnalyze(rec);
  if (b.dataset.act === "export") saveFiles([new File([rec.blob], rec.name, { type: rec.type })]);
  if (b.dataset.act === "delete" && confirm(`「${rec.name}」を削除しますか？`)) { await dbDel("videos", id); renderVideos(); }
});

// ---------- モデル ----------
let modelBytes = null;
async function getModel() {
  if (modelBytes) return modelBytes;
  const saved = await dbGet("kv", "model");
  if (saved) return (modelBytes = new Uint8Array(saved.buffer));
  // アプリと同じ場所にモデルを置いた場合は自動で取り込む（heavy優先）
  // 2分割したもの（.part1/.part2）にも対応
  for (const name of ["pose_landmarker_heavy.task", "pose_landmarker_full.task", "models/pose_landmarker_heavy.task"]) {
    try {
      let buf = null;
      const r = await fetch(name, { cache: "no-store" });
      if (r.ok) buf = await r.arrayBuffer();
      else {
        const [a, b] = await Promise.all([1, 2].map((i) => fetch(`${name}.part${i}`, { cache: "no-store" })));
        if (!a.ok || !b.ok) continue;
        const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
        const u = new Uint8Array(x.byteLength + y.byteLength); u.set(new Uint8Array(x), 0); u.set(new Uint8Array(y), x.byteLength);
        buf = u.buffer;
      }
      if (buf && buf.byteLength > 1e6) { await dbPut("kv", { name: name.split("/").pop(), buffer: buf, size: buf.byteLength }, "model"); return (modelBytes = new Uint8Array(buf)); }
    } catch {}
  }
  return null;
}
$("#importModel").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const buf = await f.arrayBuffer();
  if (buf.byteLength < 1e6) { toast("モデルファイルではないようです"); return; }
  await dbPut("kv", { name: f.name, buffer: buf, size: buf.byteLength }, "model");
  modelBytes = new Uint8Array(buf);
  toast("モデルを端末内に保存しました"); renderSettings(); updBadge();
};
$("#splitModel").onclick = async () => {
  const m = await dbGet("kv", "model");
  if (!m) { toast("先にモデルを取り込んでください"); return; }
  const half = Math.ceil(m.buffer.byteLength / 2);
  // 取り込んだファイル名が変わっていても、自動読み込みで探す名前にそろえる
  const base = /full/i.test(m.name) ? "pose_landmarker_full.task" : "pose_landmarker_heavy.task";
  const files = [1, 2].map((i) => new File([m.buffer.slice((i - 1) * half, i * half)], `${base}.part${i}`, { type: "application/octet-stream" }));
  await saveFiles(files);
};
async function renderSettings() {
  const m = await dbGet("kv", "model");
  $("#modelStatus").innerHTML = m ? `保存済み: <b>${esc(m.name)}</b>（${fmtSize(m.size)}）` : `<span class="warn">未設定です。解析前にモデルを取り込んでください。</span>`;
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $("#storageInfo").textContent = `使用 ${fmtSize(e.usage || 0)} / 上限目安 ${fmtSize(e.quota || 0)}${p ? "（消去されにくい保存）" : ""}`;
  }
  $("#verInfo").textContent = `バージョン ${APP_VERSION}`;
  for (const k of ["rtm_det", "rtm_pose"]) {
    const m = await dbGet("kv", k);
    $(`#${k}Status`).innerHTML = m ? `保存済み: <b>${esc(m.name)}</b>（${fmtSize(m.size)}）` : "未設定";
  }
  $("#rtmPref").value = lsGet("rtm_pref", "auto");
}
for (const k of ["rtm_det", "rtm_pose"]) {
  $(`#${k}Import`).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    const buf = await f.arrayBuffer();
    if (buf.byteLength < 1e5) { toast("ONNXモデルではないようです"); return; }
    await dbPut("kv", { name: f.name, buffer: buf, size: buf.byteLength }, k);
    toast("モデルを端末内に保存しました"); renderSettings();
  };
  $(`#${k}Split`).onclick = async () => {
    const m = await dbGet("kv", k);
    if (!m) { toast("先にモデルを取り込んでください"); return; }
    const size = 24 * 1024 * 1024, n = Math.ceil(m.buffer.byteLength / size);
    const files = Array.from({ length: n }, (_, i) => new File([m.buffer.slice(i * size, (i + 1) * size)], `${RTM_FILES[k]}.part${i + 1}`, { type: "application/octet-stream" }));
    await saveFiles(files);
  };
  $(`#${k}Del`).onclick = async () => { if (confirm("このモデルを端末から削除しますか？")) { await dbDel("kv", k); renderSettings(); } };
}
$("#rtmPref").onchange = (e) => lsSet("rtm_pref", e.target.value);
const RTM_FILES = { rtm_det: "rtm_det.onnx", rtm_pose: "rtm_pose.onnx" };
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
// 分割ファイル（.part1, .part2, …）にも対応して取得
async function fetchWithParts(name) {
  try {
    const r = await fetch(name, { cache: "no-store" });
    if (r.ok) return await r.arrayBuffer();
  } catch {}
  const parts = [];
  for (let i = 1; i <= 12; i++) {
    try { const r = await fetch(`${name}.part${i}`, { cache: "no-store" }); if (!r.ok) break; parts.push(new Uint8Array(await r.arrayBuffer())); } catch { break; }
  }
  if (!parts.length) return null;
  const u = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0; for (const p of parts) { u.set(p, o); o += p.length; }
  return u.buffer;
}
async function getRtmModel(key) {
  const saved = await dbGet("kv", key);
  if (saved) return new Uint8Array(saved.buffer);
  const buf = await fetchWithParts(RTM_FILES[key]);
  if (buf && buf.byteLength > 1e5) { await dbPut("kv", { name: RTM_FILES[key], buffer: buf, size: buf.byteLength }, key); return new Uint8Array(buf); }
  return null;
}
async function createLandmarker(engine = "mediapipe") {
  if (window.__mockLm) return window.__mockLm(); // テスト用
  if (engine === "rtmpose") {
    const [det, pose] = await Promise.all([getRtmModel("rtm_det"), getRtmModel("rtm_pose")]);
    if (!det || !pose) throw new Error("RTMPoseのモデルが未設定です。「設定」タブで人物検出モデルと姿勢推定モデル（.onnx）を取り込んでください。");
    return await RTMPoseEstimator.create(det, pose, lsGet("rtm_pref", "auto"));
  }
  const bytes = await getModel();
  if (!bytes) throw new Error("姿勢推定モデルが未設定です。「設定」タブで pose_landmarker_heavy.task を取り込んでください。");
  const fileset = {
    wasmLoaderPath: new URL("vision_wasm_internal.js", location.href).href,
    wasmBinaryPath: new URL("vision_wasm_internal.wasm", location.href).href,
  };
  const opts = (delegate) => ({
    baseOptions: { modelAssetBuffer: bytes, delegate },
    runningMode: "VIDEO", numPoses: 3,
    minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.5,
  });
  try { return await PoseLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { return await PoseLandmarker.createFromOptions(fileset, opts("CPU")); }
}

// ---------- 解析ダイアログ ----------
let anaEngine = lsGet("engine", "mediapipe");
$$("#engSeg button").forEach((b) => {
  b.classList.toggle("active", b.dataset.eng === anaEngine);
  b.addEventListener("click", () => {
    anaEngine = b.dataset.eng; lsSet("engine", anaEngine);
    $$("#engSeg button").forEach((x) => x.classList.toggle("active", x === b));
  });
});
let anaSeed = null;
function videoPointFromEvent(video, e) { // object-fit: contain を考慮して動画内の位置（0〜1）に変換
  const r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const s = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
  const x = (e.clientX - r.left - ox) / (vw * s), y = (e.clientY - r.top - oy) / (vh * s);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : null;
}
function drawPickMarker() {
  const c = $("#pickCanvas"), v = $("#anaPreview"), r = v.getBoundingClientRect();
  c.width = r.width; c.height = r.height;
  const g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
  if (!v.videoWidth) return;
  const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight), ox = (r.width - v.videoWidth * s) / 2, oy = (r.height - v.videoHeight * s) / 2;
  const box = lightDrag || anaLight;
  if (box) {
    const X = (u) => ox + u * v.videoWidth * s, Y = (u) => oy + u * v.videoHeight * s;
    g.strokeStyle = "#ffe000"; g.lineWidth = 3; g.setLineDash([6, 4]);
    g.strokeRect(X(Math.min(box.x0, box.x1)), Y(Math.min(box.y0, box.y1)), Math.abs(X(box.x1) - X(box.x0)), Math.abs(Y(box.y1) - Y(box.y0)));
    g.setLineDash([]); g.fillStyle = "#ffe000"; g.font = "bold 14px sans-serif"; g.fillText("光", X(Math.min(box.x0, box.x1)), Y(Math.min(box.y0, box.y1)) - 4);
  }
  if (!anaSeed) return;
  const x = ox + anaSeed.x * v.videoWidth * s, y = oy + anaSeed.y * v.videoHeight * s;
  g.strokeStyle = "#ffb020"; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 18, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(x - 26, y); g.lineTo(x + 26, y); g.moveTo(x, y - 26); g.lineTo(x, y + 26); g.stroke();
}
function setSeed(seed) {
  anaSeed = seed;
  $("#pickClear").classList.toggle("hidden", !seed);
  $("#pickInfo").textContent = seed ? `${seed.t.toFixed(2)}秒の位置でタップした人を追跡` : "指定なし（進行方向の先頭の人を追跡）";
  drawPickMarker();
}
$("#pickBtn").onclick = () => {
  const c = $("#pickCanvas"), on = !c.classList.contains("active");
  c.classList.toggle("active", on);
  $("#pickBtn").textContent = on ? "動画の中の対象者をタップ…" : "対象者をタップで指定";
  if (on) { pickMode = "person"; $("#anaPreview").pause(); toast("対象者が映っている場面で、その人の胴体をタップしてください"); }
};
// ---------- 光刺激の範囲指定（ドラッグで四角を描く） ----------
let pickMode = "person", anaLight = null, lightDrag = null;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function videoPointLoose(video, e) {
  const r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
  return [clamp01((e.clientX - r.left - ox) / (vw * s)), clamp01((e.clientY - r.top - oy) / (vh * s))];
}
function setLight(roi, save = true) {
  anaLight = roi;
  if (roi && save) { lsSet("lightRoi", JSON.stringify(roi)); if (anaRec) { anaRec.lightRoi = roi; dbPut("videos", anaRec); } }
  $("#lightInfo").textContent = roi ? "黄色の四角の中の明るさで判定します。光が四角からはみ出さないように、少し大きめに囲んでください。" : "動画を止めて、光（ランプ）が映る場所を指でなぞって四角で囲んでください。";
  drawPickMarker();
}
$("#lightBtn").onclick = () => {
  const c = $("#pickCanvas");
  pickMode = "light"; c.classList.add("active"); $("#anaPreview").pause();
  $("#lightChk").checked = true;
  toast("光が映る場所を指でなぞって囲んでください");
};
$("#pickCanvas").addEventListener("pointerdown", (e) => {
  if (pickMode !== "light") return;
  e.preventDefault(); $("#pickCanvas").setPointerCapture(e.pointerId);
  const [x, y] = videoPointLoose($("#anaPreview"), e); lightDrag = { x0: x, y0: y, x1: x, y1: y }; drawPickMarker();
});
$("#pickCanvas").addEventListener("pointermove", (e) => {
  if (pickMode !== "light" || !lightDrag) return;
  const [x, y] = videoPointLoose($("#anaPreview"), e); lightDrag.x1 = x; lightDrag.y1 = y; drawPickMarker();
});
$("#pickCanvas").addEventListener("pointerup", () => {
  if (pickMode !== "light" || !lightDrag) return;
  let { x0, y0, x1, y1 } = lightDrag; lightDrag = null;
  const v = $("#anaPreview"), minW = 12 / v.videoWidth, minH = 12 / v.videoHeight;
  if (Math.abs(x1 - x0) < minW || Math.abs(y1 - y0) < minH) { // タップだけなら小さな四角
    const cx = x0, cy = y0, hw = 0.03, hh = 0.03 * (v.videoWidth / v.videoHeight);
    x0 = clamp01(cx - hw); x1 = clamp01(cx + hw); y0 = clamp01(cy - hh); y1 = clamp01(cy + hh);
  }
  setLight({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
  pickMode = "person"; $("#pickCanvas").classList.remove("active");
});
$("#pickCanvas").addEventListener("click", (e) => {
  if (pickMode !== "person") return;
  const v = $("#anaPreview"), p = videoPointFromEvent(v, e);
  if (!p) return;
  setSeed({ t: v.currentTime, x: p[0], y: p[1] });
  $("#pickCanvas").classList.remove("active"); $("#pickBtn").textContent = "対象者をタップで指定";
});
$("#pickClear").onclick = () => setSeed(null);
$("#anaPreview").addEventListener("seeked", () => { if (anaSeed && Math.abs($("#anaPreview").currentTime - anaSeed.t) > 0.05) drawPickMarker(); });
window.addEventListener("resize", () => { if (!$("#analyzeDlg").classList.contains("hidden")) drawPickMarker(); });
// ---------- 解析区間 ----------
const pvDur = () => { const d = $("#anaPreview").duration; return Number.isFinite(d) ? d : 0; };
function getRange() {
  const d = pvDur(), s = parseFloat($("#rangeStart").value), e = parseFloat($("#rangeEnd").value);
  const start = Number.isFinite(s) ? Math.max(0, Math.min(s, d)) : 0, end = Number.isFinite(e) ? Math.max(0, Math.min(e, d)) : d;
  if (start <= 0.001 && end >= d - 0.001) return null; // 全体
  return { start, end };
}
function updateRangeUI() {
  const d = pvDur(); if (!d) return;
  const r = getRange() || { start: 0, end: d }, fps = Number($("#anaFps").value) || 30;
  $("#rangeSel").style.left = `${(100 * r.start) / d}%`;
  $("#rangeSel").style.width = `${(100 * Math.max(0, r.end - r.start)) / d}%`;
  const len = r.end - r.start;
  $("#rangeInfo").textContent = len < 0.5 ? "⚠ 区間が短すぎます（終了を開始より後に）" : `${getRange() ? "" : "全体："}${r.start.toFixed(2)}〜${r.end.toFixed(2)}秒（${len.toFixed(2)}秒・約${Math.round(len * fps)}フレーム）`;
}
function setRangeInputs(start, end) {
  $("#rangeStart").value = start.toFixed(2); $("#rangeEnd").value = end.toFixed(2); updateRangeUI();
}
["#rangeStart", "#rangeEnd", "#anaFps"].forEach((s) => $(s).addEventListener("input", updateRangeUI));
$("#setStart").onclick = () => { const t = $("#anaPreview").currentTime, e = parseFloat($("#rangeEnd").value); setRangeInputs(t, Number.isFinite(e) && e > t ? e : pvDur()); };
$("#setEnd").onclick = () => { const t = $("#anaPreview").currentTime, s = parseFloat($("#rangeStart").value); setRangeInputs(Number.isFinite(s) && s < t ? s : 0, t); };
$("#rangeAll").onclick = () => setRangeInputs(0, pvDur());
let rangeStop = null;
$("#rangePlay").onclick = () => {
  const v = $("#anaPreview"), r = getRange() || { start: 0, end: pvDur() };
  v.currentTime = r.start; v.play().catch(() => {});
  if (rangeStop) v.removeEventListener("timeupdate", rangeStop);
  rangeStop = () => { if (v.currentTime >= r.end) { v.pause(); v.removeEventListener("timeupdate", rangeStop); rangeStop = null; } };
  v.addEventListener("timeupdate", rangeStop);
};
$("#anaPreview").addEventListener("timeupdate", () => { const d = pvDur(); if (d) $("#rangeCur").style.left = `${(100 * $("#anaPreview").currentTime) / d}%`; });
$("#anaPreview").addEventListener("loadedmetadata", () => setRangeInputs(0, pvDur()));
$("#rangeBar").addEventListener("click", (e) => { // バーをタップしてその位置へ移動
  const r = $("#rangeBar").getBoundingClientRect(); $("#anaPreview").currentTime = ((e.clientX - r.left) / r.width) * pvDur();
});
let anaRec = null, anaMode = "r", anaRef = "right", cancelFlag = false, running = false;
$$("#refSeg button").forEach((b) => b.addEventListener("click", () => {
  anaRef = b.dataset.ref;
  $$("#refSeg button").forEach((x) => x.classList.toggle("active", x === b));
}));
$("#anaPerCycle").addEventListener("change", (e) => { $("#refSeg").classList.toggle("hidden", !e.target.checked); $("#refHint").classList.toggle("hidden", !e.target.checked); });
$$("#anaSeg button").forEach((b) => b.addEventListener("click", () => {
  anaMode = b.dataset.mode;
  $$("#anaSeg button").forEach((x) => x.classList.toggle("active", x === b));
}));
async function openAnalyze(rec) {
  anaRec = rec;
  $("#anaName").textContent = rec.name;
  const pv = $("#anaPreview"); if (pv.src) URL.revokeObjectURL(pv.src);
  pv.src = URL.createObjectURL(rec.blob);
  $("#anaProgress").classList.add("hidden");
  $("#anaStart").disabled = false; $("#anaCancel").textContent = "閉じる";
  $("#anaFps").value = rec.fps || 30;
  setSeed(null); $("#pickCanvas").classList.remove("active"); $("#pickBtn").textContent = "対象者をタップで指定"; pickMode = "person";
  let roi = rec.lightRoi || null;
  const had = !!roi;
  if (!roi) try { roi = JSON.parse(lsGet("lightRoi", "null")); } catch {}
  setLight(roi, false);
  $("#lightChk").checked = had;
  $("#analyzeDlg").classList.remove("hidden");
  if (!rec.fps) estimateFps(rec.blob).then((f) => { if (f && !running) $("#anaFps").value = f; });
}
async function estimateFps(blob) {
  try {
    const v = await loadVideoEl(blob, true);
    if (!v.requestVideoFrameCallback) { disposeVideo(v); return null; }
    const times = [];
    await new Promise((res) => {
      const to = setTimeout(res, 2500);
      const cb = (_, m) => { if (!times.length || m.mediaTime !== times[times.length - 1]) times.push(m.mediaTime); if (times.length > 20) { clearTimeout(to); res(); } else v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb); v.play().catch(res);
    });
    disposeVideo(v);
    const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0).sort((a, b) => a - b);
    if (d.length < 5) return null;
    const f = 1 / d[Math.floor(d.length / 2)];
    const common = [24, 25, 30, 50, 60, 120, 240].find((c) => Math.abs(f - c) / c < 0.04);
    return common || Math.round(f * 100) / 100;
  } catch { return null; }
}
function closeAnalyze() {
  if (running) { cancelFlag = true; return; }
  const pv = $("#anaPreview"); pv.pause(); URL.revokeObjectURL(pv.src); pv.removeAttribute("src"); pv.load();
  $("#analyzeDlg").classList.add("hidden");
}
$("#anaCancel").onclick = closeAnalyze;
$("#anaStart").onclick = async () => {
  const fps = Number($("#anaFps").value);
  if (!(fps > 0)) { toast("フレームレートを入力してください"); return; }
  $("#anaPreview").pause();
  const rg = getRange() || { start: 0, end: pvDur() };
  if (rg.end - rg.start < 0.5) { toast("解析する区間が短すぎます"); return; }
  if ($("#lightChk").checked && !anaLight) { toast("「光の位置を囲む」で光が映る場所を囲んでください"); return; }
  if (anaSeed && (anaSeed.t < rg.start - 0.05 || anaSeed.t > rg.end + 0.05)) { toast("対象者をタップした場面が解析区間の外です。区間内でタップし直してください"); return; }
  running = true; cancelFlag = false;
  $("#anaStart").disabled = true; $("#anaCancel").textContent = "中止";
  $("#anaProgress").classList.remove("hidden");
  keepAwake(true);
  try {
    const result = await analyze(anaRec, MODES[anaMode], fps, $("#anaStick").checked, { perCycle: $("#anaPerCycle").checked, refSide: anaRef, engine: anaEngine, seed: anaSeed, range: getRange(), light: $("#lightChk").checked && anaLight ? anaLight : null }, (i, n, msg) => {
      $("#anaBar").value = n ? i / n : 0;
      $("#anaText").textContent = msg || `${i} / ${n} フレーム`;
    });
    await dbPut("results", result);
    running = false; closeAnalyze();
    showTab("results"); openResult(result.id);
    toast("解析が完了しました");
  } catch (e) {
    running = false;
    $("#anaText").textContent = e.message === "cancel" ? "中止しました" : "エラー: " + e.message;
    $("#anaStart").disabled = false; $("#anaCancel").textContent = "閉じる";
  } finally { keepAwake(false); G.setEngine("mediapipe"); }
};

// ---------- 解析本体 ----------
function drawOverlay(ctx, pose, W, H, frameIndex, fps, direction) {
  const xy = {};
  if (pose) pose.forEach((lm, i) => { const v = lm.visibility ?? 1; if (v >= G.VISIBILITY_THRESHOLD) xy[i] = [Math.trunc(lm.x * W), Math.trunc(lm.y * H)]; });
  ctx.lineCap = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "rgb(80,230,70)";
  for (const [a, b] of G.SKELETON_CONNECTIONS) if (xy[a] && xy[b]) { ctx.beginPath(); ctx.moveTo(...xy[a]); ctx.lineTo(...xy[b]); ctx.stroke(); }
  ctx.fillStyle = "rgb(255,80,30)";
  for (const p of Object.values(xy)) { ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, Math.PI * 2); ctx.fill(); }
  const label = `Frame: ${frameIndex}   Time: ${(frameIndex / fps).toFixed(2)} s   Lead: ${direction > 0 ? "RIGHT" : "LEFT"}`;
  ctx.fillStyle = "#000"; ctx.fillRect(12, 12, 598, 46);
  ctx.fillStyle = "#fff"; ctx.font = "bold 26px -apple-system, Helvetica, sans-serif"; ctx.textBaseline = "middle";
  ctx.fillText(label, 24, 36);
}

function drawLightBox(ctx, lr, on) {
  ctx.lineWidth = 3; ctx.strokeStyle = on ? "#ffe000" : "rgba(255,224,0,0.6)";
  ctx.strokeRect(lr.x, lr.y, lr.w, lr.h);
  if (on) {
    ctx.fillStyle = "#ffe000"; ctx.font = "bold 26px -apple-system, Helvetica, sans-serif"; ctx.textBaseline = "bottom";
    ctx.fillText("LIGHT ON", lr.x, Math.max(28, lr.y - 4));
  }
}
async function setupEncoder(W, H, fps) {
  if (!("VideoEncoder" in window)) return null;
  const ew = W - (W % 2), eh = H - (H % 2);
  let cfg = null;
  for (const codec of ["avc1.640033", "avc1.640028", "avc1.4d0033", "avc1.42003e"]) {
    const c = { codec, width: ew, height: eh, bitrate: Math.min(16e6, ew * eh * fps * 0.12), framerate: fps, avc: { format: "avc" } };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch {}
  }
  if (!cfg) return null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "avc", width: ew, height: eh, frameRate: fps }, fastStart: "in-memory", firstTimestampBehavior: "offset" });
  let err = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (err = e) });
  enc.configure(cfg);
  let canvas = null;
  if (ew !== W || eh !== H) { canvas = document.createElement("canvas"); canvas.width = ew; canvas.height = eh; }
  return {
    async add(src, i) {
      if (err) throw err;
      let s = src;
      if (canvas) { canvas.getContext("2d").drawImage(src, 0, 0); s = canvas; }
      const frame = new VideoFrame(s, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
      frame.close();
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    },
    async finish() {
      await enc.flush(); enc.close(); muxer.finalize();
      return new Blob([target.buffer], { type: "video/mp4" });
    },
    abort() { try { enc.close(); } catch {} },
  };
}

async function analyze(rec, mode, fps, makeStick, opts, progress) {
  const [direction, dir2] = mode;
  progress(0, 0, "モデルを準備中…");
  const engine = opts.engine || "mediapipe";
  G.setEngine(engine);
  const landmarker = await createLandmarker(engine);
  const backendName = landmarker.backend || "";
  const v = await loadVideoEl(rec.blob, true);
  try { await v.play(); v.pause(); } catch {}
  const W = v.videoWidth, H = v.videoHeight, duration = v.duration;
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: !!opts.light });
  const lightVals = [];
  const lr = opts.light ? (() => {
    const x = Math.floor(opts.light.x0 * W), y = Math.floor(opts.light.y0 * H);
    return { x, y, w: Math.max(1, Math.ceil(opts.light.x1 * W) - x), h: Math.max(1, Math.ceil(opts.light.y1 * H) - y) };
  })() : null;
  const enc = makeStick ? await setupEncoder(W, H, fps) : null;
  const totalAll = Math.max(1, Math.floor(duration * fps + 1e-6));
  // 解析区間（指定がなければ全体）。f0〜f1 を解析し、配列の添字は区間の先頭を0とする
  const f0 = Math.min(totalAll - 1, Math.max(0, Math.round(((opts.range && opts.range.start) || 0) * fps)));
  const f1 = Math.max(f0, Math.min(totalAll - 1, opts.range && opts.range.end != null ? Math.round(opts.range.end * fps) - 1 : totalAll - 1));
  const total = f1 - f0 + 1;
  const cands = [];
  const t0 = performance.now();
  const frameTime = (i) => Math.min((i + 0.5) / fps, Math.max(0, duration - 0.001));
  let stick = null, track, turnFrame = null, dirAt = () => direction, light = null;
  try {
    // 1回目：全フレームで人物を検出（候補を保存）
    try {
      for (let i = 0; i < total; i++) {
        if (cancelFlag) throw new Error("cancel");
        await seekTo(v, frameTime(f0 + i));
        ctx.drawImage(v, 0, 0, W, H);
        if (lr) { // 光の範囲の平均輝度
          const d = ctx.getImageData(lr.x, lr.y, lr.w, lr.h).data;
          let sum = 0; for (let k = 0; k < d.length; k += 4) sum += 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
          lightVals.push(sum / (d.length / 4));
        }
        const res = await landmarker.detectForVideo(canvas, Math.round(((f0 + i) * 1000) / fps));
        cands.push((res.landmarks || []).map((p) => p.map((l) => ({ x: l.x, y: l.y, z: l.z || 0, visibility: l.visibility }))));
        if (i % 3 === 0) {
          const el = (performance.now() - t0) / 1000, rem = (el / (i + 1)) * (total - i - 1) * (enc ? 1.15 : 1);
          progress(i + 1, total, `${i + 1} / ${total} フレーム ・ 残り約 ${Math.ceil(rem)} 秒`);
        }
      }
    } finally { landmarker.close(); }
    // 対象者を追跡（タップ指定があればその人、なければ進行方向の先頭の人）
    const seed = opts.seed ? { frame: Math.min(total - 1, Math.max(0, Math.round(opts.seed.t * fps) - f0)), x: opts.seed.x, y: opts.seed.y } : null;
    track = G.trackAll(cands, W, H, fps, dirAt, seed);
    if (dir2 != null) {
      turnFrame = G.turnFrameFromSelection(track.sel, W, H, direction, fps);
      if (turnFrame != null) { dirAt = (i) => (i <= turnFrame ? direction : dir2); track = G.trackAll(cands, W, H, fps, dirAt, seed); }
    }
    if (lr) light = G.detectLightEvents(lightVals, fps, f0);
    // 2回目：スティックピクチャー動画
    if (enc) {
      for (let i = 0; i < total; i++) {
        if (cancelFlag) throw new Error("cancel");
        await seekTo(v, frameTime(f0 + i));
        ctx.drawImage(v, 0, 0, W, H);
        drawOverlay(ctx, track.sel[i], W, H, f0 + i, fps, dirAt(i));
        if (lr && light) drawLightBox(ctx, lr, light.on[i]);
        await enc.add(canvas, i);
        if (i % 5 === 0) progress(i + 1, total, `スティックピクチャー動画を作成中 ${i + 1} / ${total}`);
      }
      stick = await enc.finish();
    }
  } catch (e) { enc && enc.abort(); throw e; }
  finally { disposeVideo(v); }
  progress(total, total, "ファイルを作成中…");
  // frame・time_seconds は元の動画の通し番号・時刻
  const rows = track.sel.map((pose, i) => G.buildRow(f0 + i, fps, Math.round(((f0 + i) * 1000) / fps), W, H, pose));
  if (light) rows.forEach((r, i) => { r.light_brightness = Math.round(lightVals[i] * 10) / 10; r.light_on = light.on[i]; });
  const trackInfo = {
    seeded: track.seeded,
    missing: track.sel.filter((p, i) => !p && cands[i].length).length,
    multi: cands.filter((c) => c.length > 1).length,
  };

  let cycleSide = G.chooseCycleSide(rows);
  let cycleData = null, events = [], warning = "", pc = null, rt = null;
  if (dir2 != null) { // 往復
    if (turnFrame == null) warning = "折り返しを検出できなかったため、片道として解析しました。";
    else {
      rt = G.roundTripSegments(rows, turnFrame, direction, dir2, fps);
      if (rt) rows.forEach((r, i) => (r.segment = i < rt.turnStart ? "outbound" : i <= rt.turnEnd ? "turn" : "return"));
    }
  }
  if (opts.perCycle) {
    try { pc = G.perCycleAnalysis(rows, opts.refSide, direction, fps, H, rt ? rt.segments : null); ({ cycleData, events } = pc); cycleSide = opts.refSide; }
    catch (e) { warning += (warning ? "\n" : "") + e.message + "（平均グラフはPython版と同じ方法で作成しました）"; }
  }
  if (!pc) {
    try { ({ cycleData, events } = rt ? legacyRoundTrip(rows, cycleSide, fps, W, rt.segments) : G.normalizedCycles(rows, cycleSide, fps, W)); }
    catch (e) { warning += (warning ? "\n" : "") + e.message; }
  }
  // 周期・接地の番号を元の動画の通し番号・時刻にそろえる
  if (f0 > 0) {
    const r3 = (x) => Math.round(x * 1000) / 1000, sh = (f) => f + f0;
    for (const e of events) {
      e.start_contact_frame = sh(e.start_contact_frame); e.start_time_seconds = r3(e.start_contact_frame / fps);
      e.next_contact_frame = sh(e.next_contact_frame); e.next_contact_time_seconds = r3(e.next_contact_frame / fps);
    }
    if (pc) for (const c of pc.list) {
      const s = c.summary;
      s.start_frame = sh(s.start_frame); s.start_time_seconds = r3(s.start_frame / fps);
      s.end_frame = sh(s.end_frame); s.end_time_seconds = r3(s.end_frame / fps);
    }
  }
  const range = { start: f0 / fps, end: (f1 + 1) / fps, whole: f0 === 0 && f1 === totalAll - 1 };
  if (makeStick && !enc) warning += (warning ? "\n" : "") + "この端末ではスティックピクチャー動画を作成できませんでした（iOS / iPadOS 16.4以降が必要）。";

  const base = rec.name.replace(/\.[^.]+$/, "") + (engine === "rtmpose" ? "_rtmpose" : "") + "_gait_angles";
  const cols = G.exportColumns();
  if (rt) cols.splice(5, 0, "segment");
  if (light) cols.splice(5, 0, "light_brightness", "light_on");
  const csv = new Blob(["﻿" + toCSV(cols, rows)], { type: "text/csv" });
  const xlsx = buildXlsx(cols, rows, cycleData, events, cycleSide, pc, opts.refSide, rt ? direction : null, range, light);
  const lightCsv = light ? new Blob(["\ufeff" + toCSV(G.LIGHT_COLUMNS, light.events)], { type: "text/csv" }) : null;
  const png = await canvasBlob(drawGraph(rows, cycleData, events.length, fps));
  let perCycle = null;
  if (pc) {
    const pcols = ["cycle_percent", ...cols];
    perCycle = {
      refSide: opts.refSide,
      summaries: pc.list.map((c) => c.summary),
      norms: pc.list.map((c) => c.norm),
      csvs: pc.list.map((c) => new Blob(["\ufeff" + toCSV(pcols, rows.slice(c.a, c.b + 1).map((r, i) => ({ ...r, cycle_percent: Math.round((10000 * i) / (c.b - c.a)) / 100 })))], { type: "text/csv" })),
      summaryCsv: new Blob(["\ufeff" + toCSV(G.SUMMARY_COLUMNS, pc.list.map((c) => c.summary))], { type: "text/csv" }),
      normCsv: new Blob(["\ufeff" + toCSV(G.NORM_COLUMNS, pc.list.flatMap((c) => c.norm))], { type: "text/csv" }),
    };
  }
  const detected = rows.filter((r) => r.left_knee_flexion_deg != null || r.right_knee_flexion_deg != null).length;
  return {
    id: uid(), videoId: rec.id, videoName: rec.name, base, created: Date.now(), direction, dir2, fps, engine, backendName, trackInfo,
    roundTrip: rt ? { turnFrame: rt.turnFrame + f0, turnStart: rt.turnStart + f0, turnEnd: rt.turnEnd + f0 } : null, range,
    frames: rows.length, width: W, height: H, detected, cycleSide, nCycles: events.length, events, warning,
    csv, xlsx, png, stick, perCycle,
    light: light ? { events: light.events, info: light.info, roi: opts.light, csv: lightCsv } : null,
  };
}

// Python版の周期検出を往路・復路それぞれに適用し、周期数で重み付けして平均
function legacyRoundTrip(rows, side, fps, W, segments) {
  const parts = [], errs = [];
  for (const sg of segments) {
    try {
      const r = G.normalizedCycles(rows.slice(sg.a, sg.b + 1), side, fps, W);
      parts.push({ ...r, sg });
    } catch (e) { errs.push(`${sg.label}: ${e.message}`); }
  }
  if (!parts.length) throw new Error(errs.join("\n"));
  const total = parts.reduce((t, p) => t + p.events.length, 0);
  const cycleData = parts[0].cycleData.map((row, p) => {
    const o = { gait_cycle_percent: p };
    for (const k of Object.keys(row)) if (k !== "gait_cycle_percent") {
      let s = 0, w = 0;
      for (const pt of parts) { const v = pt.cycleData[p][k]; if (Number.isFinite(v)) { s += v * pt.events.length; w += pt.events.length; } }
      o[k] = w ? s / w : null;
    }
    return o;
  });
  let n = 0;
  const events = parts.flatMap((pt) => pt.events.map((e) => ({
    ...e, cycle: ++n, segment: pt.sg.label,
    start_contact_frame: e.start_contact_frame + pt.sg.a, start_time_seconds: Math.round(((e.start_contact_frame + pt.sg.a) / fps) * 1000) / 1000,
    next_contact_frame: e.next_contact_frame + pt.sg.a, next_contact_time_seconds: Math.round(((e.next_contact_frame + pt.sg.a) / fps) * 1000) / 1000,
  })));
  return { cycleData, events };
}

const cell = (v) => (v == null || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v));
function toCSV(cols, rows) {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
function aoa(cols, objs) { return [cols, ...objs.map((o) => cols.map((c) => (o[c] == null || Number.isNaN(o[c]) ? null : o[c])))]; }
function buildXlsx(cols, rows, cycleData, events, cycleSide, pc = null, refSide = null, rtDir = null, range = null, light = null) {
  const X = window.XLSX, wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa(cols, rows)), "フレーム別角度");
  const ccols = ["gait_cycle_percent", "left_knee_mean_deg", "left_hip_mean_deg", "right_knee_mean_deg", "right_hip_mean_deg"];
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(cycleData ? aoa(ccols, cycleData) : [ccols, ["歩行周期を検出できませんでした"]]), "正規化グラフ用");
  const ecols = ["side", "cycle", "start_contact_frame", "start_time_seconds", "next_contact_frame", "next_contact_time_seconds", "cycle_duration_seconds"];
  if (pc) ecols.push("start_contact");
  if (rtDir != null) ecols.push("segment");
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa(ecols, events)), "推定接地");
  if (pc) {
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa(G.SUMMARY_COLUMNS, pc.list.map((c) => c.summary))), "周期一覧");
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa(G.NORM_COLUMNS, pc.list.flatMap((c) => c.norm))), "周期別_正規化");
  }
  const notes = G.notesTable(cycleSide, events.length, pc ? refSide : null);
  if (light) {
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(light.events.length ? aoa(G.LIGHT_COLUMNS, light.events) : [G.LIGHT_COLUMNS, [light.info && light.info.note || "光刺激を検出できませんでした"]]), "光刺激");
    notes.push(["光刺激", G.LIGHT_NOTE + (light.info ? ` この動画：消灯時の基準 ${light.info.base}、最大 ${light.info.peak}。` : "") + " light_brightness列は範囲の平均輝度、light_on列は点灯中=1。"]);
  }
  if (range) notes.push(["解析区間", range.whole ? "動画全体" : `${range.start.toFixed(2)}〜${range.end.toFixed(2)}秒（frame・time_seconds・接地の時刻は元の動画の通し番号・時刻）`]);
  notes.push(["対象者", "最初に選んだ人（タップで指定した人、または進行方向の先頭の人）を、前フレームからの予測位置と主要関節（肩・股・膝・足首）の位置の近さでフレームをまたいで追跡。対象者を確認できないフレームは別の人に乗り換えず空欄とし、1秒以上見失った場合は進行方向の先頭の人を選び直す。"]);
  if (rtDir != null) notes.push(["往復", G.roundTripNote(rtDir) + " segment列: outbound=往路, turn=方向転換（除外）, return=復路。"]);
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["項目", "説明"], ...notes]), "説明");
  const out = X.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
const canvasBlob = (c) => new Promise((r) => c.toBlob(r, "image/png"));

// グラフ（matplotlib版と同じ構成：上=膝、下=股関節）
function drawGraph(rows, cycleData, nCycles, fps, opt = {}) {
  const Wc = 1920, Hc = 1280, c = document.createElement("canvas"); c.width = Wc; c.height = Hc;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, Wc, Hc);
  const font = (s, b = "") => `${b} ${s}px "Hiragino Sans", -apple-system, sans-serif`;
  const cyc = !!cycleData;
  let xs, xmax, xlabel;
  if (cyc) { xs = cycleData.map((r) => r.gait_cycle_percent); xmax = 100; xlabel = "歩行周期（同じ足の接地から次の接地 = 0〜100%）"; }
  else { xs = rows.map((r) => r.time_seconds); xmax = Math.max(1e-6, xs[xs.length - 1]); xlabel = "時間（秒）"; }
  g.fillStyle = "#000"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = font(34, "bold");
  g.fillText(opt.title ? opt.title : cyc ? "歩行周期に対する2D角度推定 — 臨床測定ではありません" : "フレーム別2D角度推定（歩行周期は検出できませんでした）— 臨床測定ではありません", Wc / 2, 40);
  const panels = [
    { joint: "knee", title: cyc ? "歩行周期に対する膝の推定屈曲角度" : "膝の推定屈曲角度", name: "膝" },
    { joint: "hip", title: cyc ? "歩行周期に対する股関節の推定屈曲角度" : "股関節の推定屈曲角度", name: "股関節" },
  ];
  const L = 150, R = Wc - 60, top0 = 120, ph = 470, gap = 130;
  panels.forEach((p, k) => {
    const T = top0 + k * (ph + gap), B = T + ph;
    const series = ["left", "right"].map((s) => cyc ? cycleData.map((r) => r[`${s}_${p.joint}_mean_deg`]) : rows.map((r) => r[`${s}_${p.joint}_flexion_deg`]));
    const all = series.flat().filter((v) => v != null && Number.isFinite(v));
    let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 10;
    const padv = Math.max(2, (hi - lo) * 0.08); lo -= padv; hi += padv;
    const step = niceStep((hi - lo) / 6);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const X = (x) => L + ((R - L) * x) / xmax, Y = (y) => B - ((B - T) * (y - lo)) / (hi - lo);
    g.font = font(28); g.fillStyle = "#000"; g.textAlign = "center"; g.fillText(p.title, (L + R) / 2, T - 28);
    g.strokeStyle = "rgba(0,0,0,0.12)"; g.lineWidth = 1.5; g.font = font(22); g.fillStyle = "#333";
    for (let y = lo; y <= hi + 1e-9; y += step) { g.beginPath(); g.moveTo(L, Y(y)); g.lineTo(R, Y(y)); g.stroke(); g.textAlign = "right"; g.fillText(String(Math.round(y * 100) / 100), L - 12, Y(y)); }
    const xstep = cyc ? 10 : niceStep(xmax / 10);
    for (let x = 0; x <= xmax + 1e-9; x += xstep) { g.beginPath(); g.moveTo(X(x), T); g.lineTo(X(x), B); g.stroke(); if (k === 1 || !cyc) { g.textAlign = "center"; g.fillText(String(Math.round(x * 100) / 100), X(x), B + 24); } }
    g.strokeStyle = "#000"; g.lineWidth = 2; g.strokeRect(L, T, R - L, B - T);
    g.save(); g.translate(48, (T + B) / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.font = font(24); g.fillStyle = "#000"; g.fillText("角度（度）", 0, 0); g.restore();
    const colors = ["#1f77b4", "#ff7f0e"], names = ["左", "右"];
    series.forEach((ys, si) => {
      g.strokeStyle = colors[si]; g.lineWidth = 3; g.beginPath(); let pen = false;
      ys.forEach((y, i) => { if (y == null || !Number.isFinite(y)) { pen = false; return; } if (!pen) { g.moveTo(X(xs[i]), Y(y)); pen = true; } else g.lineTo(X(xs[i]), Y(y)); });
      g.stroke();
    });
    // 凡例
    const lw = 420, lx = R - lw - 16, ly = T + 16;
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(lx, ly, lw, 86); g.strokeStyle = "#ccc"; g.lineWidth = 1; g.strokeRect(lx, ly, lw, 86);
    names.forEach((n, si) => {
      g.strokeStyle = colors[si]; g.lineWidth = 3; g.beginPath(); g.moveTo(lx + 16, ly + 24 + si * 38); g.lineTo(lx + 66, ly + 24 + si * 38); g.stroke();
      g.fillStyle = "#000"; g.textAlign = "left"; g.font = font(22);
      g.fillText(cyc ? `${n}${p.name}（${opt.legend || nCycles + "周期平均"}）` : `${n}${p.name}`, lx + 78, ly + 24 + si * 38);
    });
  });
  g.textAlign = "center"; g.font = font(26); g.fillStyle = "#000";
  g.fillText(xlabel, (L + R) / 2, top0 + 2 * ph + gap + 70);
  return c;
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ---------- 結果 ----------
async function renderResults() {
  const list = (await dbAll("results")).sort((a, b) => b.created - a.created);
  const ul = $("#resultList");
  if (!list.length) { ul.innerHTML = `<li class="empty">解析結果はまだありません。</li>`; return; }
  ul.innerHTML = list.map((r) => `
    <li data-id="${r.id}">
      <div class="meta"><b>${esc(r.base)}</b>
        <span>${r.engine === "rtmpose" ? "RTMPose ・ " : ""}${fmtDate(r.created)} ・ ${r.frames}フレーム ・ ${r.nCycles}周期${r.warning ? " ・ ⚠" : ""}</span></div>
      <div class="acts">
        <button class="btn small" data-act="open">表示</button>
        <button class="btn small sub" data-act="delete">削除</button>
      </div>
    </li>`).join("");
}
$("#resultList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest("li").dataset.id;
  if (b.dataset.act === "open") openResult(id);
  if (b.dataset.act === "delete" && confirm("この解析結果を削除しますか？")) {
    await dbDel("results", id); $("#resultView").classList.add("hidden"); renderResults();
  }
});
let viewUrls = [];
async function openResult(id) {
  const r = await dbGet("results", id);
  viewUrls.forEach(URL.revokeObjectURL); viewUrls = [];
  const u = (b) => { const x = URL.createObjectURL(b); viewUrls.push(x); return x; };
  const files = resultFiles(r);
  const sideJ = r.cycleSide === "left" ? "左" : "右";
  $("#resultView").innerHTML = `
    <h2 style="margin-top:0">${esc(r.base)}</h2>
    ${r.warning ? `<p class="warn">${esc(r.warning).replace(/\n/g, "<br>")}</p>` : ""}
    <table class="sum">
      <tr><td>動画</td><td>${esc(r.videoName)}（${r.width}×${r.height}）</td></tr>
      <tr><td>解析エンジン</td><td>${r.engine === "rtmpose" ? "RTMPose（Halpe26）" : "MediaPipe Pose"}${r.backendName ? `・${r.backendName}` : ""}</td></tr>
      <tr><td>解析区間</td><td>${!r.range || r.range.whole ? "動画全体" : `${r.range.start.toFixed(2)}〜${r.range.end.toFixed(2)}秒`}</td></tr>
      <tr><td>フレーム数 / fps</td><td>${r.frames} / ${r.fps}</td></tr>
      <tr><td>人物検出フレーム</td><td>${r.detected}（${Math.round((100 * r.detected) / r.frames)}%）</td></tr>
      <tr><td>追跡対象</td><td>${r.trackInfo && r.trackInfo.seeded ? "タップで指定した人" : `進行方向（${r.direction > 0 ? "右" : "左"}${r.dir2 != null ? `→${r.dir2 > 0 ? "右" : "左"}の往復` : ""}）の先頭の人`}${r.trackInfo ? "（フレームをまたいで同じ人を追跡）" : ""}</td></tr>
      ${r.trackInfo ? `<tr><td>追跡</td><td>複数人が映ったフレーム ${r.trackInfo.multi}・対象者を確認できず空欄にしたフレーム ${r.trackInfo.missing}</td></tr>` : ""}
      ${r.roundTrip ? `<tr><td>方向転換（除外）</td><td>${(r.roundTrip.turnStart / r.fps).toFixed(2)}〜${(r.roundTrip.turnEnd / r.fps).toFixed(2)}秒</td></tr>` : ""}
      <tr><td>周期</td><td>${sideJ}側の足・${r.nCycles}周期（接地検出は推定）</td></tr>
    </table>
    ${r.perCycle ? cycleSection(r) : ""}
    ${r.light ? lightSection(r) : ""}
    <img id="graphImg" src="${u(r.png)}" alt="グラフ">
    ${r.stick ? `<h2>スティックピクチャー動画</h2><video src="${u(r.stick)}" controls playsinline></video>` : ""}
    <div class="row">
      <button class="btn" data-f="all">すべて保存/共有</button>
      ${files.map((f, i) => `<button class="btn sub small" data-f="${i}">${f.label}</button>`).join("")}
    </div>
    <p class="hint">「ファイルに保存」でファイルAppへ、動画は「ビデオを保存」で写真Appへ保存できます。</p>`;
  $("#resultView").classList.remove("hidden");
  $("#resultView").querySelectorAll("button[data-f]").forEach((b) => b.onclick = () => {
    const sel = b.dataset.f === "all" ? files : [files[Number(b.dataset.f)]];
    saveFiles(sel.map((f) => f.file));
  });
  if (r.perCycle) bindCycleSection(r, u);
  $("#resultView").scrollIntoView({ behavior: "smooth" });
}
const sideJp = (s) => (s === "left" ? "左" : "右");
const fmt1 = (v) => (v == null ? "-" : Number(v).toFixed(1));
function lightSection(r) {
  const L = r.light;
  if (!L.events.length) return `<h2>光刺激</h2><p class="warn">${esc((L.info && L.info.note) || "光刺激を検出できませんでした")}。光の範囲を指定し直してください。</p>`;
  return `<h2>光刺激（${L.events.length}回）</h2>
    <div class="tblwrap"><table class="cyc">
      <tr><th>回</th><th>点灯フレーム</th><th>点灯時刻(秒)</th><th>消灯時刻(秒)</th><th>点灯時間(秒)</th></tr>
      ${L.events.map((e) => `<tr><td>${e.event}</td><td>${e.onset_frame}</td><td>${e.onset_time_seconds.toFixed(3)}</td><td>${e.offset_time_seconds == null ? "-" : e.offset_time_seconds.toFixed(3)}</td><td>${e.duration_seconds == null ? "-" : e.duration_seconds.toFixed(3)}</td></tr>`).join("")}
    </table></div>
    <p class="hint">時刻は元の動画の時刻です。精度は1フレーム（${(1000 / r.fps).toFixed(0)}ミリ秒）。</p>`;
}
function cycleSection(r) {
  const pcs = r.perCycle;
  const segs = [...new Set(pcs.summaries.map((s) => s.segment))].filter((x) => x && x !== "片道");
  const rtCol = segs.length > 0;
  return `
    <h2>一歩行周期ごとの結果（基準：${sideJp(pcs.refSide)}足）</h2>
    <div class="tblwrap"><table class="cyc">
      <tr><th>周期</th>${rtCol ? "<th>区間</th>" : ""}<th>開始</th><th>時間(秒)</th><th>右膝 最大</th><th>右膝 可動域</th><th>左膝 最大</th><th>左膝 可動域</th><th>右股 可動域</th><th>左股 可動域</th></tr>
      ${pcs.summaries.map((s) => `<tr><td>${s.cycle}</td>${rtCol ? `<td>${s.segment}</td>` : ""}<td>${s.start_contact}</td><td>${s.cycle_duration_seconds}</td><td>${fmt1(s.right_knee_max_deg)}</td><td>${fmt1(s.right_knee_range_deg)}</td><td>${fmt1(s.left_knee_max_deg)}</td><td>${fmt1(s.left_knee_range_deg)}</td><td>${fmt1(s.right_hip_range_deg)}</td><td>${fmt1(s.left_hip_range_deg)}</td></tr>`).join("")}
    </table></div>
    <div class="row">
      <label>グラフ表示
        <select id="cycleSel"><option value="avg">全${pcs.summaries.length}周期の平均</option>
          ${segs.map((g) => `<option value="seg:${g}">${g}の平均（${pcs.summaries.filter((s) => s.segment === g).length}周期）</option>`).join("")}
          ${pcs.summaries.map((s, i) => `<option value="${i}">周期${s.cycle}（${s.start_time_seconds}〜${s.end_time_seconds}秒）</option>`).join("")}
        </select>
      </label>
      <button id="cycleSave" class="btn sub small hidden">この周期を保存</button>
    </div>`;
}
function cycleGraph(r, i) {
  const s = r.perCycle.summaries[i];
  const data = r.perCycle.norms[i].map((p) => ({
    gait_cycle_percent: p.gait_cycle_percent,
    left_knee_mean_deg: p.left_knee_deg, left_hip_mean_deg: p.left_hip_deg, right_knee_mean_deg: p.right_knee_deg, right_hip_mean_deg: p.right_hip_deg,
  }));
  return canvasBlob(drawGraph(null, data, 1, r.fps, { legend: `周期${s.cycle}`, title: `周期${s.cycle}（${sideJp(r.perCycle.refSide)}足基準・${s.start_contact}接地）— 臨床測定ではありません` }));
}
function bindCycleSection(r, u) {
  const sel = $("#cycleSel"), img = $("#graphImg"), btn = $("#cycleSave");
  sel.onchange = async () => {
    if (sel.value === "avg") { img.src = u(r.png); btn.classList.add("hidden"); return; }
    if (sel.value.startsWith("seg:")) {
      const g = sel.value.slice(4), idx = r.perCycle.summaries.map((s, i) => (s.segment === g ? i : -1)).filter((i) => i >= 0);
      const data = G.meanOfNorms(idx.map((i) => r.perCycle.norms[i]));
      img.src = u(await canvasBlob(drawGraph(null, data, idx.length, r.fps, { legend: `${g}・${idx.length}周期平均`, title: `${g}の平均（${sideJp(r.perCycle.refSide)}足基準）— 臨床測定ではありません` })));
      btn.classList.add("hidden"); return;
    }
    img.src = u(await cycleGraph(r, Number(sel.value))); btn.classList.remove("hidden");
  };
  btn.onclick = async () => {
    const i = Number(sel.value), n = String(r.perCycle.summaries[i].cycle).padStart(2, "0");
    saveFiles([
      new File([r.perCycle.csvs[i]], `${r.base}_cycle${n}.csv`, { type: "text/csv" }),
      new File([await cycleGraph(r, i)], `${r.base}_cycle${n}_graph.png`, { type: "image/png" }),
    ]);
  };
}
function resultFiles(r) {
  const f = [
    { label: "CSV", file: new File([r.csv], `${r.base}.csv`, { type: "text/csv" }) },
    { label: "Excel", file: new File([r.xlsx], `${r.base}.xlsx`, { type: r.xlsx.type }) },
    { label: "グラフ", file: new File([r.png], `${r.base}_graph.png`, { type: "image/png" }) },
  ];
  if (r.perCycle) {
    f.push({ label: "周期一覧CSV", file: new File([r.perCycle.summaryCsv], `${r.base}_cycle_summary.csv`, { type: "text/csv" }) });
    f.push({ label: "周期別CSV", file: new File([r.perCycle.normCsv], `${r.base}_cycles_normalized.csv`, { type: "text/csv" }) });
  }
  if (r.light && r.light.csv) f.push({ label: "光刺激CSV", file: new File([r.light.csv], `${r.base}_light_events.csv`, { type: "text/csv" }) });
  if (r.stick) f.push({ label: "スティック動画", file: new File([r.stick], `${r.base}_stick_figure.mp4`, { type: "video/mp4" }) });
  return f;
}

// ---------- 起動 ----------
function updBadge() { $("#netBadge").textContent = !modelBytes ? "モデル未設定" : navigator.onLine ? "オフライン対応" : "オフラインで動作中"; }
(async () => {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch {}
  }
  try { await navigator.storage?.persist?.(); } catch {}
  const m = await getModel();
  window.addEventListener("online", updBadge); window.addEventListener("offline", updBadge); updBadge();
  if (!m) toast("最初に「設定」タブで姿勢推定モデルを取り込んでください", 5000);
})();
