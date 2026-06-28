export function fitDimensions(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const longEdge = Math.max(w, h);
  if (longEdge <= maxEdge) return { w, h };
  const scale = maxEdge / longEdge;
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}
