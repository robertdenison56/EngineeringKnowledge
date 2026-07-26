/**
 * d3-force-3d ships no type definitions. It is the dimensional superset of
 * d3-force (same API plus a z axis) that 3d-force-graph uses as its engine;
 * only the primitive we call directly is typed here.
 */
declare module 'd3-force-3d' {
  export function forceCollide<NodeDatum>(
    radius?: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number),
  ): unknown;
}
