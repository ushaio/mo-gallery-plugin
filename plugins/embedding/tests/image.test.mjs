/**
 * 图像预处理单测：`resizeRgb8` 与 `patchifyRaster`。
 *
 * 这两处最容易出「不报错的错」：patch 顺序错了、把 (row,col) 写成 (col,row)、多做一次
 * ImageNet 归一化——都能跑出向量，只是质量悄悄变差。所以形状与取值约定必须被测试钉死。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_GRID, patchifyRaster, resizeRgb8 } from '../src/image.mjs'
import { PATCH_ELEMENTS, PATCH_SIZE } from '../src/models.mjs'

/** 生成一张宽高已知、像素值可预测的图。 */
function solid(width, height, [r, g, b]) {
  const data = new Uint8Array(width * height * 3)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 3] = r
    data[index * 3 + 1] = g
    data[index * 3 + 2] = b
  }
  return { width, height, data }
}

test('同尺寸缩放是恒等且不共享内存', () => {
  const source = solid(4, 4, [10, 20, 30])
  const resized = resizeRgb8(source, 4, 4)
  assert.deepEqual(Array.from(resized.data), Array.from(source.data))
  assert.notEqual(resized.data, source.data)
})

test('非 RGB8 输入被拒绝（不允许猜通道数）', () => {
  assert.throws(() => resizeRgb8({ width: 2, height: 2, data: new Uint8Array(8) }, 2, 2), /RGB8/)
})

test('双线性缩放的输出尺寸与通道顺序保持不变', () => {
  const source = solid(8, 8, [200, 100, 50])
  const resized = resizeRgb8(source, 3, 5)
  assert.equal(resized.width, 3)
  assert.equal(resized.height, 5)
  assert.equal(resized.data.length, 3 * 5 * 3)
  // 纯色图缩放后仍是同一个颜色（除四舍五入外）。
  for (let index = 0; index < resized.data.length; index += 3) {
    assert.ok(Math.abs(resized.data[index] - 200) <= 1)
    assert.ok(Math.abs(resized.data[index + 1] - 100) <= 1)
    assert.ok(Math.abs(resized.data[index + 2] - 50) <= 1)
  }
})

test('patchify：默认 50×50 网格的形状契约', () => {
  const patches = patchifyRaster(solid(DEFAULT_GRID * PATCH_SIZE, DEFAULT_GRID * PATCH_SIZE, [255, 128, 0]))
  assert.equal(patches.patchCount, DEFAULT_GRID * DEFAULT_GRID)
  assert.equal(patches.pixelValues.length, patches.patchCount * PATCH_ELEMENTS)
  assert.equal(patches.positionIds.length, patches.patchCount * 2)
  assert.equal(patches.resizedWidth, DEFAULT_GRID * PATCH_SIZE)
  assert.equal(patches.resizedHeight, DEFAULT_GRID * PATCH_SIZE)
})

test('像素按 1/255 缩放且不做归一化（do_normalize=false 是上游口径）', () => {
  // 网格是**调用方的选择**（它决定 soft token 预算），不是从源图尺寸反推的：
  // 所以这里显式要 1×1 网格，否则 16×16 的源图会被上采样到默认 50×50。
  const patches = patchifyRaster(solid(PATCH_SIZE, PATCH_SIZE, [255, 0, 51]), { gridWidth: 1, gridHeight: 1 })
  assert.equal(patches.patchCount, 1)
  assert.ok(Math.abs(patches.pixelValues[0] - 1) < 1e-6)
  assert.equal(patches.pixelValues[1], 0)
  // 51/255 = 0.2：若被误做 ImageNet 归一化，这里会变成负数。
  assert.ok(Math.abs(patches.pixelValues[2] - 0.2) < 1e-6)
})

test('position_ids 是行优先的 (row, col)，且与 patch 顺序一致', () => {
  const gridWidth = 3
  const gridHeight = 2
  const patches = patchifyRaster(solid(gridWidth * PATCH_SIZE, gridHeight * PATCH_SIZE, [1, 2, 3]), {
    gridWidth,
    gridHeight,
  })
  assert.equal(patches.patchCount, 6)
  const positions = []
  for (let index = 0; index < patches.patchCount; index += 1) {
    positions.push([Number(patches.positionIds[index * 2]), Number(patches.positionIds[index * 2 + 1])])
  }
  assert.deepEqual(positions, [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]])
})

test('patch 的内容取自它自己的位置，不是整图重复', () => {
  // 左右两半不同颜色：两个 patch 的首个像素应当不同。
  const width = PATCH_SIZE * 2
  const data = new Uint8Array(width * PATCH_SIZE * 3)
  for (let y = 0; y < PATCH_SIZE; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < PATCH_SIZE ? 255 : 0
      const index = (y * width + x) * 3
      data[index] = value
      data[index + 1] = value
      data[index + 2] = value
    }
  }
  const patches = patchifyRaster({ width, height: PATCH_SIZE, data }, { gridWidth: 2, gridHeight: 1 })
  assert.equal(patches.patchCount, 2)
  assert.ok(Math.abs(patches.pixelValues[0] - 1) < 1e-6, '第一个 patch 应为白')
  assert.equal(patches.pixelValues[PATCH_ELEMENTS], 0, '第二个 patch 应为黑')
})
