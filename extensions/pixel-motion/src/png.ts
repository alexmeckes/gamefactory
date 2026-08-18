import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Buffer;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= diagonalDistance ? left : upDistance <= diagonalDistance ? up : upperLeft;
}

export function decodePng(content: Buffer): RgbaImage {
  if (content.length < 33 || !content.subarray(0, 8).equals(SIGNATURE)) throw new Error("File is not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const compressed: Buffer[] = [];
  while (offset + 12 <= content.length) {
    const length = content.readUInt32BE(offset);
    const type = content.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > content.length) throw new Error("PNG contains a truncated chunk");
    const expectedCrc = content.readUInt32BE(end);
    const actualCrc = crc32(content.subarray(offset + 4, end));
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} chunk has an invalid checksum`);
    if (type === "IHDR") {
      width = content.readUInt32BE(start);
      height = content.readUInt32BE(start + 4);
      bitDepth = content[start + 8] ?? 0;
      colorType = content[start + 9] ?? -1;
      interlace = content[start + 12] ?? -1;
    } else if (type === "IDAT") compressed.push(content.subarray(start, end));
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (width < 1 || height < 1 || width * height > 67_108_864) throw new Error("PNG dimensions are invalid or exceed the pixel-motion limit");
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error("Pixel-motion inputs must be 8-bit, non-interlaced RGB or RGBA PNGs");
  }
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const expectedBytes = (rowBytes + 1) * height;
  const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
  if (inflated.length !== expectedBytes) throw new Error("PNG scanline size does not match its header");
  const decoded = Buffer.alloc(rowBytes * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source] ?? 0;
    source += 1;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[source + x] ?? 0;
      const destination = y * rowBytes + x;
      const left = x >= channels ? decoded[destination - channels] ?? 0 : 0;
      const up = y > 0 ? decoded[destination - rowBytes] ?? 0 : 0;
      const upperLeft = y > 0 && x >= channels ? decoded[destination - rowBytes - channels] ?? 0 : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? paeth(left, up, upperLeft)
        : (() => { throw new Error(`Unsupported PNG filter ${filter}`); })();
      decoded[destination] = (raw + predictor) & 255;
    }
    source += rowBytes;
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = decoded[index * channels] ?? 0;
    pixels[index * 4 + 1] = decoded[index * channels + 1] ?? 0;
    pixels[index * 4 + 2] = decoded[index * channels + 2] ?? 0;
    pixels[index * 4 + 3] = channels === 4 ? decoded[index * channels + 3] ?? 0 : 255;
  }
  return { width, height, pixels };
}

export function encodePng(image: RgbaImage): Buffer {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1) throw new Error("PNG dimensions must be positive integers");
  if (image.pixels.length !== image.width * image.height * 4) throw new Error("RGBA pixel buffer length does not match its dimensions");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const row = y * (image.width * 4 + 1);
    scanlines[row] = 0;
    image.pixels.copy(scanlines, row + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
