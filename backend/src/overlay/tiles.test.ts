import Jimp from 'jimp-compact';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { colorizeLightPollutionTile } from './tiles.js';

describe('light-pollution tile palette', () => {
  it('leaves dark ground transparent and separates moderate from intense light', async () => {
    const source = PNG.sync.write({
      width: 3,
      height: 1,
      data: Buffer.from([0, 0, 0, 255, 96, 96, 96, 255, 255, 255, 255, 255]),
    });

    const image = await Jimp.read(await colorizeLightPollutionTile(source));
    const pixels = image.bitmap.data;
    expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...pixels.subarray(4, 8)]).toEqual([55, 190, 82, 180]);
    expect([...pixels.subarray(8, 12)]).toEqual([255, 255, 255, 248]);
  });
});
