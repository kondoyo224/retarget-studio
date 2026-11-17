/*
 * Chain rotation resampling for retargeting skeletons with different bone counts.
 * Inputs are per-bone rotation deltas already converted into a shared chain space.
 * The asset adapter is responsible for rest-pose and bone-axis conversion.
 */
(function (global) {
  'use strict';

  const EPSILON = 1e-8;

  function normalizeQuaternion(q) {
    const length = Math.hypot(q[0], q[1], q[2], q[3]);
    if (length < EPSILON) throw new Error('A rotation quaternion cannot have zero length.');
    return q.map(value => value / length);
  }

  function multiplyQuaternion(a, b) {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return normalizeQuaternion([
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz
    ]);
  }

  function inverseQuaternion(q) {
    return [-q[0], -q[1], -q[2], q[3]];
  }

  function slerpQuaternion(a, b, amount) {
    let end = b;
    let cosine = a[0] * end[0] + a[1] * end[1] + a[2] * end[2] + a[3] * end[3];
    if (cosine < 0) {
      end = end.map(value => -value);
      cosine = -cosine;
    }
    if (cosine > 0.9995) {
      return normalizeQuaternion(a.map((value, index) => value + (end[index] - value) * amount));
    }
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
    const sine = Math.sin(angle);
    const startWeight = Math.sin((1 - amount) * angle) / sine;
    const endWeight = Math.sin(amount * angle) / sine;
    return normalizeQuaternion(a.map((value, index) => value * startWeight + end[index] * endWeight));
  }

  function normalizedPositions(lengths, distribution, customWeights) {
    const weights = distribution === 'even'
      ? lengths.map(() => 1)
      : distribution === 'custom' && customWeights
        ? customWeights.slice()
        : lengths.slice();
    if (weights.length !== lengths.length || weights.some(value => !Number.isFinite(value) || value < 0)) {
      throw new Error('Chain weights must be non-negative and match the segment count.');
    }
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total < EPSILON) throw new Error('A chain needs at least one segment with positive weight.');
    const positions = [0];
    let accumulated = 0;
    for (const weight of weights) {
      accumulated += weight / total;
      positions.push(accumulated);
    }
    positions[positions.length - 1] = 1;
    return positions;
  }

  function sampleQuaternionCurve(knots, positions, location) {
    if (location <= 0) return knots[0];
    if (location >= 1) return knots[knots.length - 1];
    for (let index = 0; index < positions.length - 1; index++) {
      if (location <= positions[index + 1]) {
        const span = positions[index + 1] - positions[index];
        const blend = span < EPSILON ? 0 : (location - positions[index]) / span;
        return slerpQuaternion(knots[index], knots[index + 1], blend);
      }
    }
    return knots[knots.length - 1];
  }

  /**
   * Resample the cumulative orientation curve of one semantic bone chain.
   *
   * @param {Array<{length:number, delta:number[]}>} sourceSegments
   *   Source segment lengths and per-segment quaternion deltas in a shared chain space.
   * @param {number[]} targetLengths Rest-pose lengths for target chain segments.
   * @param {{sourceDistribution?:'length'|'even', targetDistribution?:'length'|'even'|'custom', targetWeights?:number[]}} options
   * @returns {{sourcePositions:number[],targetPositions:number[],targetDeltas:number[][],endRotation:number[]}}
   *
   * The target deltas compose to the source chain's final cumulative rotation. This
   * naturally aggregates a longer source chain into fewer target segments and
   * distributes a shorter source chain over additional target segments.
   */
  function distributeChainRotations(sourceSegments, targetLengths, options = {}) {
    if (!Array.isArray(sourceSegments) || sourceSegments.length === 0) {
      throw new Error('The source chain must contain at least one segment.');
    }
    if (!Array.isArray(targetLengths) || targetLengths.length === 0) {
      throw new Error('The target chain must contain at least one segment.');
    }
    const sourceLengths = sourceSegments.map(segment => Number(segment.length));
    if (sourceLengths.some(length => !Number.isFinite(length) || length < 0)) {
      throw new Error('Source segment lengths must be non-negative numbers.');
    }
    if (targetLengths.some(length => !Number.isFinite(length) || length < 0)) {
      throw new Error('Target segment lengths must be non-negative numbers.');
    }

    const sourcePositions = normalizedPositions(sourceLengths, options.sourceDistribution || 'length');
    const targetPositions = normalizedPositions(targetLengths, options.targetDistribution || 'length', options.targetWeights);
    const cumulative = [[0, 0, 0, 1]];
    for (const segment of sourceSegments) {
      const delta = normalizeQuaternion(segment.delta);
      cumulative.push(multiplyQuaternion(cumulative[cumulative.length - 1], delta));
    }

    const sampled = targetPositions.map(position => sampleQuaternionCurve(cumulative, sourcePositions, position));
    const targetDeltas = sampled.slice(1).map((rotation, index) =>
      multiplyQuaternion(inverseQuaternion(sampled[index]), rotation)
    );

    return {
      sourcePositions,
      targetPositions,
      targetDeltas,
      endRotation: cumulative[cumulative.length - 1]
    };
  }

  global.RetargetCore = Object.freeze({ distributeChainRotations, multiplyQuaternion });
})(window);
