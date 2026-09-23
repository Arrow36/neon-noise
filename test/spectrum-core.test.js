import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  FFT_SIZE,
  EDGE_RATIO,
  GAIN_MIN_DB,
  GAIN_MAX_DB,
  clampGainDb,
  gainDbToLinear,
  createFrequencyConfig,
  frequencyToRatio,
  ratioToFrequency,
  buildPixelBinMap,
  aggregateColumnsMax,
  frameBand,
  recentFrames,
  nextLifecycleState,
  isGainLocked,
  invalidateGeneration
} from "../spectrum-core.js";
import { computeAnalysisPayload } from "../analysis-worker.js";

test("输入增益覆盖 ±36 dB 且保持 1 dB 整数步进", () => {
  assert.equal(GAIN_MIN_DB, -36);
  assert.equal(GAIN_MAX_DB, 36);
  assert.equal(clampGainDb(-99), -36);
  assert.equal(clampGainDb(99), 36);
  assert.equal(clampGainDb(2.6), 3);
  assert.ok(Math.abs(gainDbToLinear(20) - 10) < 1e-12);
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="gain"[^>]+min="-36"[^>]+max="36"[^>]+step="1"/);
  assert.match(html, /clearHistory\(`输入增益已改为/);
  assert.match(html, /fftWindowMs = \(analyser\?\.fftSize \|\| FFT_SIZE\) \/ getSampleRate\(\) \* 1000/);
  assert.match(html, /historyBlockUntil = performance\.now\(\) \+ GAIN_SETTLE_MS \+ fftWindowMs/);
});

test("频率边界来自实际采样率，排除 DC 且 bin 不越界", () => {
  for (const [sampleRate, expectedMax] of [[44100, 22050], [48000, 24000], [96000, 48000]]) {
    const config = createFrequencyConfig(sampleRate, FFT_SIZE, FFT_SIZE / 2);
    assert.equal(config.minHz, 1);
    assert.equal(config.maxHz, expectedMax);
    assert.equal(config.minBin, 1);
    assert.equal(config.maxBin, FFT_SIZE / 2 - 1);
    const map = buildPixelBinMap(997, config);
    assert.ok(map.starts.every(bin => bin >= 1 && bin < FFT_SIZE / 2));
    assert.ok(map.ends.every(bin => bin >= 1 && bin < FFT_SIZE / 2));
  }
});

test("20 Hz 至 20 kHz 占据主轴，两端各占一小格且映射可逆", () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    const config = createFrequencyConfig(sampleRate);
    assert.ok(Math.abs(frequencyToRatio(20, config) - EDGE_RATIO) < 1e-12);
    assert.ok(Math.abs(frequencyToRatio(20000, config) - (1 - EDGE_RATIO)) < 1e-12);
    assert.equal(frequencyToRatio(1, config), 0);
    assert.equal(frequencyToRatio(config.maxHz, config), 1);
    for (const frequency of [1, 5, 20, 50, 300, 1000, 10000, 20000, config.maxHz]) {
      const restored = ratioToFrequency(frequencyToRatio(frequency, config), config);
      assert.ok(Math.abs(restored - frequency) / frequency < 1e-10);
    }
  }
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /const x = rawX;/);
  assert.doesNotMatch(html, /id="stop"/);
});

test("20 Hz 以下与 20 kHz 以上的合成峰均进入显示列", () => {
  const config = createFrequencyConfig(96000, FFT_SIZE, FFT_SIZE / 2);
  const data = new Float32Array(config.dataLength).fill(-115);
  const lowBin = Math.round(10 / config.binWidth);
  const highBin = Math.round(30000 / config.binWidth);
  data[lowBin] = -22;
  data[highBin] = -28;
  const levels = aggregateColumnsMax(data, buildPixelBinMap(1200, config));
  assert.ok(levels.includes(-22));
  assert.ok(levels.includes(-28));
});

test("高频像素列聚合覆盖的所有 bin，不漏掉窄带峰", () => {
  const config = createFrequencyConfig(48000, FFT_SIZE, FFT_SIZE / 2);
  const data = new Float32Array(config.dataLength).fill(-110);
  const peakBin = Math.round(23123 / config.binWidth);
  data[peakBin] = -18;
  const map = buildPixelBinMap(320, config);
  const scratch = new Float32Array(map.width);
  const levels = aggregateColumnsMax(data, map, -115, scratch);
  assert.equal(levels, scratch);
  assert.equal(Math.max(...levels), -18);
  const peakColumn = levels.indexOf(-18);
  assert.ok(map.starts[peakColumn] <= peakBin && map.ends[peakColumn] >= peakBin);
});

test("时间轴位置只由时间戳决定，与绘制帧率无关且缺口留空", () => {
  const anchor = 50_000;
  const atFiveSeconds = frameBand(45_000, anchor, 400);
  assert.ok(Math.abs((atFiveSeconds.top + atFiveSeconds.bottom) / 2 - 100) < 1e-9);
  const frames30fps = [{ timestamp: 30_000 }, { timestamp: 45_000 }, { timestamp: 50_000 }];
  const frames120fps = Array.from({ length: 2001 }, (_, i) => ({ timestamp: 30_000 + i * 10 }));
  assert.equal(frameBand(frames30fps[0].timestamp, anchor, 400).bottom <= 400, true);
  assert.equal(frameBand(frames120fps[1500].timestamp, anchor, 400).top, atFiveSeconds.top);
  assert.deepEqual(recentFrames([{ timestamp: 29_999 }, ...frames30fps], anchor), frames30fps);
  assert.equal(frameBand(20_000, anchor, 400), null);
});

test("平均谱在线性功率域计算", () => {
  const frames = new Float32Array([-115, -20, -115, -40]);
  const result = computeAnalysisPayload({
    mode: "mean",
    framesBuffer: frames.buffer,
    frameCount: 2,
    binCount: 2,
    outputLength: 2,
    binLimit: 1,
    binWidth: 1
  });
  const expected = 10 * Math.log10((Math.pow(10, -20 / 10) + Math.pow(10, -40 / 10)) / 2);
  assert.ok(Math.abs(result.spectrum[1] - expected) < 1e-5);
});

test("Worker 的中位数、最大值与噪声模式返回稳定长度结果", () => {
  const frameCount = 5;
  const binCount = 32;
  const packed = new Float32Array(frameCount * binCount).fill(-100);
  for (let frame = 0; frame < frameCount; frame++) packed[frame * binCount + 12] = -35 + frame;
  for (const mode of ["median", "maximum", "noise"]) {
    const copy = packed.slice();
    const result = computeAnalysisPayload({
      mode,
      framesBuffer: copy.buffer,
      frameCount,
      binCount,
      outputLength: binCount,
      binLimit: binCount - 1,
      binWidth: 3
    });
    assert.equal(result.spectrum.length, binCount);
    assert.ok(Number.isFinite(result.spectrum[12]));
  }
});

test("浏览器模块脚本可解析且动态状态不使用 innerHTML", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match);
  const body = match[1].replace(/\s*import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/, "");
  assert.doesNotThrow(() => new Function(body));
  assert.doesNotMatch(body, /\.innerHTML\s*=/);
});

test("状态机覆盖初始化失败重试、分析取消与释放后继续", () => {
  let state = nextLifecycleState("idle", "START");
  state = nextLifecycleState(state, "FAILED");
  assert.equal(state, "error");
  state = nextLifecycleState(state, "START");
  state = nextLifecycleState(state, "STARTED");
  assert.equal(state, "running");
  state = nextLifecycleState(state, "ANALYZE");
  assert.equal(state, "analyzing");
  state = nextLifecycleState(state, "CANCEL");
  assert.equal(state, "paused");
  assert.equal(nextLifecycleState(state, "START"), "starting");
  assert.equal(invalidateGeneration(7), 8);
});

test("分析计算与结果展示期间锁定增益，返回实时视图后解锁", () => {
  assert.equal(isGainLocked("running", false), false);
  assert.equal(isGainLocked("analyzing", false), true);
  assert.equal(isGainLocked("paused", true), true);
  assert.equal(isGainLocked("paused", false), false);
});
