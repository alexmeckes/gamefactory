import { inflateSync } from "node:zlib";

export interface PngInspection {
  width: number;
  height: number;
  colorType: number;
  hasAlpha: boolean;
  opaqueCoverage: number;
  transparentCorners: number;
  safeMargin: number;
  contrast: number;
  meanRed: number;
  meanGreen: number;
  meanBlue: number;
  redDominance: number;
  horizontalSymmetry: number;
  verticalSymmetry: number;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= diagonalDistance ? left : upDistance <= diagonalDistance ? up : upperLeft;
}

function channels(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`Unsupported PNG color type ${colorType}; indexed PNGs must be normalized to RGBA`);
}

export function inspectPng(content: Buffer, requestedMargin?: number): PngInspection {
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
    if (type === "IHDR") {
      width = content.readUInt32BE(start);
      height = content.readUInt32BE(start + 4);
      bitDepth = content[start + 8] ?? 0;
      colorType = content[start + 9] ?? -1;
      interlace = content[start + 12] ?? -1;
    } else if (type === "IDAT") {
      compressed.push(content.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (width < 1 || height < 1 || width * height > 16_777_216) throw new Error("PNG dimensions are invalid or exceed the inspection limit");
  if (bitDepth !== 8 || interlace !== 0) throw new Error("PNG must use 8-bit, non-interlaced pixels");
  const channelCount = channels(colorType);
  const rowBytes = width * channelCount;
  const inflated = inflateSync(Buffer.concat(compressed));
  if (inflated.length !== (rowBytes + 1) * height) throw new Error("PNG scanline size does not match its header");
  const pixels = Buffer.alloc(rowBytes * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset] ?? 0;
    sourceOffset += 1;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + x] ?? 0;
      const destination = y * rowBytes + x;
      const left = x >= channelCount ? pixels[destination - channelCount] ?? 0 : 0;
      const up = y > 0 ? pixels[destination - rowBytes] ?? 0 : 0;
      const upperLeft = y > 0 && x >= channelCount ? pixels[destination - rowBytes - channelCount] ?? 0 : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? paeth(left, up, upperLeft)
        : (() => { throw new Error(`Unsupported PNG filter ${filter}`); })();
      pixels[destination] = (raw + predictor) & 255;
    }
    sourceOffset += rowBytes;
  }

  const alphaChannel = colorType === 4 || colorType === 6;
  const margin = Math.max(1, Math.min(Math.floor(Math.min(width, height) / 3), requestedMargin ?? Math.round(Math.min(width, height) / 24)));
  let visible = 0;
  let marginPixels = 0;
  let marginTransparent = 0;
  let luminanceSum = 0;
  let luminanceSquareSum = 0;
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let redDominantPixels = 0;
  const alphaAt = (x: number, y: number): number => {
    const pixel = (y * width + x) * channelCount;
    return colorType === 4 ? pixels[pixel + 1] ?? 255 : colorType === 6 ? pixels[pixel + 3] ?? 255 : 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * channelCount;
      const alpha = alphaAt(x, y);
      const insideMargin = x < margin || y < margin || x >= width - margin || y >= height - margin;
      if (insideMargin) {
        marginPixels += 1;
        if (alpha <= 16) marginTransparent += 1;
      }
      if (alpha <= 16) continue;
      visible += 1;
      const red = colorType === 0 || colorType === 4 ? pixels[pixel] ?? 0 : pixels[pixel] ?? 0;
      const green = colorType === 0 || colorType === 4 ? red : pixels[pixel + 1] ?? 0;
      const blue = colorType === 0 || colorType === 4 ? red : pixels[pixel + 2] ?? 0;
      const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
      luminanceSum += luminance;
      luminanceSquareSum += luminance * luminance;
      redSum += red;
      greenSum += green;
      blueSum += blue;
      if (red > 32 && red >= green * 1.2 && red >= blue * 1.2) redDominantPixels += 1;
    }
  }
  const symmetry = (mirror: (x: number, y: number) => readonly [number, number]): number => {
    let difference = 0;
    let compared = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [mirrorX, mirrorY] = mirror(x, y);
        const alpha = alphaAt(x, y);
        const mirrorAlpha = alphaAt(mirrorX, mirrorY);
        if (alpha <= 16 && mirrorAlpha <= 16) continue;
        difference += Math.abs(alpha - mirrorAlpha);
        compared += 1;
      }
    }
    return compared > 0 ? Math.max(0, 1 - difference / (255 * compared)) : 0;
  };
  const total = width * height;
  const mean = visible > 0 ? luminanceSum / visible : 0;
  const variance = visible > 0 ? Math.max(0, luminanceSquareSum / visible - mean * mean) : 0;
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]] as const;
  return {
    width,
    height,
    colorType,
    hasAlpha: alphaChannel,
    opaqueCoverage: visible / total,
    transparentCorners: corners.filter(([x, y]) => alphaAt(x, y) <= 16).length / corners.length,
    safeMargin: marginPixels > 0 ? marginTransparent / marginPixels : 0,
    contrast: Math.min(1, Math.sqrt(variance) / 0.25),
    meanRed: visible > 0 ? redSum / (visible * 255) : 0,
    meanGreen: visible > 0 ? greenSum / (visible * 255) : 0,
    meanBlue: visible > 0 ? blueSum / (visible * 255) : 0,
    redDominance: visible > 0 ? redDominantPixels / visible : 0,
    horizontalSymmetry: symmetry((x, y) => [width - 1 - x, y]),
    verticalSymmetry: symmetry((x, y) => [x, height - 1 - y])
  };
}
