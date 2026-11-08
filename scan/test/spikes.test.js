// One spot read near on a wall the rest of the picture reads far is a spike; a post in front of it, an edge, or a
// wall that is simply near are not.
import assert from 'node:assert/strict';
import { spikesIn } from '../lib/spikes.js';

const nx = 16, ny = 28;
const wall = () => new Float32Array(nx * ny).fill(9);   // a wall 9 m off, all over
{
  const r = wall(); r[10 * nx + 5] = 1.2;                // the owner's spot: one cell at 1.2 m
  const s = spikesIn(r, nx, ny);
  assert.equal(s[10 * nx + 5], 1, 'the spot is a spike');
  assert.equal(s.reduce((a, b) => a + b, 0), 1, 'and nothing else is');
}
{
  const r = wall(); for (let j = 0; j < ny; j++) r[j * nx + 7] = 2;   // a post 2 m off, top to bottom
  assert.equal(spikesIn(r, nx, ny).reduce((a, b) => a + b, 0), 0, 'a post in front of the wall is not');
}
{
  const r = wall(); for (let j = 0; j < ny; j++) for (let i = 0; i < 8; i++) r[j * nx + i] = 3;   // a near wall beside a far one
  assert.equal(spikesIn(r, nx, ny).reduce((a, b) => a + b, 0), 0, 'an edge between two surfaces is not');
}
{
  const r = wall().fill(2); r[50] = 1.5;                  // near everywhere: 1.5 against 2 is not 1 m nearer
  assert.equal(spikesIn(r, nx, ny).reduce((a, b) => a + b, 0), 0, 'a small dip on a near wall is not');
}
{
  const r = wall(); r[10 * nx + 5] = 1.2; const lab = new Uint8Array(nx * ny).fill(2); lab[10 * nx + 5] = 3;
  assert.equal(spikesIn(r, nx, ny, lab)[10 * nx + 5], 0, 'with labels, a cell of its own label has no neighbours to judge it by');
  lab[10 * nx + 5] = 2;
  assert.equal(spikesIn(r, nx, ny, lab)[10 * nx + 5], 1, 'a building cell among building cells is judged');
}
console.log('spikes: ok');
{
  const r = wall(); for (const [i, j] of [[5, 10], [6, 10], [5, 11], [6, 11]]) r[j * nx + i] = 1.5;   // a 2 x 2 spot
  const s = spikesIn(r, nx, ny);
  assert.equal(s.reduce((a, b) => a + b, 0), 4, 'a spot of a few cells is caught whole');
}
console.log('spikes (spots): ok');
