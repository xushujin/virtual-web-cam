import { normalizeCameraRegion } from './display.js';

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validRegion(region, matrix) {
  if (!region) return null;

  const rowSpan = region.row_span ?? 1;
  const colSpan = region.col_span ?? 1;
  if (
    ![region.row, region.col, rowSpan, colSpan].every(isPositiveInteger)
    || region.row + rowSpan - 1 > matrix.rows
    || region.col + colSpan - 1 > matrix.cols
  ) {
    return null;
  }

  return { row: region.row, col: region.col, row_span: rowSpan, col_span: colSpan };
}

export function buildPreviewLayout(cameras, matrix) {
  const regions = [];
  const occupiedTargets = new Set();
  const conflicts = new Set();
  const items = Array.isArray(cameras) ? cameras : [];
  let unassignedCount = 0;

  if (!matrix || !isPositiveInteger(matrix.rows) || !isPositiveInteger(matrix.cols)) {
    return { regions, occupiedTargets, conflictTargets: [], unassignedCount: items.length };
  }

  for (const camera of items) {
    const targets = Array.isArray(camera?.display_targets)
      ? camera.display_targets.filter((target) => isPositiveInteger(target) && target <= matrix.rows * matrix.cols)
      : [];
    const region = normalizeCameraRegion({
      display_region: validRegion(camera?.display_region, matrix),
      display_targets: targets,
    }, matrix);

    if (!region) {
      unassignedCount += 1;
      continue;
    }

    regions.push({ camera, region });
    for (const target of region.targets) {
      if (occupiedTargets.has(target)) conflicts.add(target);
      occupiedTargets.add(target);
    }
  }

  return {
    regions,
    occupiedTargets,
    conflictTargets: [...conflicts].sort((a, b) => a - b),
    unassignedCount,
  };
}

function positiveDimension(value, fallback) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension >= 1 ? dimension : fallback;
}

function containerDimension(value) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : 0;
}

export function getPreviewFrameStyle(camera, regionWidth, regionHeight, fit = 'contain') {
  const width = positiveDimension(camera?.width, 1280);
  const height = positiveDimension(camera?.height, 720);
  const containerWidth = containerDimension(regionWidth);
  const containerHeight = containerDimension(regionHeight);
  let scaleX = containerWidth / width;
  let scaleY = containerHeight / height;

  if (fit !== 'stretch') {
    const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    scaleX = scale;
    scaleY = scale;
  }

  return {
    width: `${width}px`,
    height: `${height}px`,
    left: `${(containerWidth - width * scaleX) / 2}px`,
    top: `${(containerHeight - height * scaleY) / 2}px`,
    transform: `scale(${scaleX}, ${scaleY})`,
    transformOrigin: 'top left',
  };
}

export function previewUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';

  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
