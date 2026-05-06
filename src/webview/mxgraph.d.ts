// Minimal ambient type for the `mxgraph` npm package. The module
// exports a single factory function that, when called with a config
// object, returns the populated mxgraph namespace. We type that
// surface loosely — `drawioRenderer` narrows the parts it uses with
// its own typed wrapper interfaces, so an `any` here doesn't leak.
declare module "mxgraph" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: (opts: Record<string, unknown>) => any;
  export default factory;
}
