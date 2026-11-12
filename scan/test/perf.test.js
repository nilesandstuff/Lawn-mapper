// node scan/test/perf.test.js
import assert from 'node:assert/strict';
import { newPerf, hist, groupOf, resources, perfLines } from '../lib/perf.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); if (!ok) failures++; };

{
  const h = hist(100);
  for (let i = 1; i <= 100; i++) h.add(i);
  check('a histogram gives the median and the 95th', h.q(0.5) === 50 && h.q(0.95) === 95 && h.max() === 100 && h.n() === 100);
  h.add(5000);
  check('a value past the top is kept as the top, and as the worst', h.q(1) === 100 && h.max() === 5000);
}
{
  let t = 0;
  const p = newPerf({ now: () => t });
  t = 1500; p.stage('map'); t = 4000; p.stage('lidar'); t = 9000; p.stage('map'); // said twice: the first stands
  // 100 frames 33 ms apart, each 5 ms of work; then one stall of 400 ms; then 10 at 80 ms
  let at = 10000;
  for (let i = 0; i < 100; i++) { p.frame(at, at + 5); at += 33; }
  at += 400; p.frame(at, at + 30);
  for (let i = 0; i < 10; i++) { at += 80; p.frame(at, at + 5); }
  t = at;
  // held still 2 s with 1 mm of noise a frame, then a 12 cm jump, then walking
  let s = 0;
  for (let i = 0; i < 60; i++) { p.pose([i % 2 ? 0.001 : 0, 1.5, 0], s); s += 1 / 30; }
  p.pose([0.12, 1.5, 0], s); s += 1 / 30;
  for (let i = 0; i < 30; i++) { p.pose([0.12 + i * 0.04, 1.5, 0], s); s += 1 / 30; }
  p.time('lidar shapes', 800); p.time('lidar shapes', 200);
  p.time('frame: drawing', 30); p.time('frame: drawing', 10); p.time('frame: top box', 60);
  p.uploadOpen();
  for (let i = 0; i < 9; i++) p.part(900, 30000, 'ok');
  p.part(5000, 30000, 'retry');
  t += 20000; p.uploadDone();
  const out = p.summary({ device: { cores: 8, memoryGb: 8, net: '4g' }, resources: {} });
  check('stages are seconds since the page began, the first saying kept', out.stagesS.map === 1.5 && out.stagesS.lidar === 4);
  check('frames: the usual gap, and the long ones counted', out.frames.n === 111 && out.frames.gapMs.median === 33 && out.frames.stalls === 1 && out.frames.gapMs.worst === 433 && Math.abs(out.frames.longShare - 11 / 110) < 0.01, JSON.stringify(out.frames));
  check('frames: the page\'s own work', out.frames.workMs.median === 5 && out.frames.workMs.worst === 30);
  check('jitter: a still phone\'s place, a millimetre a frame', out.jitter.stillMmPerFrame?.median === 1 && out.jitter.stillS >= 1, JSON.stringify(out.jitter));
  check('jitter: the jump is counted, walking is not', out.jitter.jumps === 1 && out.jitter.jumpWorstCm === 12, JSON.stringify(out.jitter));
  check('waits are counted with their longest', out.waits['lidar shapes'].n === 2 && out.waits['lidar shapes'].ms === 1000 && out.waits['lidar shapes'].longestMs === 800);
  check('upload: sends, what was taken, the time inside and from first to last', out.upload.sends === 10 && out.upload.ok === 9 && out.upload.retried === 1 && out.upload.kb === 270 && out.upload.wallS === 20 && out.upload.finished && out.upload.sendMs.median === 900, JSON.stringify(out.upload));
  const text = JSON.stringify(out);
  check('nothing in it the site would refuse (no coordinates, no addresses)', !/"(lng|lat|latitude|longitude|address)"/.test(text));
  const lines = perfLines(out);
  check('the lines say it in words', lines.length === 8 && /median 33 ms/.test(lines[2]) && /1 jumps/.test(lines[3]) && /10 sends/.test(lines[6]), lines.join('\n'));
  check('a frame\'s parts are shared out, the biggest first', /top box 60% \(60\.0 ms a time x1, worst 60 ms\); drawing 40%/.test(lines[4]) && !/frame:/.test(lines[5]), lines[4]);
  check('an older walk says it was not measured', /not measured/.test(perfLines(null)[0]));
}
{
  check('a request is counted under a group, never its own name', groupOf('https://x.test/api/imagery?lng=1&lat=2') === 'photo' && groupOf('/vendor/a.wasm') === 'engine' && groupOf('/lib/perf.js') === 'page'
    && groupOf('/api/maps/model?id=5%20main%20st') === 'lidar model' && groupOf('/api/scan/twin?walk=1') === 'upload');
  const r = resources([
    { name: 'https://x.test/api/maps/model?id=secret', transferSize: 2_500_000, decodedBodySize: 2_500_000, duration: 4200 },
    { name: 'https://x.test/vendor/big.js', transferSize: 0, decodedBodySize: 900000, duration: 12 },
    { name: 'https://x.test/api/scan/twin?walk=1&part=a', transferSize: 300, duration: 900 },
  ]);
  check('downloads by group: size, time, and what the phone already had', r['lidar model'].kb === 2500 && r['lidar model'].slowestMs === 4200 && r.engine.cached === 1 && !r.upload && !JSON.stringify(r).includes('secret'), JSON.stringify(r));
}
console.log(failures ? `\n${failures} FAILED` : '\nperf: ok');
process.exit(failures ? 1 : 0);
