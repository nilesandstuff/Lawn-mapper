/** Where an index entry's octree lives (tools/shade-lidar-index.js drops the URL when it is the usual one). */
export const EPT_BASE = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/';
export const eptUrlOf = (entry) => entry.url || `${EPT_BASE}${entry.name}/ept.json`;
