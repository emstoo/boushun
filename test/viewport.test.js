import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_VIEWPORT_SCALE,
  MIN_VIEWPORT_SCALE,
  createViewport,
  panViewport,
  viewportToWorld,
  zoomViewportAt,
} from "../src/web/viewport.js";

test("[TOP-15] zoom keeps the world point under the cursor stationary", () => {
  const point = { x: 400, y: 250 };
  const initial = createViewport();
  const worldBefore = viewportToWorld(initial, point);
  const zoomed = zoomViewportAt(initial, point, 2);
  const worldAfter = viewportToWorld(zoomed, point);

  assert.deepEqual(worldAfter, worldBefore);
  assert.deepEqual(zoomed, { x: -400, y: -250, scale: 2 });
});

test("[TOP-15] zoom is bounded and pan changes only the viewport offset", () => {
  const minimum = zoomViewportAt(createViewport(), { x: 0, y: 0 }, 0.001);
  const maximum = zoomViewportAt(createViewport(), { x: 0, y: 0 }, 100);
  assert.equal(minimum.scale, MIN_VIEWPORT_SCALE);
  assert.equal(maximum.scale, MAX_VIEWPORT_SCALE);
  assert.deepEqual(panViewport({ x: 3, y: 4, scale: 2 }, { x: 10, y: -5 }), {
    x: 13,
    y: -1,
    scale: 2,
  });
});
