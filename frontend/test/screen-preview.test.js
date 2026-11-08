import { describe, expect, it } from 'vitest';
import { buildPreviewLayout, getPreviewFrameStyle, previewUrl } from '../src/utils/screen-preview.js';

const matrix = { rows: 3, cols: 4 };

describe('screen preview layout', () => {
  it('preserves merged screen rectangles and legacy bounding rectangle assignments', () => {
    const cameras = [
      { id: 'merged', display_region: { row: 1, col: 2, row_span: 2, col_span: 2 }, display_targets: [1] },
      { id: 'legacy', display_targets: [9, 12] },
    ];
    const layout = buildPreviewLayout(cameras, matrix);

    expect(layout.regions).toEqual([
      { camera: cameras[0], region: { row: 1, col: 2, row_span: 2, col_span: 2, targets: [2, 3, 6, 7] } },
      { camera: cameras[1], region: { row: 3, col: 1, row_span: 1, col_span: 4, targets: [9, 10, 11, 12] } },
    ]);
    expect(layout.occupiedTargets).toEqual(new Set([2, 3, 6, 7, 9, 10, 11, 12]));
    expect(layout.conflictTargets).toEqual([]);
    expect(layout.unassignedCount).toBe(0);
  });

  it('counts occupied cells once and sorts conflicts even when three sources overlap', () => {
    const layout = buildPreviewLayout([
      { display_targets: [10, 11] },
      { display_targets: [2, 10] },
      { display_targets: [2, 10] },
      { display_targets: [] },
      {},
    ], matrix);

    expect(layout.occupiedTargets).toEqual(new Set([2, 6, 10, 11]));
    expect(matrix.rows * matrix.cols - layout.occupiedTargets.size).toBe(8);
    expect(layout.conflictTargets).toEqual([2, 6, 10]);
    expect(layout.unassignedCount).toBe(2);
  });

  it('ignores invalid regions and targets and retains valid legacy fallbacks', () => {
    const layout = buildPreviewLayout([
      { display_region: { row: 5, col: 1 }, display_targets: [4] },
      { display_region: { row: 1, col: 1, row_span: 0 }, display_targets: [0, -1, 13, NaN, Infinity, 1.5] },
      { display_region: { row: NaN, col: 1 }, display_targets: '1' },
      { display_region: { row: 1, col: Infinity } },
      { display_targets: [1, 13] },
      null,
    ], matrix);

    expect(layout.regions.map(({ region }) => region.targets)).toEqual([[4], [1]]);
    expect(layout.unassignedCount).toBe(4);
    expect(layout.conflictTargets).toEqual([]);
  });

  it('handles an empty camera list and an unavailable or invalid matrix', () => {
    const empty = { regions: [], occupiedTargets: new Set(), conflictTargets: [], unassignedCount: 0 };
    expect(buildPreviewLayout(undefined, matrix)).toEqual(empty);
    expect(buildPreviewLayout([], matrix)).toEqual(empty);
    for (const invalidMatrix of [null, { rows: 0, cols: 4 }, { rows: 2, cols: Infinity }]) {
      expect(buildPreviewLayout([{}], invalidMatrix)).toEqual({ ...empty, unassignedCount: 1 });
    }
  });
});

describe('screen preview frame geometry', () => {
  const camera = { width: 1600, height: 900 };

  it('retains the source viewport and centers a contained page with letterboxing', () => {
    expect(getPreviewFrameStyle(camera, 800, 600)).toEqual({
      width: '1600px',
      height: '900px',
      left: '0px',
      top: '75px',
      transform: 'scale(0.5, 0.5)',
      transformOrigin: 'top left',
    });
    const tallPage = getPreviewFrameStyle({ width: 900, height: 1600 }, 600, 800);
    expect(tallPage.left).toBe('75px');
    expect(tallPage.top).toBe('0px');
    expect(tallPage.transform).toBe('scale(0.5, 0.5)');
  });

  it('centers and crops a covered page without changing its aspect ratio', () => {
    const style = getPreviewFrameStyle(camera, 800, 600, 'cover');
    expect(style.width).toBe('1600px');
    expect(style.height).toBe('900px');
    expect(parseFloat(style.left)).toBeCloseTo(-133.3333333333);
    expect(parseFloat(style.top)).toBe(0);
    expect(style.transform).toBe(`scale(${2 / 3}, ${2 / 3})`);
  });

  it('stretches each axis to fill the target when requested', () => {
    const style = getPreviewFrameStyle(camera, 800, 600, 'stretch');
    expect(style.left).toBe('0px');
    expect(style.top).toBe('0px');
    expect(style.transform).toBe(`scale(0.5, ${2 / 3})`);
  });

  it('accepts numeric dimensions and falls back safely for invalid source sizes or modes', () => {
    expect(getPreviewFrameStyle({ width: '1600', height: '900' }, 800, 600))
      .toEqual(getPreviewFrameStyle(camera, 800, 600));
    for (const source of [undefined, {}, { width: 0, height: -10 }, { width: NaN, height: Infinity }]) {
      const style = getPreviewFrameStyle(source, 640, 360, 'unknown');
      expect(style.width).toBe('1280px');
      expect(style.height).toBe('720px');
      expect(style.transform).toBe('scale(0.5, 0.5)');
    }
  });

  it('keeps every style finite while the preview has no measured size', () => {
    for (const fit of ['contain', 'cover', 'stretch']) {
      for (const dimensions of [[0, 0], [0, 600], [800, 0], [-1, NaN], [Infinity, undefined]]) {
        const style = getPreviewFrameStyle(camera, ...dimensions, fit);
        expect(Object.values(style).join(' ')).not.toMatch(/NaN|Infinity/);
      }
    }
    expect(getPreviewFrameStyle(camera, 0, 0).transform).toBe('scale(0, 0)');
  });
});

describe('screen preview URL validation', () => {
  it('accepts absolute HTTP and HTTPS URLs and preserves query strings and fragments', () => {
    expect(previewUrl(' https://example.com/dashboard?theme=dark#overview '))
      .toBe('https://example.com/dashboard?theme=dark#overview');
    expect(previewUrl('http://localhost:8080')).toBe('http://localhost:8080/');
  });

  it('rejects missing, malformed, relative, and executable URLs', () => {
    for (const value of [undefined, null, 123, '', ' ', '/dashboard', '//example.com', 'http://', 'not a URL', 'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', 'ftp://example.com']) {
      expect(previewUrl(value)).toBe('');
    }
  });
});
