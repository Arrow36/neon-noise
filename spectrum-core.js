export const FFT_SIZE = 32768;
export const MIN_HZ = 1;
export const HISTORY_WINDOW_MS = 20_000;
export const HISTORY_INTERVAL_MS = 110;
export const GAIN_MIN_DB = -36;
export const GAIN_MAX_DB = 36;
export const MAIN_MIN_HZ = 20;
export const MAIN_MAX_HZ = 20_000;
export const EDGE_RATIO = 0.07;

export function clampGainDb(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, Math.round(numeric)));
}

export function gainDbToLinear(db) {
  return Math.pow(10, clampGainDb(db) / 20);
}

export function createFrequencyConfig(sampleRate, fftSize = FFT_SIZE, dataLength = fftSize / 2) {
  if (!(sampleRate > MIN_HZ * 2) || !(fftSize > 0) || !(dataLength > 0)) {
    throw new RangeError("采样率、FFT 大小和数据长度必须为正数");
  }
  const binWidth = sampleRate / fftSize;
  return {
    sampleRate,
    fftSize,
    dataLength,
    binWidth,
    minHz: MIN_HZ,
    maxHz: sampleRate / 2,
    minBin: 1,
    maxBin: Math.max(1, dataLength - 1)
  };
}

export function frequencyToRatio(frequency, config) {
  const clamped = Math.max(config.minHz, Math.min(config.maxHz, frequency));
  if (config.maxHz <= MAIN_MIN_HZ) {
    return Math.log(clamped / config.minHz) / Math.log(config.maxHz / config.minHz);
  }
  if (clamped <= MAIN_MIN_HZ) {
    return EDGE_RATIO * Math.log(clamped / config.minHz) / Math.log(MAIN_MIN_HZ / config.minHz);
  }
  const mainMax = Math.min(MAIN_MAX_HZ, config.maxHz);
  const highShare = config.maxHz > MAIN_MAX_HZ ? EDGE_RATIO : 0;
  const mainRight = 1 - highShare;
  if (clamped <= mainMax) {
    return EDGE_RATIO + (mainRight - EDGE_RATIO) *
      Math.log(clamped / MAIN_MIN_HZ) / Math.log(mainMax / MAIN_MIN_HZ);
  }
  return mainRight + highShare * Math.log(clamped / MAIN_MAX_HZ) /
    Math.log(config.maxHz / MAIN_MAX_HZ);
}

export function ratioToFrequency(ratio, config) {
  const clamped = Math.max(0, Math.min(1, ratio));
  if (config.maxHz <= MAIN_MIN_HZ) {
    return config.minHz * Math.pow(config.maxHz / config.minHz, clamped);
  }
  if (clamped <= EDGE_RATIO) {
    return config.minHz * Math.pow(MAIN_MIN_HZ / config.minHz, clamped / EDGE_RATIO);
  }
  const mainMax = Math.min(MAIN_MAX_HZ, config.maxHz);
  const highShare = config.maxHz > MAIN_MAX_HZ ? EDGE_RATIO : 0;
  const mainRight = 1 - highShare;
  if (clamped <= mainRight) {
    return MAIN_MIN_HZ * Math.pow(mainMax / MAIN_MIN_HZ,
      (clamped - EDGE_RATIO) / (mainRight - EDGE_RATIO));
  }
  return MAIN_MAX_HZ * Math.pow(config.maxHz / MAIN_MAX_HZ,
    (clamped - mainRight) / highShare);
}

export function buildPixelBinMap(width, config) {
  const pixelCount = Math.max(1, Math.ceil(width));
  const starts = new Uint32Array(pixelCount);
  const ends = new Uint32Array(pixelCount);

  for (let x = 0; x < pixelCount; x++) {
    const lowHz = ratioToFrequency(x / pixelCount, config);
    const highHz = ratioToFrequency((x + 1) / pixelCount, config);
    let start = Math.max(config.minBin, Math.ceil(lowHz / config.binWidth));
    let end = Math.min(config.maxBin, Math.floor(highHz / config.binWidth));
    if (start > end) {
      const centerHz = ratioToFrequency((x + 0.5) / pixelCount, config);
      const nearest = Math.max(config.minBin, Math.min(config.maxBin, Math.round(centerHz / config.binWidth)));
      start = nearest;
      end = nearest;
    }
    starts[x] = start;
    ends[x] = end;
  }
  return { width: pixelCount, starts, ends };
}

export function aggregateColumnsMax(data, map, fallback = -115, output = null) {
  const result = output && output.length === map.width ? output : new Float32Array(map.width);
  for (let x = 0; x < map.width; x++) {
    let maximum = -Infinity;
    const start = Math.min(data.length - 1, map.starts[x]);
    const end = Math.min(data.length - 1, map.ends[x]);
    for (let bin = start; bin <= end; bin++) {
      if (Number.isFinite(data[bin]) && data[bin] > maximum) maximum = data[bin];
    }
    result[x] = Number.isFinite(maximum) ? maximum : fallback;
  }
  return result;
}

export function frameBand(timestamp, anchorTimestamp, height, options = {}) {
  const windowMs = options.windowMs ?? HISTORY_WINDOW_MS;
  const nominalIntervalMs = options.nominalIntervalMs ?? HISTORY_INTERVAL_MS;
  const ageMs = anchorTimestamp - timestamp;
  if (ageMs < 0 || ageMs > windowMs) return null;
  const centerY = ageMs / windowMs * height;
  const halfHeight = Math.max(0.5, nominalIntervalMs / windowMs * height / 2);
  return {
    top: Math.max(0, centerY - halfHeight),
    bottom: Math.min(height, centerY + halfHeight)
  };
}

export function recentFrames(frames, anchorTimestamp, windowMs = HISTORY_WINDOW_MS) {
  return frames.filter(frame => {
    const age = anchorTimestamp - frame.timestamp;
    return age >= 0 && age <= windowMs;
  });
}

export function nextLifecycleState(state, event) {
  const table = {
    idle: { START: "starting", STOP: "stopped" },
    starting: { STARTED: "running", FAILED: "error", STOP: "stopped" },
    running: { PAUSE: "paused", ANALYZE: "analyzing", INTERRUPT: "paused", STOP: "stopped", FAIL: "error" },
    paused: { START: "starting", RESUME: "running", ANALYZE: "analyzing", STOP: "stopped", FAIL: "error" },
    analyzing: { RESUME: "running", DONE: "paused", CANCEL: "paused", STOP: "stopped", FAIL: "error" },
    stopped: { START: "starting" },
    error: { START: "starting", STOP: "stopped" }
  };
  return table[state]?.[event] ?? state;
}

export function invalidateGeneration(generation) {
  return generation + 1;
}
