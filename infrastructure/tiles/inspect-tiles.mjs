// Decode a PMTiles archive: layer names, feature counts, attribute samples.
// usage: node inspect.mjs <file.pmtiles> [z x y | --bbox minLon minLat maxLon maxLat z]
import { open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

class FileSource {
  constructor(path) {
    this.path = path;
    this.key = path;
  }
  getKey() {
    return this.key;
  }
  async getBytes(offset, length) {
    const fh = await open(this.path, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    } finally {
      await fh.close();
    }
  }
}

const [file, ...rest] = process.argv.slice(2);
const p = new PMTiles(new FileSource(file));
const header = await p.getHeader();
console.log('zoom', header.minZoom, '-', header.maxZoom, 'tiles', header.tileType);
console.log('bounds', header.minLon, header.minLat, header.maxLon, header.maxLat);

function lon2x(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2y(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

let tiles = [];
if (rest[0] === '--bbox') {
  const [minLon, minLat, maxLon, maxLat, z] = rest.slice(1).map(Number);
  for (let x = lon2x(minLon, z); x <= lon2x(maxLon, z); x++)
    for (let y = lat2y(maxLat, z); y <= lat2y(minLat, z); y++) tiles.push([z, x, y]);
} else if (rest.length === 3) {
  tiles = [rest.map(Number)];
} else {
  throw new Error('need tile coords');
}

const counts = new Map();
const samples = new Map();
let withData = 0;
for (const [z, x, y] of tiles) {
  const t = await p.getZxy(z, x, y);
  if (!t) continue;
  withData++;
  let buf = Buffer.from(t.data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const vt = new VectorTile(new Pbf(buf));
  for (const [name, layer] of Object.entries(vt.layers)) {
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const cls = f.properties.class ?? '(none)';
      const key = `${name}/${cls}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!samples.has(key)) samples.set(key, f.properties);
    }
  }
}
console.log(`tiles with data: ${withData}/${tiles.length}`);
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(String(v).padStart(7), k, JSON.stringify(samples.get(k)));
}
