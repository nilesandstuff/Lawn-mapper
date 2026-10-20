// public/lib/overture-fit.js and lib/predictions-overture.js: the fit over a photo frame, the layer list, the caption.
import assert from 'node:assert/strict';
import { fitFrame, frameGrid, CELL_M } from '../public/lib/overture-fit.js';
import { OVERTURE_LAYERS, withOverture, fitText } from '../public/lib/predictions-overture.js';

{
  // a 640-logical-pixel frame at zoom 19 (512 px tiles) at the equator is about 95 m across: ~191 half-metre cells
  const frame = { lng: 0, lat: 0, zoom: 19, size: 640 };
  const g = frameGrid(frame);
  assert.ok(Math.abs(g.W - 191) <= 2 && g.W === g.H, `${g.W} x ${g.H}`);
  assert.ok(Math.abs(g.cell - CELL_M) < 1e-9, 'at the equator a cell is a half-metre in mercator too');
  // one 20 x 10 m building centred in the frame; the lidar's roof 2 m east and 1 m south of it
  const R = 6378137, d = (m) => (m / R) * 180 / Math.PI;
  const ring = [[d(-10), d(-5)], [d(10), d(-5)], [d(10), d(5)], [d(-10), d(5)], [d(-10), d(-5)]];
  const roof = { data: new Uint8Array(g.W * g.H), w: g.W, h: g.H };
  const cx = g.W / 2, cy = g.H / 2;
  for (let r = Math.round(cy - 10 + 2); r < Math.round(cy + 10 + 2); r++) for (let c = Math.round(cx - 20 + 4); c < Math.round(cx + 20 + 4); c++) roof.data[r * g.W + c] = 1;
  const f = fitFrame(frame, [[ring]], roof);
  assert.ok(f && f.applied, JSON.stringify(f));
  assert.equal(f.eastM, 2); assert.equal(f.southM, 1);
  assert.ok(f.iou > 0.9 && f.iou0 < 0.7, `${f.iou0} -> ${f.iou}`);
  assert.equal(fitFrame(frame, [], roof), null, 'no building');
  assert.equal(fitFrame(frame, [[ring]], null), null, 'no roof');
  const bare = fitFrame(frame, [[ring]], { data: new Uint8Array(g.W * g.H), w: g.W, h: g.H });
  assert.equal(bare, null, 'a blank roof mask is nothing to fit to');
}
{
  const run = [{ id: 'truth' }, { id: 'roof' }, { id: 'shapes' }, { id: 'line' }];
  const defs = withOverture(run);
  assert.deepEqual(defs.map((l) => l.id), ['truth', 'roof', 'ovtRoad', 'ovtWalk', 'ovtBuilding', 'ovtFit', 'shapes', 'line'], 'under the outline and the property line');
  assert.deepEqual(withOverture(defs).map((l) => l.id), defs.map((l) => l.id), 'added once');
  assert.deepEqual(withOverture([{ id: 'truth' }]).map((l) => l.id), ['truth', ...OVERTURE_LAYERS.map((l) => l.id)], 'at the end when there is no outline');
  assert.ok(OVERTURE_LAYERS.every((l) => l.client && l.colour.length === 3 && l.label));
}
{
  assert.equal(fitText(null, 0, 3), '0 buildings, 3 road or sidewalk lines from Overture.');
  assert.equal(fitText(null, 1, 1), '1 building, 1 road or sidewalk line from Overture. No lidar roof here to fit the buildings to.');
  assert.match(fitText({ applied: false, iou0: 0.5, iou: 0.51 }, 2, 0), /Left as published.*50% as published, 51% at best/);
  assert.match(fitText({ applied: true, eastM: -0.5, southM: 1, iou0: 0.4, iou: 0.8 }, 2, 0), /Moved 0\.5 m W, 1\.0 m S .* 40% as published, 80% moved/);
}
console.log('predictions-overture: ok');
