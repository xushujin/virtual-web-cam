import { describe, expect, it } from 'vitest';
import {
  createDisplayRegion,
  createRegionFromCells,
  displayTargetLabel,
  displayTargetMeta,
  normalizeCameraRegion,
  regionSummary,
  regionTargetLabels,
  targetSummary,
} from '../src/utils/display.js';

const matrix = {
  rows: 6,
  cols: 8,
  prefix: '屏',
};

describe('display utilities', () => {
  it('formats screen labels and row/column metadata', () => {
    expect(displayTargetLabel(1, matrix.prefix)).toBe('屏01');
    expect(displayTargetLabel(12, matrix.prefix)).toBe('屏12');
    expect(displayTargetMeta(10, matrix.cols)).toBe('2行2列');
  });

  it('creates rectangular display regions within matrix bounds', () => {
    expect(createDisplayRegion(1, 1, 2, 3, matrix)).toEqual({
      row: 1,
      col: 1,
      row_span: 2,
      col_span: 3,
      targets: [1, 2, 3, 9, 10, 11],
    });
    expect(createDisplayRegion(6, 8, 2, 1, matrix)).toBeNull();
  });

  it('creates a region from mouse drag start and end cells', () => {
    expect(createRegionFromCells({ row: 3, col: 4 }, { row: 2, col: 2 }, matrix)).toMatchObject({
      row: 2,
      col: 2,
      row_span: 2,
      col_span: 3,
      targets: [10, 11, 12, 18, 19, 20],
    });
  });

  it('normalizes explicit regions and target-only legacy assignments', () => {
    expect(normalizeCameraRegion({
      display_region: {
        row: 1,
        col: 2,
        row_span: 1,
        col_span: 2,
      },
      display_targets: [2, 3],
    }, matrix)).toMatchObject({
      row: 1,
      col: 2,
      row_span: 1,
      col_span: 2,
      targets: [2, 3],
    });

    expect(normalizeCameraRegion({
      display_targets: [10, 11, 18, 19],
    }, matrix)).toMatchObject({
      row: 2,
      col: 2,
      row_span: 2,
      col_span: 2,
      targets: [10, 11, 18, 19],
    });
  });

  it('summarizes single screen and merged regions', () => {
    const single = createDisplayRegion(2, 5, 1, 1, matrix);
    const merged = createDisplayRegion(1, 1, 2, 3, matrix);

    expect(regionSummary(single, matrix)).toBe('屏13');
    expect(regionSummary(merged, matrix)).toBe('屏01 - 屏11 · 3列x2行');
    expect(targetSummary({ display_targets: [1, 2, 3, 9, 10, 11] }, matrix)).toBe('屏01 · 3列x2行');
    expect(targetSummary({ display_targets: [] }, matrix)).toBe('未绑定');
  });

  it('limits long region target labels', () => {
    const region = createDisplayRegion(1, 1, 3, 8, matrix);
    expect(regionTargetLabels(region, matrix)).toHaveLength(17);
    expect(regionTargetLabels(region, matrix).at(-1)).toBe('+8');
    expect(regionTargetLabels(null, matrix)).toEqual([]);
  });

  it('falls back when explicit region is outside current matrix', () => {
    const camera = {
      display_region: {
        row: 8,
        col: 1,
        row_span: 1,
        col_span: 1,
      },
      display_targets: [5],
    };

    expect(normalizeCameraRegion(camera, matrix)).toMatchObject({
      row: 1,
      col: 5,
      row_span: 1,
      col_span: 1,
      targets: [5],
    });
    expect(regionSummary(null, matrix)).toBe('未框选');
  });
});
