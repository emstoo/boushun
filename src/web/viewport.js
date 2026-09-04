export const MIN_VIEWPORT_SCALE = 0.35;
export const MAX_VIEWPORT_SCALE = 4;

export function createViewport() {
  return { x: 0, y: 0, scale: 1 };
}

export function zoomViewportAt(viewport, point, multiplier) {
  const oldScale = clamp(viewport.scale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
  const newScale = clamp(oldScale * multiplier, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
  const ratio = newScale / oldScale;

  return {
    scale: newScale,
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio,
  };
}

export function panViewport(viewport, delta) {
  return {
    ...viewport,
    x: viewport.x + delta.x,
    y: viewport.y + delta.y,
  };
}

export function viewportToWorld(viewport, point) {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
