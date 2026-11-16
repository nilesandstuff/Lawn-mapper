/** The browser data reader's name over the Node one (lib/node-io.js): lidar tiles and laz-perf from disk. */
import { nodeIo } from '../lib/node-io.js';
export async function workerIo() { return nodeIo(); }
