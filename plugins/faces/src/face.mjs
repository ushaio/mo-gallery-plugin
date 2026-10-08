/**
 * Face detection (YuNet), alignment and embedding (SFace).
 *
 * This module is intentionally free of any `onnxruntime-node` import and of any
 * image-decoding library: it only performs the ported OpenCV maths on raw RGB
 * buffers, so it can be unit tested without the native runtime and without a
 * JPEG decoder. Session management lives in `face-engine.js`.
 *
 * Numeric parity is the whole point here. The geometry below is a line-by-line
 * port of the OpenCV reference implementation (`opencv_zoo` face detection /
 * recognition demos, i.e. `FaceDetectorYNImpl::detect` and
 * `FaceRecognizerSFImpl::alignCrop`); measured against OpenCV 5.0.0 it must
 * reproduce the same boxes and the same 128-d embeddings (cosine > 0.999).
 *
 * Coordinate space: every function that takes an image works in the pixel space
 * of the buffer it was given. Callers that downscale before sending pixels are
 * responsible for mapping results back to source coordinates.
 */
import { ProtocolError } from './errors.mjs';

/** YuNet divisor: the detector input is zero padded to a multiple of this. */
export const YUNET_DIVISOR = 32;
/** Feature-map strides of the YuNet head. */
export const YUNET_STRIDES = [8, 16, 32];
/** Detection score threshold used by the OpenCV demo (`scoreThr`). */
export const FACE_DETECT_SCORE_THRESHOLD = 0.9;
/** Non-maximum-suppression threshold used by the OpenCV demo (`nmsThr`). */
export const FACE_DETECT_NMS_THRESHOLD = 0.3;
/** Upper bound on the number of candidates NMS keeps (`topK`). */
export const FACE_DETECT_TOP_K = 5000;

/** Side of the square aligned face crop fed to SFace. */
export const FACE_ALIGN_SIZE = 112;
/** SFace embedding length. */
export const FACE_EMBEDDING_DIM = 128;
/** Number of facial landmarks produced by YuNet. */
export const FACE_LANDMARK_COUNT = 5;
/** Channels of the RGB buffers exchanged with Go. */
export const FACE_CHANNEL_COUNT = 3;

/**
 * SFace destination landmarks (the canonical 112x112 template).
 * `face_recognize.cpp:81` — index paired with the matching detected landmark,
 * never reordered left/right.
 */
export const FACE_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
/** Template mean hard-coded in `face_recognize.cpp:86`. */
export const FACE_TEMPLATE_MEAN = [56.0262, 71.9008];

/** Largest edge the Go side downscales a photo to before sending pixels. */
export const FACE_MAX_EDGE = 1024;
/** Bytes of the largest accepted RGB buffer (`FACE_MAX_EDGE` square, 3 channels). */
export const FACE_MAX_IMAGE_BYTES = FACE_MAX_EDGE * FACE_MAX_EDGE * FACE_CHANNEL_COUNT;

function fail(message) {
  throw new ProtocolError('DECODE_FAILED', message);
}

/**
 * Validate an RGB image payload as sent over the wire.
 *
 * @param {{width?: unknown, height?: unknown, data?: unknown}} image
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function parseFaceImage(image) {
  if (image === null || typeof image !== 'object' || Array.isArray(image)) {
    fail('image must be an object with width, height and base64 data');
  }
  const width = image.width;
  const height = image.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail('image width and height must be positive integers');
  }
  if (width > FACE_MAX_EDGE || height > FACE_MAX_EDGE) {
    fail(`image exceeds the ${FACE_MAX_EDGE} px limit per edge`);
  }
  if (typeof image.data !== 'string' || image.data.length === 0) {
    fail('image data must be a non-empty base64 string');
  }
  let data;
  try {
    data = Buffer.from(image.data, 'base64');
  } catch (error) {
    throw new ProtocolError('DECODE_FAILED', `image data is not valid base64: ${error.message}`);
  }
  return parseFaceRaster({ width, height, data });
}

/**
 * Validate an already-decoded RGB raster.
 *
 * This is the path the faces@1 transport uses: the host hands the pixels over as a
 * binary frame, so they must never be re-encoded to base64 just to reuse
 * `parseFaceImage`. Both entry points share the same limits and the same error
 * messages, and `parseFaceImage` delegates here so the two cannot drift.
 *
 * @param {{width: unknown, height: unknown, data: unknown}} raster
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function parseFaceRaster(raster) {
  if (raster === null || typeof raster !== 'object' || Array.isArray(raster)) {
    fail('image must be an object with width, height and RGB bytes');
  }
  const width = raster.width;
  const height = raster.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail('image width and height must be positive integers');
  }
  if (width > FACE_MAX_EDGE || height > FACE_MAX_EDGE) {
    fail(`image exceeds the ${FACE_MAX_EDGE} px limit per edge`);
  }
  const data = raster.data;
  if (!(data instanceof Uint8Array)) {
    fail('image data must be a byte buffer');
  }
  const expected = width * height * FACE_CHANNEL_COUNT;
  if (data.length !== expected) {
    fail(`image data is ${data.length} bytes, expected ${expected} for ${width}x${height} RGB`);
  }
  return { width, height, data };
}

/**
 * Plan the padded YuNet input geometry.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [divisor]
 * @returns {{width: number, height: number, paddedWidth: number, paddedHeight: number, divisor: number}}
 */
export function planYunetInput(width, height, divisor = YUNET_DIVISOR) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail('image width and height must be positive integers');
  }
  if (!Number.isInteger(divisor) || divisor <= 0) {
    fail('divisor must be a positive integer');
  }
  return {
    width,
    height,
    divisor,
    paddedWidth: width + ((divisor - (width % divisor)) % divisor),
    paddedHeight: height + ((divisor - (height % divisor)) % divisor),
  };
}

/**
 * Build the YuNet input tensor: zero padded right/bottom to the divisor, then
 * `blobFromImage` defaults on the image — scale 1, no mean, no resize, NCHW
 * float32. The detector is fed **BGR planar** data (OpenCV's default: the
 * buffer is BGR and `swapRB` is false), so the three planes are B, G, R and we
 * have to swap out of the RGB buffer the caller hands us. Verified against
 * OpenCV by byte-comparing the whole blob (see README.md).
 *
 * @param {Uint8Array} rgb
 * @param {number} width
 * @param {number} height
 * @param {{paddedWidth: number, paddedHeight: number}} plan
 * @returns {Float32Array}
 */
export function buildYunetInput(rgb, width, height, plan) {
  const { paddedWidth, paddedHeight } = plan;
  const plane = paddedWidth * paddedHeight;
  const blob = new Float32Array(3 * plane);
  for (let y = 0; y < height; y += 1) {
    let source = y * width * FACE_CHANNEL_COUNT;
    let target = y * paddedWidth;
    for (let x = 0; x < width; x += 1) {
      blob[target] = rgb[source + 2]; // B
      blob[plane + target] = rgb[source + 1]; // G
      blob[2 * plane + target] = rgb[source]; // R
      source += FACE_CHANNEL_COUNT;
      target += 1;
    }
  }
  return blob;
}

/**
 * Build the SFace input tensor: the aligned crop is already RGB and exactly
 * 112x112, so this is a plain interleave → planar conversion of the original
 * 0..255 values (no scaling, no mean subtraction).
 *
 * @param {Uint8Array} aligned
 * @returns {Float32Array}
 */
export function buildSfaceInput(aligned) {
  const plane = FACE_ALIGN_SIZE * FACE_ALIGN_SIZE;
  if (aligned.length !== plane * FACE_CHANNEL_COUNT) {
    fail(`aligned face must be ${FACE_ALIGN_SIZE}x${FACE_ALIGN_SIZE} RGB`);
  }
  const blob = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    blob[i] = aligned[i * FACE_CHANNEL_COUNT];
    blob[plane + i] = aligned[i * FACE_CHANNEL_COUNT + 1];
    blob[2 * plane + i] = aligned[i * FACE_CHANNEL_COUNT + 2];
  }
  return blob;
}

function tensorSize(tensor, label) {
  if (tensor === null || typeof tensor !== 'object' || !Array.isArray(tensor.dims)) {
    throw new ProtocolError('INFER_FAILED', `missing YuNet output ${label}`);
  }
  let size = 1;
  for (const dim of tensor.dims) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new ProtocolError('INFER_FAILED', `YuNet output ${label} has invalid dims`);
    }
    size *= dim;
  }
  return size;
}

function requireTensor(tensors, name, expectedSize) {
  const tensor = tensors[name];
  const size = tensorSize(tensor, name);
  if (size !== expectedSize) {
    throw new ProtocolError(
      'INFER_FAILED',
      `YuNet output ${name} has ${size} values, expected ${expectedSize}`,
    );
  }
  if (!(tensor.data instanceof Float32Array)) {
    throw new ProtocolError('INFER_FAILED', `YuNet output ${name} is not float32`);
  }
  return tensor.data;
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

function intersectionOverUnion(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) {
    return 0;
  }
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/**
 * Greedy non-maximum suppression, matching `cv::dnn::NMSBoxes` with `eta = 1.0`
 * (no adaptive threshold decay) and `top_k` limiting the candidates considered.
 *
 * @param {Array<{score: number}>} candidates sorted or unsorted detections
 * @param {number} nmsThreshold
 * @param {number} topK
 */
export function nonMaxSuppression(candidates, nmsThreshold, topK = FACE_DETECT_TOP_K) {
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.score - a.candidate.score)
    .slice(0, Math.max(0, topK));
  const kept = [];
  const suppressed = new Set();
  for (let i = 0; i < ranked.length; i += 1) {
    if (suppressed.has(i)) {
      continue;
    }
    const current = ranked[i];
    kept.push(current.candidate);
    for (let j = i + 1; j < ranked.length; j += 1) {
      if (suppressed.has(j)) {
        continue;
      }
      if (intersectionOverUnion(current.candidate, ranked[j].candidate) > nmsThreshold) {
        suppressed.add(j);
      }
    }
  }
  return kept;
}

/**
 * Decode the twelve YuNet heads into detections in the coordinates of the
 * (padded) input image.
 *
 * @param {Record<string, {dims: number[], data: Float32Array}>} tensors
 * @param {{paddedWidth: number, paddedHeight: number}} plan
 * @param {{scoreThreshold?: number, nmsThreshold?: number, topK?: number}} [options]
 */
export function decodeYunetOutputs(tensors, plan, options = {}) {
  const scoreThreshold = options.scoreThreshold ?? FACE_DETECT_SCORE_THRESHOLD;
  const nmsThreshold = options.nmsThreshold ?? FACE_DETECT_NMS_THRESHOLD;
  const topK = options.topK ?? FACE_DETECT_TOP_K;
  const candidates = [];
  for (const stride of YUNET_STRIDES) {
    const columns = plan.paddedWidth / stride;
    const rows = plan.paddedHeight / stride;
    if (!Number.isInteger(columns) || !Number.isInteger(rows)) {
      throw new ProtocolError(
        'INFER_FAILED',
        `padded size ${plan.paddedWidth}x${plan.paddedHeight} is not divisible by stride ${stride}`,
      );
    }
    const cells = rows * columns;
    const cls = requireTensor(tensors, `cls_${stride}`, cells);
    const obj = requireTensor(tensors, `obj_${stride}`, cells);
    const bbox = requireTensor(tensors, `bbox_${stride}`, cells * 4);
    const kps = requireTensor(tensors, `kps_${stride}`, cells * FACE_LANDMARK_COUNT * 2);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const cell = row * columns + column;
        const score = Math.sqrt(clampUnit(cls[cell]) * clampUnit(obj[cell]));
        if (score < scoreThreshold) {
          continue;
        }
        const dx = bbox[cell * 4];
        const dy = bbox[cell * 4 + 1];
        const dw = bbox[cell * 4 + 2];
        const dh = bbox[cell * 4 + 3];
        const centerX = (column + dx) * stride;
        const centerY = (row + dy) * stride;
        const width = Math.exp(dw) * stride;
        const height = Math.exp(dh) * stride;
        const landmarks = [];
        for (let point = 0; point < FACE_LANDMARK_COUNT; point += 1) {
          landmarks.push([
            (column + kps[cell * FACE_LANDMARK_COUNT * 2 + point * 2]) * stride,
            (row + kps[cell * FACE_LANDMARK_COUNT * 2 + point * 2 + 1]) * stride,
          ]);
        }
        candidates.push({
          score,
          x: centerX - width / 2,
          y: centerY - height / 2,
          width,
          height,
          landmarks,
        });
      }
    }
  }
  return nonMaxSuppression(candidates, nmsThreshold, topK);
}

/** Matrix product `A (2x2) * B (2x2)`. */
function multiply2x2(a, b) {
  return [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1]],
  ];
}

/** Matrix product `A (2x2) * diag(d) * B (2x2)`. */
function multiplyScaled(a, d, b) {
  const left = [
    [a[0][0] * d[0], a[0][1] * d[1]],
    [a[1][0] * d[0], a[1][1] * d[1]],
  ];
  return multiply2x2(left, b);
}

/**
 * SVD of a real 2x2 matrix via one-sided Jacobi rotations.
 *
 * Returns `{u, s, vt}` with `s[0] >= s[1] >= 0` and `A = u * diag(s) * vt`.
 * Column signs are canonical Up to `u`/`vt` pairs, which is all the similarity
 * transform below needs (it only ever uses `u * diag(d) * vt`).
 */
export function svd2x2(a00, a01, a10, a11) {
  // Columns of the working matrix and of V, stored flat.
  let m0 = a00;
  let m1 = a10;
  let m2 = a01;
  let m3 = a11;
  let v0 = 1;
  let v1 = 0;
  let v2 = 0;
  let v3 = 1;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const alpha = m0 * m0 + m1 * m1;
    const beta = m2 * m2 + m3 * m3;
    const gamma = m0 * m2 + m1 * m3;
    if (gamma === 0) {
      break;
    }
    if (Math.abs(gamma) <= Number.EPSILON * Math.sqrt(alpha * beta)) {
      break;
    }
    const zeta = (beta - alpha) / (2 * gamma);
    const tau = zeta >= 0 ? 1 : -1;
    const t = tau / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
    const cos = 1 / Math.sqrt(1 + t * t);
    const sin = cos * t;
    const n0 = cos * m0 - sin * m2;
    const n1 = cos * m1 - sin * m3;
    const n2 = sin * m0 + cos * m2;
    const n3 = sin * m1 + cos * m3;
    m0 = n0;
    m1 = n1;
    m2 = n2;
    m3 = n3;
    const w0 = cos * v0 - sin * v2;
    const w1 = cos * v1 - sin * v3;
    const w2 = sin * v0 + cos * v2;
    const w3 = sin * v1 + cos * v3;
    v0 = w0;
    v1 = w1;
    v2 = w2;
    v3 = w3;
  }
  let s0 = Math.hypot(m0, m1);
  let s1 = Math.hypot(m2, m3);
  const u = [m0, m1, m2, m3];
  if (s0 !== 0) {
    u[0] = m0 / s0;
    u[1] = m1 / s0;
  }
  if (s1 !== 0) {
    u[2] = m2 / s1;
    u[3] = m3 / s1;
  }
  if (s1 > s0) {
    [s0, s1] = [s1, s0];
    [u[0], u[2]] = [u[2], u[0]];
    [u[1], u[3]] = [u[3], u[1]];
    [v0, v2] = [v2, v0];
    [v1, v3] = [v3, v1];
  }
  return {
    u: [
      [u[0], u[2]],
      [u[1], u[3]],
    ],
    s: [s0, s1],
    vt: [
      [v0, v1],
      [v2, v3],
    ],
  };
}

/**
 * Port of `FaceRecognizerSFImpl::getSimilarityTransformMatrix` (Umeyama):
 * the 2x3 affine matrix that maps the detected landmarks onto the canonical
 * template.
 *
 * @param {Array<[number, number]>} landmarks five points in image pixels
 * @returns {number[]} `[m00, m01, m02, m10, m11, m12]`
 */
export function similarityTransformMatrix(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length !== FACE_LANDMARK_COUNT) {
    fail(`landmarks must contain exactly ${FACE_LANDMARK_COUNT} points`);
  }
  const points = landmarks.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) {
      fail('each landmark must be a [x, y] pair');
    }
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      fail('landmark coordinates must be finite numbers');
    }
    return [x, y];
  });

  let meanX = 0;
  let meanY = 0;
  for (const [x, y] of points) {
    meanX += x;
    meanY += y;
  }
  meanX /= FACE_LANDMARK_COUNT;
  meanY /= FACE_LANDMARK_COUNT;

  const srcDemean = points.map(([x, y]) => [x - meanX, y - meanY]);
  let a00 = 0;
  let a01 = 0;
  let a10 = 0;
  let a11 = 0;
  for (let i = 0; i < FACE_LANDMARK_COUNT; i += 1) {
    const dx = FACE_TEMPLATE[i][0] - FACE_TEMPLATE_MEAN[0];
    const dy = FACE_TEMPLATE[i][1] - FACE_TEMPLATE_MEAN[1];
    a00 += dx * srcDemean[i][0];
    a01 += dx * srcDemean[i][1];
    a10 += dy * srcDemean[i][0];
    a11 += dy * srcDemean[i][1];
  }
  a00 /= FACE_LANDMARK_COUNT;
  a01 /= FACE_LANDMARK_COUNT;
  a10 /= FACE_LANDMARK_COUNT;
  a11 /= FACE_LANDMARK_COUNT;

  const { u, s, vt } = svd2x2(a00, a01, a10, a11);
  const d = [1, 1];
  if (a00 * a11 - a01 * a10 < 0) {
    d[1] = -1;
  }
  const tolerance = Math.max(s[0], s[1]) * 2 * 1.1754943508222875e-38; // FLT_MIN
  let rank = 0;
  if (s[0] > tolerance) {
    rank += 1;
  }
  if (s[1] > tolerance) {
    rank += 1;
  }

  const det = (m) => m[0][0] * m[1][1] - m[0][1] * m[1][0];
  let rotation;
  if (rank === 1) {
    if (det(u) * det(vt) > 0) {
      rotation = multiply2x2(u, vt);
    } else {
      d[1] = -d[1];
      rotation = multiplyScaled(u, d, vt);
      d[1] = -d[1];
    }
  } else {
    rotation = multiplyScaled(u, d, vt);
  }

  let var1 = 0;
  let var2 = 0;
  for (const [x, y] of srcDemean) {
    var1 += x * x;
    var2 += y * y;
  }
  var1 /= FACE_LANDMARK_COUNT;
  var2 /= FACE_LANDMARK_COUNT;
  const scale = (1 / (var1 + var2)) * (s[0] * d[0] + s[1] * d[1]);

  const tx = rotation[0][0] * meanX + rotation[0][1] * meanY;
  const ty = rotation[1][0] * meanX + rotation[1][1] * meanY;
  const m02 = FACE_TEMPLATE_MEAN[0] - scale * tx;
  const m12 = FACE_TEMPLATE_MEAN[1] - scale * ty;
  return [
    rotation[0][0] * scale,
    rotation[0][1] * scale,
    m02,
    rotation[1][0] * scale,
    rotation[1][1] * scale,
    m12,
  ];
}

/** Invert a 2x3 affine matrix, as `cv::invertAffineTransform` does. */
export function invertAffine2x3(m) {
  const [a, b, c, d, e, f] = m;
  const determinant = a * e - b * d;
  if (determinant === 0) {
    fail('similarity transform is not invertible');
  }
  const inverse = 1 / determinant;
  return [
    e * inverse,
    -b * inverse,
    (b * f - c * e) * inverse,
    -d * inverse,
    a * inverse,
    (c * d - a * f) * inverse,
  ];
}

/** One channel of one source pixel; anything outside the image reads as black,
 * which is how OpenCV's `BORDER_CONSTANT` warp treats a term whose source index
 * falls outside the frame. */
function sampleChannel(rgb, width, height, x, y, channel) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return 0;
  }
  return rgb[(y * width + x) * FACE_CHANNEL_COUNT + channel];
}

/**
 * Bilinear sample of an RGB buffer, matching `warpAffine(..., INTER_LINEAR)`
 * with the default zero border: out-of-frame neighbours contribute 0 but keep
 * their weight, so a pixel half outside the frame blends towards black instead
 * of snapping to it or replicating the edge.
 */
function sampleBilinear(rgb, width, height, x, y, out, offset) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const wx = x - x0;
  const wy = y - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  for (let channel = 0; channel < FACE_CHANNEL_COUNT; channel += 1) {
    const top =
      sampleChannel(rgb, width, height, x0, y0, channel) * (1 - wx) +
      sampleChannel(rgb, width, height, x1, y0, channel) * wx;
    const bottom =
      sampleChannel(rgb, width, height, x0, y1, channel) * (1 - wx) +
      sampleChannel(rgb, width, height, x1, y1, channel) * wx;
    out[offset + channel] = Math.round(top * (1 - wy) + bottom * wy);
  }
}

/**
 * Warp the five landmarks onto the canonical 112x112 template and sample the
 * source image, the equivalent of `FaceRecognizerSF::alignCrop` (bilinear
 * interpolation, zero border).
 *
 * @param {Uint8Array} rgb
 * @param {number} width
 * @param {number} height
 * @param {Array<[number, number]>} landmarks
 * @returns {Uint8Array} `FACE_ALIGN_SIZE` square RGB
 */
export function alignFace(rgb, width, height, landmarks) {
  const matrix = similarityTransformMatrix(landmarks);
  const inverse = invertAffine2x3(matrix);
  const size = FACE_ALIGN_SIZE;
  const output = new Uint8Array(size * size * FACE_CHANNEL_COUNT);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = inverse[0] * x + inverse[1] * y + inverse[2];
      const sourceY = inverse[3] * x + inverse[4] * y + inverse[5];
      sampleBilinear(rgb, width, height, sourceX, sourceY, output, (y * size + x) * FACE_CHANNEL_COUNT);
    }
  }
  return output;
}

/** L2-normalize a vector; a zero vector stays zero. */
export function l2Normalize(vector) {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return Float64Array.from(vector);
  }
  return Float64Array.from(vector, (value) => value / norm);
}

/** Cosine similarity of two embeddings (normalizes internally). */
export function cosineSimilarity(a, b) {
  const left = l2Normalize(a);
  const right = l2Normalize(b);
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    sum += left[i] * right[i];
  }
  return sum;
}

/**
 * Map detections from the padded buffer space back to source image pixels.
 * `scale` converts the space the pixels were sent in to the source image space.
 */
export function scaleDetections(detections, scale = 1) {
  if (scale === 1) {
    return detections;
  }
  return detections.map((face) => ({
    ...face,
    x: face.x * scale,
    y: face.y * scale,
    width: face.width * scale,
    height: face.height * scale,
    landmarks: face.landmarks.map(([x, y]) => [x * scale, y * scale]),
  }));
}
