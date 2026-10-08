import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FACE_ALIGN_SIZE,
  FACE_CHANNEL_COUNT,
  FACE_TEMPLATE,
  alignFace,
  buildSfaceInput,
  buildYunetInput,
  cosineSimilarity,
  decodeYunetOutputs,
  l2Normalize,
  nonMaxSuppression,
  parseFaceImage,
  planYunetInput,
  scaleDetections,
  similarityTransformMatrix,
  svd2x2,
} from '../src/face.mjs';

/**
 * These tests pin down the geometry and tensor-layout conventions of the
 * OpenCV port. The end-to-end agreement with `cv2` is checked separately by
 * `docs`-referenced parity fixtures; what is locked here is everything that
 * would silently keep working while producing slightly different numbers.
 */

function base64(bytes) {
  return Buffer.from(Uint8Array.from(bytes)).toString('base64');
}

function solidImage(width, height, [r, g, b]) {
  const data = new Uint8Array(width * height * FACE_CHANNEL_COUNT);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  }
  return data;
}

/** One synthetic YuNet output set: only the stride 8 anchor is populated. */
function syntheticHeads(paddedWidth, paddedHeight, anchors) {
  const heads = {};
  for (const stride of [8, 16, 32]) {
    const cells = (paddedWidth / stride) * (paddedHeight / stride);
    heads[`cls_${stride}`] = { dims: [1, cells, 1], data: new Float32Array(cells) };
    heads[`obj_${stride}`] = { dims: [1, cells, 1], data: new Float32Array(cells) };
    heads[`bbox_${stride}`] = { dims: [1, cells, 4], data: new Float32Array(cells * 4) };
    heads[`kps_${stride}`] = { dims: [1, cells, 10], data: new Float32Array(cells * 10) };
  }
  for (const anchor of anchors) {
    const cell = anchor.cell;
    heads.cls_8.data[cell] = anchor.cls;
    heads.obj_8.data[cell] = anchor.obj;
    heads.bbox_8.data.set(anchor.bbox ?? [0, 0, 0, 0], cell * 4);
    heads.kps_8.data.set(anchor.kps ?? new Array(10).fill(0), cell * 10);
  }
  return heads;
}

test('parseFaceImage 校验尺寸、体积与 base64 负载', () => {
  const rgb = solidImage(2, 2, [1, 2, 3]);
  const parsed = parseFaceImage({ width: 2, height: 2, data: base64(rgb) });
  assert.equal(parsed.width, 2);
  assert.equal(parsed.height, 2);
  assert.deepEqual(Array.from(parsed.data), Array.from(rgb));

  assert.throws(() => parseFaceImage(null), /image must be an object/);
  assert.throws(() => parseFaceImage({ width: 0, height: 2, data: base64(rgb) }), /positive integers/);
  assert.throws(() => parseFaceImage({ width: 2.5, height: 2, data: base64(rgb) }), /positive integers/);
  assert.throws(() => parseFaceImage({ width: 2, height: 2, data: '' }), /non-empty base64/);
  // 每边最多 1024 px：这是 Go 侧送像素前的约定，越界说明调用方漏了缩放。
  assert.throws(() => parseFaceImage({ width: 1025, height: 8, data: base64(rgb) }), /1024 px limit/);
  // 字节数必须刚好等于 width * height * 3，短一个字节就拒绝，不补齐。
  assert.throws(() => parseFaceImage({ width: 2, height: 2, data: base64(rgb.subarray(0, 11)) }), /expected 12 for 2x2/);
});

test('planYunetInput 只向右下补齐到 32 的倍数', () => {
  assert.deepEqual(planYunetInput(320, 240), {
    width: 320,
    height: 240,
    divisor: 32,
    paddedWidth: 320,
    paddedHeight: 256,
  });
  assert.deepEqual(planYunetInput(1024, 601), {
    width: 1024,
    height: 601,
    divisor: 32,
    paddedWidth: 1024,
    paddedHeight: 608,
  });
  assert.throws(() => planYunetInput(0, 10), /positive integers/);
  assert.throws(() => planYunetInput(10, 10, 0), /positive integer/);
});

test('buildYunetInput 产出 BGR 平面（OpenCV blobFromImage 默认不换通道）且补零', () => {
  // 两个像素，通道值互不相同，任何通道错位都会被抓到。
  const rgb = Uint8Array.from([10, 20, 30, 40, 50, 60]);
  const plan = { width: 2, height: 1, divisor: 32, paddedWidth: 32, paddedHeight: 32 };
  const blob = buildYunetInput(rgb, 2, 1, plan);
  const plane = 32 * 32;
  assert.equal(blob.length, plane * 3);
  // plane 0 = B，plane 1 = G，plane 2 = R。
  assert.deepEqual([blob[0], blob[1]], [30, 60]);
  assert.deepEqual([blob[plane], blob[plane + 1]], [20, 50]);
  assert.deepEqual([blob[2 * plane], blob[2 * plane + 1]], [10, 40]);
  // 右侧与下方的填充保持 0（三个平面都要）。
  for (const offset of [2, 3, 31, plane + 2, 2 * plane + 2]) {
    assert.equal(blob[offset], 0);
  }
  // 第二行整行是补零：图像只有 1 行高。
  for (const offset of [32, plane + 32, 2 * plane + 32]) {
    assert.equal(blob[offset], 0);
  }
});

test('buildSfaceInput 保持 RGB 平面顺序（SFace 的 swapRB 已由 BGR 源抵消）', () => {
  const aligned = solidImage(FACE_ALIGN_SIZE, FACE_ALIGN_SIZE, [7, 8, 9]);
  const blob = buildSfaceInput(aligned);
  const plane = FACE_ALIGN_SIZE * FACE_ALIGN_SIZE;
  assert.equal(blob.length, plane * 3);
  assert.deepEqual([blob[0], blob[plane], blob[2 * plane]], [7, 8, 9]);
  assert.deepEqual([blob[plane - 1], blob[2 * plane - 1]], [7, 8]);
  assert.throws(() => buildSfaceInput(new Uint8Array(16)), /112x112 RGB/);
});

test('svd2x2 给出降序非负奇异值且 A = u * diag(s) * vt', () => {
  const cases = [
    [3, 0, 0, 1],
    [1, 2, 3, 4],
    [0, 1, 1, 0],
    [2, 2, 2, 2],
    [-5, 1, 2, 3],
  ];
  for (const [a00, a01, a10, a11] of cases) {
    const { u, s, vt } = svd2x2(a00, a01, a10, a11);
    assert.ok(s[0] >= s[1] && s[1] >= 0);
    const rebuilt = [
      u[0][0] * s[0] * vt[0][0] + u[0][1] * s[1] * vt[1][0],
      u[0][0] * s[0] * vt[0][1] + u[0][1] * s[1] * vt[1][1],
      u[1][0] * s[0] * vt[0][0] + u[1][1] * s[1] * vt[1][0],
      u[1][0] * s[0] * vt[0][1] + u[1][1] * s[1] * vt[1][1],
    ];
    for (const [index, expected] of [a00, a01, a10, a11].entries()) {
      assert.ok(Math.abs(rebuilt[index] - expected) < 1e-9, `A[${index}] = ${rebuilt[index]}`);
    }
  }
});

test('similarityTransformMatrix 把源五官点精确映到模板', () => {
  const angle = Math.PI / 6;
  const scale = 1.5;
  const shift = [10, -5];
  const mean = [
    FACE_TEMPLATE.reduce((sum, point) => sum + point[0], 0) / FACE_TEMPLATE.length,
    FACE_TEMPLATE.reduce((sum, point) => sum + point[1], 0) / FACE_TEMPLATE.length,
  ];
  const landmarks = FACE_TEMPLATE.map(([x, y]) => {
    const dx = (x - mean[0]) * scale;
    const dy = (y - mean[1]) * scale;
    return [
      Math.cos(angle) * dx - Math.sin(angle) * dy + mean[0] + shift[0],
      Math.sin(angle) * dx + Math.cos(angle) * dy + mean[1] + shift[1],
    ];
  });
  const m = similarityTransformMatrix(landmarks);
  // 容差放宽到 1e-4：模板均值按 C++ 原样取的是四舍五入后的 56.0262/71.9008，
  // 与真实五点均值差 ~2e-5，误差按同一个比例放大到每个点上。
  for (const [index, [tx, ty]] of FACE_TEMPLATE.entries()) {
    const [x, y] = landmarks[index];
    assert.ok(Math.abs(m[0] * x + m[1] * y + m[2] - tx) < 1e-4, `point ${index} x`);
    assert.ok(Math.abs(m[3] * x + m[4] * y + m[5] - ty) < 1e-4, `point ${index} y`);
  }
  // 相似变换的行列式为正（scale^2），不能退化成反射。
  assert.ok(m[0] * m[4] - m[1] * m[3] > 0);
});

test('alignFace 在画面外按黑色参与插值，而不是整像素判黑', () => {
  // 五官点等于模板整体平移 -0.5，于是逆映射是 src = dst - 0.5：输出第 0 行
  // 与第 0 列都恰好落在画面外半个像素处，正好卡在边界语义上。
  const landmarks = FACE_TEMPLATE.map(([x, y]) => [x - 0.5, y - 0.5]);
  const rgb = solidImage(FACE_ALIGN_SIZE, FACE_ALIGN_SIZE, [255, 255, 255]);
  const aligned = alignFace(rgb, FACE_ALIGN_SIZE, FACE_ALIGN_SIZE, landmarks);
  const pixel = (x, y) => aligned[(y * FACE_ALIGN_SIZE + x) * FACE_CHANNEL_COUNT];
  // 四分之一、二分之一、全权重的黑色混合：64 / 128 / 255（允许 ±1 的定点舍入）。
  assert.ok(Math.abs(pixel(0, 0) - 64) <= 1, `corner = ${pixel(0, 0)}`);
  assert.ok(Math.abs(pixel(1, 0) - 128) <= 1, `top edge = ${pixel(1, 0)}`);
  assert.ok(Math.abs(pixel(0, 1) - 128) <= 1, `left edge = ${pixel(0, 1)}`);
  assert.equal(pixel(1, 1), 255);
  assert.equal(pixel(40, 40), 255);
});

test('alignFace 在五官点完全在画面外时输出全黑', () => {
  const landmarks = FACE_TEMPLATE.map(([x, y]) => [x - 2000, y - 2000]);
  const rgb = solidImage(64, 64, [255, 255, 255]);
  const aligned = alignFace(rgb, 64, 64, landmarks);
  assert.equal(aligned.length, FACE_ALIGN_SIZE * FACE_ALIGN_SIZE * FACE_CHANNEL_COUNT);
  assert.ok(aligned.every((value) => value === 0));
});

test('decodeYunetOutputs 按 stride 还原框与五官点，并套用分数阈值', () => {
  const plan = planYunetInput(32, 32);
  const heads = syntheticHeads(32, 32, [
    { cell: 0, cls: 0.95, obj: 0.95, kps: [0.5, 0.25, 0, 0, 0, 0, 0, 0, 0, 0] },
    { cell: 5, cls: 0.2, obj: 0.9 },
  ]);
  const faces = decodeYunetOutputs(heads, plan);
  assert.equal(faces.length, 1);
  // score = sqrt(clamp(cls) * clamp(obj))；张量是 float32，比较留出单精度误差。
  assert.ok(Math.abs(faces[0].score - 0.95) < 1e-6);
  // 第 0 行第 0 列：中心 (0,0)，边长 stride。
  assert.equal(faces[0].x, -4);
  assert.equal(faces[0].y, -4);
  assert.equal(faces[0].width, 8);
  assert.equal(faces[0].height, 8);
  // 五官点是 (column + raw) * stride。
  assert.deepEqual(faces[0].landmarks[0], [4, 2]);
  assert.deepEqual(faces[0].landmarks[4], [0, 0]);

  // 阈值是可配的，且「恰好等于阈值」保留（严格小于才丢）。
  const boundary = syntheticHeads(32, 32, [{ cell: 0, cls: 0.9, obj: 0.9 }]);
  const [only] = decodeYunetOutputs(boundary, plan, { scoreThreshold: 0 });
  assert.equal(decodeYunetOutputs(boundary, plan, { scoreThreshold: only.score }).length, 1);
  assert.equal(decodeYunetOutputs(boundary, plan, { scoreThreshold: only.score + 1e-9 }).length, 0);
});

test('decodeYunetOutputs 夹取越界的 cls/obj，并按需读取其他 stride', () => {
  const plan = planYunetInput(32, 32);
  const heads = syntheticHeads(32, 32, [{ cell: 0, cls: 4, obj: -2 }]);
  // clamp(4) = 1，clamp(-2) = 0 → 分数 0，默认阈值下不产生候选。
  assert.deepEqual(decodeYunetOutputs(heads, plan), []);

  const heads2 = syntheticHeads(32, 32, [{ cell: 0, cls: 5, obj: 3 }]);
  const faces = decodeYunetOutputs(heads2, plan);
  assert.equal(faces.length, 1);
  assert.equal(faces[0].score, 1);

  const heads3 = syntheticHeads(32, 32, []);
  heads3.cls_16 = { dims: [1, 3, 1], data: new Float32Array(3) };
  assert.throws(() => decodeYunetOutputs(heads3, plan), /cls_16 has 3 values, expected 4/);
  const heads4 = syntheticHeads(32, 32, []);
  heads4.bbox_8 = { dims: [1, 16, 4], data: new Float64Array(64) };
  assert.throws(() => decodeYunetOutputs(heads4, plan), /bbox_8 is not float32/);
  const heads5 = syntheticHeads(32, 32, []);
  delete heads5.kps_32;
  assert.throws(() => decodeYunetOutputs(heads5, plan), /missing YuNet output kps_32/);
});

test('nonMaxSuppression 抑制重叠框并在 topK 处截断', () => {
  const candidates = [
    { score: 0.9, x: 0, y: 0, width: 10, height: 10 },
    { score: 0.8, x: 1, y: 1, width: 10, height: 10 },
    { score: 0.7, x: 50, y: 50, width: 10, height: 10 },
  ];
  const kept = nonMaxSuppression(candidates, 0.3, 5000);
  assert.deepEqual(
    kept.map((face) => face.score),
    [0.9, 0.7],
  );
  // 输入顺序不影响结果，分数高者优先。
  const shuffled = nonMaxSuppression([candidates[2], candidates[0], candidates[1]], 0.3, 5000);
  assert.deepEqual(
    shuffled.map((face) => face.score),
    [0.9, 0.7],
  );
  assert.equal(nonMaxSuppression(candidates, 0.3, 1).length, 1);
});

test('l2Normalize / cosineSimilarity 归一化后点积等价', () => {
  const normalized = l2Normalize([3, 4]);
  assert.ok(Math.abs(normalized[0] - 0.6) < 1e-12);
  assert.ok(Math.abs(normalized[1] - 0.8) < 1e-12);
  assert.deepEqual(Array.from(l2Normalize([0, 0])), [0, 0]);
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [1, -1])) < 1e-12);
});

test('scaleDetections 把填充缓冲坐标映射回源图坐标', () => {
  const faces = [
    { score: 0.5, x: 1, y: 2, width: 3, height: 4, landmarks: [[5, 6]] },
  ];
  assert.equal(scaleDetections(faces, 1), faces);
  // 0.5 表示送检像素是源图的一半大，坐标要乘回去。
  const scaled = scaleDetections(faces, 2);
  assert.deepEqual(
    [scaled[0].x, scaled[0].y, scaled[0].width, scaled[0].height],
    [2, 4, 6, 8],
  );
  assert.deepEqual(scaled[0].landmarks, [[10, 12]]);
  // 原数组不被就地修改：缩放结果只用于返回给调用方。
  assert.deepEqual(faces[0].landmarks, [[5, 6]]);
});
