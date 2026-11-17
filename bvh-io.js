/* Basic BVH hierarchy and motion reader for the browser prototype. */
(function (global) {
  'use strict';

  function multiply(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz
    ];
  }

  function rotate(q, v) {
    const [x, y, z, w] = q, [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
  }

  function axisRotation(axis, degrees) {
    const half = degrees * Math.PI / 360, sine = Math.sin(half);
    if (axis === 'X') return [sine, 0, 0, Math.cos(half)];
    if (axis === 'Y') return [0, sine, 0, Math.cos(half)];
    return [0, 0, sine, Math.cos(half)];
  }

  function parse(text) {
    const tokens = String(text).match(/[{}]|[^\s{}]+/g) || [];
    let cursor = 0, channelTotal = 0;
    const peek = () => tokens[cursor];
    const take = (expected) => {
      const value = tokens[cursor++];
      if (value === undefined) throw new Error(`BVH ended while expecting ${expected || 'a token'}.`);
      if (expected && value.toUpperCase() !== expected.toUpperCase()) throw new Error(`Expected ${expected}, found ${value}.`);
      return value;
    };
    const number = label => {
      const value = Number(take());
      if (!Number.isFinite(value)) throw new Error(`Invalid number for ${label}.`);
      return value;
    };
    const vector = label => [number(label), number(label), number(label)];

    take('HIERARCHY');
    let endSiteIndex = 0;
    function readNode(type, parent = null) {
      const name = type === 'End Site' ? `${parent.name}_EndSite_${++endSiteIndex}` : take();
      const node = {name, type, parent, children: [], offset: [0,0,0], channels: [], channelStart: channelTotal};
      take('{');
      while (peek() !== '}') {
        const token = take();
        if (token.toUpperCase() === 'OFFSET') node.offset = vector('offset');
        else if (token.toUpperCase() === 'CHANNELS') {
          const count = number('channel count');
          if (!Number.isInteger(count) || count < 0 || count > 12) throw new Error(`Invalid channel count on ${node.name}.`);
          for (let index = 0; index < count; index++) node.channels.push(take());
          node.channelStart = channelTotal; channelTotal += count;
        } else if (token.toUpperCase() === 'JOINT') node.children.push(readNode('JOINT', node));
        else if (token.toUpperCase() === 'END') {
          take('SITE');
          const endNode = readNode('End Site', node);
          node.children.push(endNode);
        } else throw new Error(`Unexpected hierarchy token '${token}' in ${node.name}.`);
      }
      take('}');
      return node;
    }

    take('ROOT');
    const root = readNode('ROOT');
    take('MOTION'); take('FRAMES:');
    const frameCount = number('frame count');
    if (!Number.isInteger(frameCount) || frameCount < 1) throw new Error('Frame count must be a positive integer.');
    take('FRAME'); take('TIME:');
    const frameTime = number('frame time');
    if (frameTime <= 0) throw new Error('Frame time must be greater than zero.');
    const valuesNeeded = frameCount * channelTotal;
    const values = new Float64Array(valuesNeeded);
    for (let index = 0; index < valuesNeeded; index++) values[index] = number(`motion value ${index + 1}`);
    const frames = Array.from({length: frameCount}, (_, frame) => values.slice(frame * channelTotal, (frame + 1) * channelTotal));
    const nodes = [];
    (function visit(node) { nodes.push(node); node.children.forEach(visit); })(root);
    return {root, nodes, frames, frameCount, frameTime, fps: 1 / frameTime, channelCount: channelTotal};
  }

  function poseAt(bvh, frameIndex) {
    const frame = bvh.frames[Math.max(0, Math.min(bvh.frameCount - 1, Math.round(frameIndex)))];
    const pose = new Map();
    function visit(node, parentPosition, parentRotation) {
      const localPosition = node.offset.slice();
      let localRotation = [0,0,0,1];
      node.channels.forEach((channel, index) => {
        const value = frame[node.channelStart + index];
        const axis = channel[0].toUpperCase();
        if (channel.toLowerCase().endsWith('position')) {
          const component = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
          localPosition[component] += value;
        } else if (channel.toLowerCase().endsWith('rotation')) localRotation = multiply(localRotation, axisRotation(axis, value));
      });
      const rotatedOffset = rotate(parentRotation, localPosition);
      const position = parentPosition.map((value, index) => value + rotatedOffset[index]);
      const rotation = multiply(parentRotation, localRotation);
      pose.set(node, {position, rotation, localPosition, localRotation});
      node.children.forEach(child => visit(child, position, rotation));
    }
    visit(bvh.root, [0,0,0], [0,0,0,1]);
    return pose;
  }

  function serialize(bvh, frames, frameTime = bvh.frameTime) {
    if (!Array.isArray(frames) || frames.some(frame => frame.length !== bvh.channelCount)) throw new Error('BVH output frames do not match the target skeleton channels.');
    const lines = ['HIERARCHY'];
    function writeNode(node, depth, root = false) {
      const indent = '  '.repeat(depth), label = root ? `ROOT ${node.name}` : node.type === 'End Site' ? 'End Site' : `JOINT ${node.name}`;
      lines.push(`${indent}${label}`);
      lines.push(`${indent}{`);
      lines.push(`${indent}  OFFSET ${node.offset.map(value => Number(value).toFixed(6)).join(' ')}`);
      if (node.type !== 'End Site') {
        lines.push(`${indent}  CHANNELS ${node.channels.length}${node.channels.length ? ` ${node.channels.join(' ')}` : ''}`);
        for (const child of node.children) writeNode(child, depth + 1);
      }
      lines.push(`${indent}}`);
    }
    lines[0] = 'HIERARCHY';
    writeNode(bvh.root, 0, true);
    lines.push('MOTION', `Frames: ${frames.length}`, `Frame Time: ${Number(frameTime).toFixed(8)}`);
    for (const frame of frames) lines.push(frame.map(value => Number(value).toFixed(6)).join(' '));
    return lines.join('\n') + '\n';
  }

  global.BvhIO = Object.freeze({parse, poseAt, serialize});
})(window);
