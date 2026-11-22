function toLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Computes LCS-matched `(baseIndex, targetIndex)` pairs in ascending order,
 * trimming common prefix/suffix lines first for O(N) performance on small edits.
 */
function lcsMatches(base: string[], target: string[]): Array<[number, number]> {
  const m = base.length;
  const n = target.length;

  let prefix = 0;
  while (prefix < m && prefix < n && base[prefix] === target[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < m - prefix &&
    suffix < n - prefix &&
    base[m - 1 - suffix] === target[n - 1 - suffix]
  ) {
    suffix++;
  }

  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < prefix; i++) {
    pairs.push([i, i]);
  }

  const midM = m - prefix - suffix;
  const midN = n - prefix - suffix;

  if (midM > 0 && midN > 0) {
    const cols = midN + 1;
    const dp = new Int32Array((midM + 1) * cols);

    for (let i = midM - 1; i >= 0; i--) {
      const aLine = base[prefix + i];
      const row = i * cols;
      const nextRow = (i + 1) * cols;
      for (let j = midN - 1; j >= 0; j--) {
        if (aLine === target[prefix + j]) {
          dp[row + j] = dp[nextRow + j + 1] + 1;
        } else {
          const down = dp[nextRow + j];
          const right = dp[row + j + 1];
          dp[row + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < midM && j < midN) {
      if (base[prefix + i] === target[prefix + j]) {
        pairs.push([prefix + i, prefix + j]);
        i++;
        j++;
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
        i++;
      } else {
        j++;
      }
    }
  }

  for (let k = 0; k < suffix; k++) {
    pairs.push([m - suffix + k, n - suffix + k]);
  }

  return pairs;
}

function mergeHunk(
  baseSpan: string[],
  remoteSlice: string[],
  localSlice: string[],
): string[] {
  const remoteChanged = !arraysEqual(remoteSlice, baseSpan);
  const localChanged = !arraysEqual(localSlice, baseSpan);

  if (!remoteChanged && !localChanged) {
    return baseSpan;
  }
  if (remoteChanged && !localChanged) {
    return remoteSlice;
  }
  if (!remoteChanged && localChanged) {
    return localSlice;
  }
  if (arraysEqual(remoteSlice, localSlice)) {
    return remoteSlice;
  }
  // Keep both sides on colliding hunks (Remote then Local, no conflict markers).
  return [...remoteSlice, ...localSlice];
}

/**
 * Performs a 3-way line-based merge that preserves all lines from both Remote and Local
 * on colliding hunks without inserting Git conflict markers.
 */
export function mergeThreeWayKeepBoth(base: string, remote: string, local: string): string {
  const baseLines = toLines(base);
  const remoteLines = toLines(remote);
  const localLines = toLines(local);

  const remoteMap = new Map<number, number>();
  for (const [bi, ri] of lcsMatches(baseLines, remoteLines)) {
    remoteMap.set(bi, ri);
  }

  const localMap = new Map<number, number>();
  for (const [bi, li] of lcsMatches(baseLines, localLines)) {
    localMap.set(bi, li);
  }

  const out: string[] = [];
  let bi = 0;
  let ri = 0;
  let li = 0;

  while (bi <= baseLines.length) {
    if (bi < baseLines.length) {
      const rMatch = remoteMap.get(bi);
      const lMatch = localMap.get(bi);

      if (rMatch !== undefined && lMatch !== undefined) {
        if (ri < rMatch || li < lMatch) {
          out.push(
            ...mergeHunk([], remoteLines.slice(ri, rMatch), localLines.slice(li, lMatch)),
          );
        }
        out.push(baseLines[bi]);
        bi++;
        ri = rMatch + 1;
        li = lMatch + 1;
        continue;
      }
    }

    // Advance until the next base line matched by both sides (or end of base).
    let nextBi = bi + 1;
    while (
      nextBi < baseLines.length &&
      !(remoteMap.has(nextBi) && localMap.has(nextBi))
    ) {
      nextBi++;
    }

    const rEnd = nextBi < baseLines.length ? remoteMap.get(nextBi)! : remoteLines.length;
    const lEnd = nextBi < baseLines.length ? localMap.get(nextBi)! : localLines.length;

    out.push(
      ...mergeHunk(
        baseLines.slice(bi, nextBi),
        remoteLines.slice(ri, rEnd),
        localLines.slice(li, lEnd),
      ),
    );

    if (nextBi >= baseLines.length) {
      break;
    }

    out.push(baseLines[nextBi]);
    bi = nextBi + 1;
    ri = rEnd + 1;
    li = lEnd + 1;
  }

  return out.join('\n');
}
