/**
 * 图像预处理：把一张 RGB8 栅格变成视觉编码器要的两张输入张量。
 *
 * 视觉编码器（`vision_encoder_q4.onnx`）的输入不是 NCHW 图像，而是**已经切好的 patch 列表**：
 *
 *   pixel_values       FLOAT [num_patches, 768]      每个 patch 是 16×16×3 RGB，展平后 768
 *   pixel_position_ids INT64 [num_patches, 2]        每个 patch 的 (row, col)
 *
 * 也就是说「缩放、切块、拼张量」是**宿主/插件这一侧的职责**，不是模型内部的。设计文档 §2.3 里
 * 「280 soft token ⇒ 输入约 800×800」的推算，正是 `网格边长 × 16` 得到的。
 *
 * ⚠️ 两处**待核对**（设计文档 §5.2 Step 2）：
 *   1. patch 的遍历顺序（此处按行优先）与 `position_ids` 是 (row, col) 还是 (col, row)；
 *   2. 缩放算法（此处双线性）与上游 `resample: 3` 的逐位一致性。
 * 这两处只影响**质量**、不影响能否跑通，所以先用可复现的实现把链路打通，再与参考实现对拍。
 */
import { PATCH_ELEMENTS, PATCH_SIZE } from './models.mjs'

/** 默认网格：50×50 = 2500 patch，实测产出 **273 token**（对齐 280 的 soft token 预算）。 */
export const DEFAULT_GRID = 50

/**
 * 网格下限：**26**。
 *
 * 2026-10-08 实测：16×16（256 patch）会让视觉图内部 `ScatterElements` 直接报
 * `indices element out of data bounds, idx=28 must be within the inclusive range [-28,27]`——
 * 即网格太小时图内部某步张量会越界。所以网格不是可以随便调的旋钮：
 * 降低网格换速度可以，但**下限要挡住**，否则表现是一句难以定位的算子错误。
 *
 * 这条检查落在**喂图的那一层**（`engine.encodeImageFeatures`）而不是 `patchifyRaster`：
 * 它是模型图的约束，不是图像处理的约束，纯函数不该载荷它。
 */
export const MIN_GRID = 26

/**
 * 双线性缩放到目标尺寸。
 *
 * @param {{width: number, height: number, data: Uint8Array}} raster RGB8 交错、无 alpha
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function resizeRgb8(raster, width, height) {
  const { width: sourceWidth, height: sourceHeight, data: source } = raster
  if (!(source instanceof Uint8Array) || source.length !== sourceWidth * sourceHeight * 3) {
    throw new Error('raster must be RGB8 (width * height * 3 bytes)')
  }
  if (width === sourceWidth && height === sourceHeight) {
    return { width, height, data: Uint8Array.from(source) }
  }
  const out = new Uint8Array(width * height * 3)
  // 半像素中心对齐（与 PIL/OpenCV 的默认约定一致），避免整体偏移半格。
  const scaleX = sourceWidth / width
  const scaleY = sourceHeight / height
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.max(0, (y + 0.5) * scaleY - 0.5))
    const y0 = Math.floor(sourceY)
    const y1 = Math.min(sourceHeight - 1, y0 + 1)
    const wy = sourceY - y0
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.max(0, (x + 0.5) * scaleX - 0.5))
      const x0 = Math.floor(sourceX)
      const x1 = Math.min(sourceWidth - 1, x0 + 1)
      const wx = sourceX - x0
      for (let channel = 0; channel < 3; channel += 1) {
        const p00 = source[(y0 * sourceWidth + x0) * 3 + channel]
        const p01 = source[(y0 * sourceWidth + x1) * 3 + channel]
        const p10 = source[(y1 * sourceWidth + x0) * 3 + channel]
        const p11 = source[(y1 * sourceWidth + x1) * 3 + channel]
        const top = p00 + (p01 - p00) * wx
        const bottom = p10 + (p11 - p10) * wx
        out[(y * width + x) * 3 + channel] = Math.round(top + (bottom - top) * wy)
      }
    }
  }
  return { width, height, data: out }
}

/**
 * 栅格 → patch 张量。
 *
 * 像素值按上游口径处理：`do_rescale: true` 且 `rescale_factor = 1/255`，
 * **`do_normalize: false`**（`image_mean = 0` / `image_std = 1`），所以只需除以 255，不要做
 * ImageNet 归一化——多做一次归一化不会报错，只会让质量静默劣化。
 *
 * @param {{width: number, height: number, data: Uint8Array}} raster
 * @param {{ gridWidth?: number, gridHeight?: number }} [options]
 * @returns {{ pixelValues: Float32Array, positionIds: BigInt64Array, patchCount: number,
 *             gridWidth: number, gridHeight: number, resizedWidth: number, resizedHeight: number }}
 */
export function patchifyRaster(raster, { gridWidth = DEFAULT_GRID, gridHeight = DEFAULT_GRID } = {}) {
  const resizedWidth = gridWidth * PATCH_SIZE
  const resizedHeight = gridHeight * PATCH_SIZE
  const resized = resizeRgb8(raster, resizedWidth, resizedHeight)
  const patchCount = gridWidth * gridHeight
  const pixelValues = new Float32Array(patchCount * PATCH_ELEMENTS)
  const positionIds = new BigInt64Array(patchCount * 2)

  let offset = 0
  for (let row = 0; row < gridHeight; row += 1) {
    for (let col = 0; col < gridWidth; col += 1) {
      for (let y = 0; y < PATCH_SIZE; y += 1) {
        const sourceRow = row * PATCH_SIZE + y
        for (let x = 0; x < PATCH_SIZE; x += 1) {
          const sourceIndex = (sourceRow * resizedWidth + col * PATCH_SIZE + x) * 3
          pixelValues[offset] = resized.data[sourceIndex] / 255
          pixelValues[offset + 1] = resized.data[sourceIndex + 1] / 255
          pixelValues[offset + 2] = resized.data[sourceIndex + 2] / 255
          offset += 3
        }
      }
      const patchIndex = row * gridWidth + col
      positionIds[patchIndex * 2] = BigInt(row)
      positionIds[patchIndex * 2 + 1] = BigInt(col)
    }
  }
  return {
    pixelValues,
    positionIds,
    patchCount,
    gridWidth,
    gridHeight,
    resizedWidth,
    resizedHeight,
  }
}
