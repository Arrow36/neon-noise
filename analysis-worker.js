const MIN_DB = -115;

function buildAverageSpectrum(frames, frameCount, binCount, outputLength, binLimit) {
  const result = new Float32Array(outputLength);
  result.fill(MIN_DB);
  const sums = new Float64Array(binLimit + 1);
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * binCount;
    for (let bin = 1; bin <= binLimit; bin++) {
      const db = Number.isFinite(frames[offset + bin]) ? frames[offset + bin] : MIN_DB;
      sums[bin] += Math.pow(10, db / 10);
    }
  }
  for (let bin = 1; bin <= binLimit; bin++) {
    result[bin] = 10 * Math.log10(Math.max(1e-14, sums[bin] / frameCount));
  }
  return result;
}

function buildPercentileSpectrum(frames, frameCount, binCount, outputLength, binLimit, percentile) {
  const result = new Float32Array(outputLength);
  result.fill(MIN_DB);
  const values = new Float32Array(frameCount);
  const position = (frameCount - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const mix = position - lower;
  for (let bin = 1; bin <= binLimit; bin++) {
    for (let frame = 0; frame < frameCount; frame++) {
      const value = frames[frame * binCount + bin];
      values[frame] = Number.isFinite(value) ? value : MIN_DB;
    }
    values.sort();
    result[bin] = values[lower] + (values[upper] - values[lower]) * mix;
  }
  return result;
}

function buildMaximumSpectrum(frames, frameCount, binCount, outputLength, binLimit) {
  const result = new Float32Array(outputLength);
  result.fill(MIN_DB);
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * binCount;
    for (let bin = 1; bin <= binLimit; bin++) {
      const value = Number.isFinite(frames[offset + bin]) ? frames[offset + bin] : MIN_DB;
      if (value > result[bin]) result[bin] = value;
    }
  }
  return result;
}

function localMedian(data, index, binWidth, binLimit, offset = 0) {
  const frequency = Math.max(1, index * binWidth);
  const span = Math.max(6, Math.min(900, Math.round(frequency * 0.09 / binWidth)));
  const guard = Math.max(2, Math.min(span - 2, Math.round(frequency * 0.008 / binWidth)));
  const start = Math.max(1, index - span);
  const end = Math.min(binLimit, index + span);
  const step = Math.max(1, Math.floor((end - start + 1) / 36));
  const neighbors = [];
  for (let bin = start; bin <= end; bin += step) {
    if (Math.abs(bin - index) <= guard) continue;
    const value = data[offset + bin];
    if (Number.isFinite(value)) neighbors.push(value);
  }
  if (!neighbors.length) return MIN_DB;
  neighbors.sort((a, b) => a - b);
  const middle = Math.floor(neighbors.length / 2);
  return neighbors.length % 2 ? neighbors[middle] : (neighbors[middle - 1] + neighbors[middle]) / 2;
}

function buildNoiseSpectrum(frames, frameCount, binCount, outputLength, binLimit, binWidth) {
  const spectrum = buildAverageSpectrum(frames, frameCount, binCount, outputLength, binLimit);
  const candidates = [];
  for (let bin = 2; bin < binLimit - 1; bin++) {
    const db = spectrum[bin];
    if (db < -100 || db <= spectrum[bin - 1] || db < spectrum[bin + 1]) continue;
    const prominence = db - localMedian(spectrum, bin, binWidth, binLimit);
    if (prominence >= 3.5) candidates.push({ index: bin, db, prominence });
  }
  candidates.sort((a, b) => (b.prominence + (b.db + 100) * .03) - (a.prominence + (a.db + 100) * .03));
  const scored = candidates.slice(0, 80).map(candidate => {
    let appearances = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      const offset = frame * binCount;
      let frameDb = MIN_DB;
      for (let delta = -2; delta <= 2; delta++) {
        const value = frames[offset + candidate.index + delta];
        if (Number.isFinite(value) && value > frameDb) frameDb = value;
      }
      const floor = localMedian(frames, candidate.index, binWidth, binLimit, offset);
      if (frameDb >= -100 && frameDb - floor >= 3.5) appearances++;
    }
    const occurrence = appearances / frameCount;
    const denominator = spectrum[candidate.index - 1] - 2 * spectrum[candidate.index] + spectrum[candidate.index + 1];
    const peakOffset = denominator === 0 ? 0 : Math.max(-1, Math.min(1,
      .5 * (spectrum[candidate.index - 1] - spectrum[candidate.index + 1]) / denominator));
    return {
      frequency: (candidate.index + peakOffset) * binWidth,
      db: candidate.db,
      prominence: candidate.prominence,
      occurrence,
      score: candidate.prominence * (.35 + occurrence * .65) + Math.max(0, candidate.db + 100) * .03
    };
  }).filter(candidate => candidate.occurrence >= .08);
  scored.sort((a, b) => b.score - a.score);
  const peaks = [];
  for (const candidate of scored) {
    const separation = Math.max(15, candidate.frequency * .012);
    if (peaks.every(peak => Math.abs(peak.frequency - candidate.frequency) >= separation)) peaks.push(candidate);
    if (peaks.length === 5) break;
  }
  return { spectrum, peaks };
}

export function computeAnalysisPayload({ mode, framesBuffer, frameCount, binCount, outputLength, binLimit, binWidth }) {
  const frames = new Float32Array(framesBuffer);
  if (mode === "median") {
    return { spectrum: buildPercentileSpectrum(frames, frameCount, binCount, outputLength, binLimit, .5), peaks: null };
  }
  if (mode === "maximum") return { spectrum: buildMaximumSpectrum(frames, frameCount, binCount, outputLength, binLimit), peaks: null };
  if (mode === "noise") return buildNoiseSpectrum(frames, frameCount, binCount, outputLength, binLimit, binWidth);
  return { spectrum: buildAverageSpectrum(frames, frameCount, binCount, outputLength, binLimit), peaks: null };
}

if (typeof self !== "undefined") {
  self.onmessage = event => {
    const { id } = event.data;
    try {
      const result = computeAnalysisPayload(event.data);
      self.postMessage({ id, spectrumBuffer: result.spectrum.buffer, peaks: result.peaks }, [result.spectrum.buffer]);
    } catch (error) {
      self.postMessage({ id, error: error?.message || String(error) });
    }
  };
}
