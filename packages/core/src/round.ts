/** Internal rounding helper shared by the map-hash codec and search results. */

export const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};
