declare module 'jimp-compact' {
  interface JimpImage {
    bitmap: { width: number; height: number };
    crop(x: number, y: number, width: number, height: number): JimpImage;
    resize(width: number, height: number, mode?: unknown): JimpImage;
    quality(value: number): JimpImage;
    getMIME(): string;
    getBufferAsync(mime: string): Promise<Buffer>;
  }

  const Jimp: {
    read(data: Buffer): Promise<JimpImage>;
    MIME_JPEG: string;
    RESIZE_BILINEAR: unknown;
  };

  export default Jimp;
}
