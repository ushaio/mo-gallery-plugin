// node_modules/.pnpm/@mo-gallery+plugin-sdk@file_154b06f11f4df763df80af071fde2bb6/node_modules/@mo-gallery/plugin-sdk/src/errors.ts
var ERROR_CODES = {
  INVALID_MANIFEST: "invalid_manifest",
  UNSUPPORTED_PLATFORM: "unsupported_platform",
  RUNTIME_MISSING: "runtime_missing",
  CAPABILITY_MISSING: "capability_missing",
  REQUEST_TIMEOUT: "request_timeout",
  REQUEST_CANCELED: "request_canceled",
  PLUGIN_CRASHED: "plugin_crashed",
  CREDENTIAL_UNAVAILABLE: "credential_unavailable",
  TRANSFER_FAILED: "transfer_failed"
};
var PluginError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.data = data;
  }
};
function toPluginError(error, fallbackCode = "plugin_error") {
  if (error instanceof PluginError) return error;
  if (error instanceof Error) return new PluginError(fallbackCode, error.message);
  return new PluginError(fallbackCode, String(error));
}

// node_modules/.pnpm/@mo-gallery+plugin-sdk@file_154b06f11f4df763df80af071fde2bb6/node_modules/@mo-gallery/plugin-sdk/src/transport.ts
import { createInterface } from "node:readline";
var JsonRpcStdioTransport = class {
  input;
  output;
  pending = /* @__PURE__ */ new Map();
  handlers = /* @__PURE__ */ new Map();
  logger;
  maxLineBytes;
  nextId = 1;
  closed = false;
  constructor(input, output, options = {}) {
    this.input = input;
    this.output = output;
    this.logger = options.logger;
    this.maxLineBytes = options.maxLineBytes ?? 4 * 1024 * 1024;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        this.logger?.error("Rejected oversized JSON-RPC message");
        return;
      }
      void this.handleLine(line);
    });
    lines.on("close", () => this.close(new PluginError(ERROR_CODES.PLUGIN_CRASHED, "plugin transport closed")));
    input.on("error", (error) => this.close(new PluginError(ERROR_CODES.PLUGIN_CRASHED, "plugin input failed", error.message)));
  }
  on(method, handler) {
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }
  async request(method, params, options = {}) {
    if (this.closed) throw new PluginError(ERROR_CODES.PLUGIN_CRASHED, "plugin transport is closed");
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, ...params === void 0 ? {} : { params } };
    const signal = options.signal;
    if (signal?.aborted) throw new PluginError(ERROR_CODES.REQUEST_CANCELED, "request was canceled");
    return await new Promise((resolve, reject) => {
      const pending = { resolve, reject };
      const abort = () => {
        this.pending.delete(id);
        this.write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
        reject(new PluginError(ERROR_CODES.REQUEST_CANCELED, "request was canceled"));
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      if (options.timeoutMs && options.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          this.write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
          reject(new PluginError(ERROR_CODES.REQUEST_TIMEOUT, `request timed out: ${method}`));
        }, options.timeoutMs);
      }
      this.pending.set(id, pending);
      try {
        this.write(request);
      } catch (error) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error);
      }
    });
  }
  notify(method, params) {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, ...params === void 0 ? {} : { params } });
  }
  close(reason = new PluginError(ERROR_CODES.PLUGIN_CRASHED, "plugin transport closed")) {
    if (this.closed) return;
    this.closed = true;
    const error = toPluginError(reason, ERROR_CODES.PLUGIN_CRASHED);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  async handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger?.warn("Ignored malformed JSON-RPC message");
      return;
    }
    if ("method" in message && typeof message.method === "string") {
      const handler = this.handlers.get(message.method);
      if (!handler) {
        if (message.id !== void 0) this.writeError(message.id, { code: -32601, message: `method not found: ${message.method}` });
        return;
      }
      try {
        const result = await handler(message.params, message);
        if (message.id !== void 0) this.write({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        if (message.id !== void 0) {
          const pluginError = toPluginError(error);
          this.writeError(message.id, { code: pluginError.code, message: pluginError.message, data: pluginError.data });
        }
      }
      return;
    }
    if (!("id" in message) || typeof message.id !== "number") return;
    const response = message;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new PluginError(String(response.error.code), response.error.message, response.error.data));
    } else {
      pending.resolve(response.result);
    }
  }
  writeError(id, error) {
    this.write({ jsonrpc: "2.0", id, error });
  }
  write(message) {
    if (this.closed && "id" in message) return;
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      throw new PluginError("message_too_large", "JSON-RPC message exceeds the maximum size");
    }
    this.output.write(`${line}
`);
  }
};

// manifest.json
var manifest_default = {
  id: "hasselblad-3fr",
  version: "0.1.0",
  coreApiVersion: "1",
  name: "Hasselblad 3FR embedded preview",
  description: "Extracts contiguous embedded JPEG previews; not a RAW developer.",
  runtime: { type: "node", version: "node22", entry: "dist/main.mjs" },
  platforms: ["windows-amd64", "darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"],
  contributions: [{ domain: "image-preview", apiVersion: "1", capabilities: ["preview"] }],
  capabilities: ["image-preview"],
  permissions: []
};

// src/preview.mjs
var LIMITS = Object.freeze({
  chunk: 256 * 1024,
  preview: 32 * 1024 * 1024,
  scan: 64 * 1024 * 1024,
  read: 128 * 1024 * 1024,
  calls: 4096,
  pixels: 8e7,
  directories: 128,
  depth: 16,
  entries: 1024,
  candidates: 512,
  markers: 65536
});
var integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
var InvalidJPEG = class extends Error {
};
var invalid = () => {
  throw new InvalidJPEG("Invalid JPEG");
};
function validateRequest(p) {
  if (!p || p.extension !== ".3fr" || !p.input || typeof p.input.id !== "string" || !p.input.id.length || p.input.id.length > 256 || !integer(p.input.size, 8, Number.MAX_SAFE_INTEGER) || !integer(p.maxPreviewBytes, 4, LIMITS.preview) || !integer(p.maxPixels, 1, LIMITS.pixels)) {
    throw new Error("Invalid 3FR preview request or limits");
  }
}
function boundedReader(size, rawRead, budget = LIMITS.read) {
  let bytes = 0, calls = 0;
  return async (offset, length) => {
    if (!integer(offset, 0, size) || !integer(length, 0, LIMITS.chunk) || length > size - offset) throw new Error("Invalid read range");
    if (++calls > LIMITS.calls || length > budget - bytes) throw new Error("Read budget exceeded");
    bytes += length;
    const data = await rawRead(offset, length);
    if (!(data instanceof Uint8Array) || data.length !== length) throw new Error("Short or invalid transfer read");
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  };
}
async function jpeg(read, start, size, maxBytes, maxPixels) {
  const end = start + Math.min(size - start, maxBytes);
  let pos = start, base = -1, block = Buffer.alloc(0), width = 0, height = 0, scans = 0, entropy = false;
  const fill = async () => {
    if (pos >= end) invalid();
    if (pos < base || pos >= base + block.length) {
      base = pos;
      block = await read(pos, Math.min(64 * 1024, end - pos));
    }
  };
  const byte = async () => {
    await fill();
    return block[pos++ - base];
  };
  const word = async () => await byte() * 256 + await byte();
  if (await word() !== 65496) invalid();
  for (let count = 0; count < LIMITS.markers; ) {
    if (entropy) {
      for (; ; ) {
        await fill();
        const at = block.indexOf(255, pos - base);
        if (at >= 0) {
          pos = base + at;
          break;
        }
        pos = base + block.length;
      }
    }
    if (await byte() !== 255) invalid();
    let marker = await byte(), fills = 0;
    while (marker === 255) {
      if (++fills > 65536) invalid();
      marker = await byte();
    }
    if (entropy && (marker === 0 || marker >= 208 && marker <= 215)) continue;
    count++;
    entropy = false;
    if (marker === 217) {
      if (!width || !scans) invalid();
      return { mimeType: "image/jpeg", offset: start, length: pos - start, width, height };
    }
    if (marker === 0 || marker === 216 || marker === 1 || marker >= 208 && marker <= 215) invalid();
    const length = await word(), payload = pos;
    if (length < 2 || length - 2 > end - pos) invalid();
    if ([192, 193, 194].includes(marker)) {
      if (width || length < 11 || await byte() !== 8) invalid();
      height = await word();
      width = await word();
      const components = await byte();
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components || !width || !height || width * height > maxPixels) invalid();
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) invalid();
    if (marker === 218) {
      if (!width || length < 8) invalid();
      const components = await byte();
      if (components < 1 || components > 4 || length !== 6 + components * 2) invalid();
      entropy = true;
      scans++;
    }
    pos = payload + length - 2;
  }
  invalid();
}
async function extractPreview(params, rawRead, options = {}) {
  validateRequest(params);
  const { input, maxPreviewBytes, maxPixels } = params;
  const read = boundedReader(input.size, rawRead, options.readBudget ?? LIMITS.read);
  const header = await read(0, 8), order = header.toString("ascii", 0, 2);
  if (order !== "II" && order !== "MM") throw new Error("Not classic TIFF 3FR");
  const u16 = (b, p) => order === "II" ? b.readUInt16LE(p) : b.readUInt16BE(p);
  const u32 = (b, p) => order === "II" ? b.readUInt32LE(p) : b.readUInt32BE(p);
  if (u16(header, 2) !== 42) throw new Error("Not classic TIFF 3FR");
  let best = null;
  const candidates = /* @__PURE__ */ new Set(), probed = /* @__PURE__ */ new Set(), visited = /* @__PURE__ */ new Set(), pending = [[u32(header, 4), 0]];
  const consider = async (offset) => {
    if (!integer(offset, 8, input.size - 4) || probed.has(offset)) return;
    if (probed.size >= LIMITS.calls) throw new Error("Read budget exceeded");
    probed.add(offset);
    const probe = await read(offset, 3);
    if (probe[0] !== 255 || probe[1] !== 216 || probe[2] !== 255) return;
    if (candidates.size >= LIMITS.candidates) throw new Error("Candidate budget exceeded");
    candidates.add(offset);
    try {
      const found = await jpeg(read, offset, input.size, maxPreviewBytes, maxPixels);
      if (!best || found.width * found.height > best.width * best.height) best = found;
    } catch (error) {
      if (!(error instanceof InvalidJPEG)) throw error;
    }
  };
  while (pending.length && visited.size < LIMITS.directories) {
    const [offset, depth] = pending.shift();
    if (depth > LIMITS.depth || offset < 8 || offset > input.size - 2 || visited.has(offset)) continue;
    visited.add(offset);
    const count = u16(await read(offset, 2), 0), length = count * 12 + 4;
    if (count > LIMITS.entries || length > input.size - offset - 2) continue;
    const table = await read(offset + 2, length);
    const enqueue = (value) => {
      if (pending.length < LIMITS.directories * 2) pending.push([value, depth + 1]);
    };
    enqueue(u32(table, count * 12));
    for (let i = 0; i < count; i++) {
      const p = i * 12, tag = u16(table, p), type = u16(table, p + 2), n = u32(table, p + 4);
      const pointer = [330, 34665, 34853].includes(tag), preview = [273, 324, 513].includes(tag);
      if (!pointer && !preview || ![1, 3, 4, 13].includes(type) || !n) continue;
      const unit = type === 1 ? 1 : type === 3 ? 2 : 4;
      const take = Math.min(n, pointer ? LIMITS.directories : LIMITS.candidates);
      let values = table.subarray(p + 8, p + 12);
      if (n * unit > 4) {
        const at = u32(table, p + 8);
        if (at < 8 || at > input.size || take * unit > input.size - at) continue;
        values = await read(at, take * unit);
      }
      for (let j = 0; j < take; j++) {
        const value = unit === 1 ? values[j] : unit === 2 ? u16(values, j * 2) : u32(values, j * 4);
        if (pointer) enqueue(value);
        else await consider(value);
      }
    }
  }
  if (input.size <= LIMITS.scan) {
    let previous = -1;
    for (let offset = 0; offset < input.size; ) {
      const block = await read(offset, Math.min(LIMITS.chunk, input.size - offset));
      if (previous === 255 && block[0] === 216) await consider(offset - 1);
      for (let at = block.indexOf(Buffer.from([255, 216])); at >= 0; at = block.indexOf(Buffer.from([255, 216]), at + 2)) await consider(offset + at);
      previous = block.at(-1);
      offset += block.length;
    }
  }
  if (!best) throw new Error("No usable contiguous embedded JPEG preview");
  return best;
}

// src/protocol.mjs
var formats = { formats: [{ extensions: [".3fr"], format: "3fr", mimeType: "image/x-hasselblad-3fr" }] };
function registerPreview(transport, manifest) {
  let busy = false;
  transport.on("plugin.getManifest", () => manifest);
  transport.on("initialize", (params) => {
    if (params?.coreApiVersion !== void 0 && params.coreApiVersion !== "1") throw new Error("Unsupported core API version");
    return manifest;
  });
  transport.on("image-preview.getFormats", () => formats);
  transport.on("image-preview.extract", async (params) => {
    validateRequest(params);
    if (busy) throw new Error("Preview extraction already running");
    busy = true;
    try {
      return await extractPreview(params, async (offset, length) => {
        if (length > LIMITS.chunk) throw new Error("Transfer chunk exceeds limit");
        const result = await transport.request("host.transfer.read", {
          transferId: params.input.id,
          offset,
          length
        }, { timeoutMs: 3e4 });
        if (!result || typeof result.data !== "string" || result.data.length !== 4 * Math.ceil(length / 3) || result.offset !== offset || result.next !== offset + length || typeof result.eof !== "boolean") {
          throw new Error("Invalid host transfer response");
        }
        const data = Buffer.from(result.data, "base64");
        if (data.length !== length || data.toString("base64") !== result.data) throw new Error("Invalid transfer base64");
        return data;
      });
    } finally {
      busy = false;
    }
  });
  return transport;
}

// src/main.mjs
registerPreview(new JsonRpcStdioTransport(process.stdin, process.stdout, { maxLineBytes: 512 * 1024 }), manifest_default);
