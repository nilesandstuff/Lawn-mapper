/* The shared file format lives in public/lib/lidar-model.js (core session). This re-export is for Node (tests, the
   twin check); the scan deploy (scan/tools/prepare.mjs) puts the real file at /lib/lidar-model.js in its place. */
export * from '../../public/lib/lidar-model.js';
