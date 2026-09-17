declare module 'jimp-compact' {
  interface JimpImage {
    bitmap: { width: number; height: number; data: Buffer };
    scan(
      x: number,
      y: number,
      width: number,
      height: number,
      callback: (x: number, y: number, offset: number) => void,
    ): JimpImage;
    crop(x: number, y: number, width: number, height: number): JimpImage;
    resize(width: number, height: number, mode?: unknown): JimpImage;
    quality(value: number): JimpImage;
    getMIME(): string;
    getBufferAsync(mime: string): Promise<Buffer>;
  }

  const Jimp: {
    read(data: Buffer): Promise<JimpImage>;
    MIME_JPEG: string;
    MIME_PNG: string;
    RESIZE_BILINEAR: unknown;
  };

  export default Jimp;
}
