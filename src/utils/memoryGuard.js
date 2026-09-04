// memoryGuard.js — a leak tripwire for WebCodecs VideoFrames.
//
// A VideoFrame holds GPU-backed memory that GC will not reclaim; a handful of
// un-closed frames per segment silently kills the tab ~20s into a render. This
// tracker makes a leak throw immediately, naming the segment, instead.

/**
 * @returns {{
 *   track(frame): any,          // register a frame, returns it for chaining
 *   release(frame): void,       // deregister (call right before frame.close())
 *   openCount(): number,        // frames currently open
 *   peak(): number,             // high-water mark since last resetPeak()
 *   resetPeak(): void,          // set the high-water mark back to openCount()
 *   assertDrained(label?): void // throw if any frame is still open
 * }}
 */
export function createFrameTracker() {
  const open = new Set()
  let peak = 0

  return {
    track(frame) {
      if (frame) {
        open.add(frame)
        if (open.size > peak) peak = open.size
      }
      return frame
    },
    release(frame) {
      open.delete(frame)
    },
    openCount() {
      return open.size
    },
    peak() {
      return peak
    },
    resetPeak() {
      peak = open.size
    },
    assertDrained(label) {
      if (open.size > 0) {
        throw new Error(
          `VideoFrame leak${label != null ? ` at ${label}` : ''}: ${open.size} frame(s) never closed`,
        )
      }
    },
  }
}
