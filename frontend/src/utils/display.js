export function displayTargetLabel(index, prefix = '屏') {
  return `${prefix}${String(index).padStart(2, '0')}`;
}

export function displayTargetMeta(index, cols) {
  const { row, col } = rowColFromIndex(index, cols);
  return `${row}行${col}列`;
}

export function indexFromRowCol(row, col, cols) {
  return (row - 1) * cols + col;
}

export function rowColFromIndex(index, cols) {
  return {
    row: Math.floor((index - 1) / cols) + 1,
    col: ((index - 1) % cols) + 1,
  };
}

export function createDisplayRegion(row, col, rowSpan, colSpan, matrix) {
  if (
    row < 1 ||
    col < 1 ||
    rowSpan < 1 ||
    colSpan < 1 ||
    row + rowSpan - 1 > matrix.rows ||
    col + colSpan - 1 > matrix.cols
  ) {
    return null;
  }

  const targets = [];

  for (let r = row; r < row + rowSpan; r += 1) {
    for (let c = col; c < col + colSpan; c += 1) {
      targets.push(indexFromRowCol(r, c, matrix.cols));
    }
  }

  return {
    row,
    col,
    row_span: rowSpan,
    col_span: colSpan,
    targets,
  };
}

export function createRegionFromCells(start, end, matrix) {
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.col, end.col);
  const maxCol = Math.max(start.col, end.col);

  return createDisplayRegion(minRow, minCol, maxRow - minRow + 1, maxCol - minCol + 1, matrix);
}

export function normalizeCameraRegion(camera, matrix) {
  if (camera.display_region) {
    const region = createDisplayRegion(
      camera.display_region.row,
      camera.display_region.col,
      camera.display_region.row_span || 1,
      camera.display_region.col_span || 1,
      matrix,
    );

    if (region) {
      return region;
    }
  }

  const targets = camera.display_targets || [];
  if (targets.length === 0) {
    return null;
  }

  const cells = targets.map((target) => rowColFromIndex(target, matrix.cols));
  const minRow = Math.min(...cells.map((cell) => cell.row));
  const maxRow = Math.max(...cells.map((cell) => cell.row));
  const minCol = Math.min(...cells.map((cell) => cell.col));
  const maxCol = Math.max(...cells.map((cell) => cell.col));

  return createDisplayRegion(minRow, minCol, maxRow - minRow + 1, maxCol - minCol + 1, matrix)
    || createDisplayRegion(cells[0].row, cells[0].col, 1, 1, matrix);
}

export function regionSummary(region, matrix) {
  if (!region) {
    return '未框选';
  }

  const start = displayTargetLabel(indexFromRowCol(region.row, region.col, matrix.cols), matrix.prefix);
  const end = displayTargetLabel(
    indexFromRowCol(region.row + region.row_span - 1, region.col + region.col_span - 1, matrix.cols),
    matrix.prefix,
  );

  return region.targets.length === 1
    ? start
    : `${start} - ${end} · ${region.col_span}列x${region.row_span}行`;
}

export function regionTargetLabels(region, matrix, limit = 16) {
  if (!region) {
    return [];
  }

  const labels = region.targets.map((target) => displayTargetLabel(target, matrix.prefix));
  return labels.length <= limit ? labels : [...labels.slice(0, limit), `+${labels.length - limit}`];
}

export function targetSummary(camera, matrix) {
  const region = normalizeCameraRegion(camera, matrix);

  if (!region) {
    return '未绑定';
  }

  const label = displayTargetLabel(indexFromRowCol(region.row, region.col, matrix.cols), matrix.prefix);
  return region.row_span === 1 && region.col_span === 1
    ? label
    : `${label} · ${region.col_span}列x${region.row_span}行`;
}
