import { performance } from "node:perf_hooks";
import { createFrequencyConfig, buildPixelBinMap, aggregateColumnsMax } from "../spectrum-core.js";

const config = createFrequencyConfig(48000);
const map = buildPixelBinMap(390, config);
const data = new Float32Array(config.dataLength).fill(-90);
const repeat = 2000;
let start = performance.now();
for (let i = 0; i < repeat; i++) aggregateColumnsMax(data, map);
const aggregateMs = (performance.now() - start) / repeat;

const frames = [];
start = performance.now();
for (let i = 0; i < 100_000; i++) {
  frames.push(i);
  if (frames.length > 182) frames.shift();
}
const shiftMs = (performance.now() - start) / 100_000;

console.log(`合成 390px 列聚合：${aggregateMs.toFixed(4)} ms/帧`);
console.log(`182 帧数组 push/shift：${shiftMs.toFixed(6)} ms/操作`);
console.log("仅衡量 Node.js 纯算法；不代表浏览器绘制或真实麦克风性能。");
