/** Which edges of a horizontally scrolling strip hide more content (drives the edge fades). */
export function stripOverflow(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { left: boolean; right: boolean } {
  // 1px slack: fractional widths (zoom, HiDPI) leave sub-pixel remainders at either end.
  return {
    left: scrollLeft > 1,
    right: scrollLeft + clientWidth < scrollWidth - 1,
  }
}
