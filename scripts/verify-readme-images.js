import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const forbiddenTextChunks = new Set(["iTXt", "tEXt", "zTXt"]);
const screenshots = ["topology.png", "open-ports.png"];

for (const filename of screenshots) {
  const imagePath = path.join(repositoryRoot, "docs", "images", filename);
  const image = await readFile(imagePath);

  if (image.length < 24 || !image.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${filename} is not a valid PNG file`);
  }
  if (image.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${filename} does not start with an IHDR chunk`);
  }

  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width !== 1600 || height < 1000) {
    throw new Error(`${filename} has unexpected dimensions: ${width}x${height}`);
  }

  let offset = 8;
  let foundEnd = false;
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.toString("ascii", offset + 4, offset + 8);
    const nextOffset = offset + 12 + length;
    if (nextOffset > image.length) {
      throw new Error(`${filename} contains a truncated ${type || "unknown"} chunk`);
    }
    if (forbiddenTextChunks.has(type)) {
      throw new Error(`${filename} contains forbidden textual metadata: ${type}`);
    }
    offset = nextOffset;
    if (type === "IEND") {
      foundEnd = true;
      break;
    }
  }

  if (!foundEnd || offset !== image.length) {
    throw new Error(`${filename} does not end with a complete IEND chunk`);
  }

  console.log(`${filename}: ${width}x${height}, PNG structure valid, no textual metadata`);
}
