import { isAbsolute, relative } from 'node:path';

// Returns true only when `target` is `root` itself or genuinely nested under it.
// A plain `relative(root, target).startsWith('..')` check fails open on Windows:
// when `root` and `target` are on different drive letters, `relative` returns an
// absolute path (e.g. 'D:\\evil'), which does not start with '..'. Rejecting
// absolute results as well closes that cross-drive containment bypass.
export function isPathInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel));
}
