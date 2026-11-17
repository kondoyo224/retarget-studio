/* Practical first-pass BVH to BVH retargeting. Bone-axis/rest-pose conversion is approximate. */
(function (global) {
  'use strict';

  const epsilon = 1e-8;
  const identity = () => [0,0,0,1];
  const inverse = q => [-q[0],-q[1],-q[2],q[3]];
  const normalizeName = name => String(name).toLowerCase().replace(/[^a-z0-9]/g,'');
  const aliases = {
    Hips:['hips','hip','pelvis','root'], Spine:['spine','spine1','spine01','abdomen'],
    Chest:['chest','upperchest','spine2','spine02','spine3','spine03'], Neck:['neck'], Head:['head'],
    'Left Arm':['leftarm','upperarmleft','leftupperarm','lupperarm','upperarml'], 'Right Arm':['rightarm','upperarmright','rightupperarm','rupperarm','upperarmr'],
    'Left Leg':['leftupleg','leftthigh','thighleft','lthigh','thighl'], 'Right Leg':['rightupleg','rightthigh','thighright','rthigh','thighr'],
    'Left Foot':['leftfoot','footleft','lfoot','footl'], 'Right Foot':['rightfoot','footright','rfoot','footr'],
    'Left Hand':['lefthand','handleft','lhand','handl'], 'Right Hand':['righthand','handright','rhand','handr'],
    'Left Toe':['lefttoe','toeleft','ltoe','toel'], 'Right Toe':['righttoe','toeright','rtoe','toer'],
    'Left Calf':['leftleg','leftcalf','calfleft','lcalf','calfl'], 'Right Calf':['rightleg','rightcalf','calfright','rcalf','calfr']
  };

  function findSemantic(nodes, semantic, requestedName) {
    if (requestedName !== undefined && (!requestedName || requestedName === '— 미지정 —')) return null;
    if (requestedName) {
      const exact = nodes.find(node => node.name === requestedName);
      if (exact) return exact;
    }
    const choices = aliases[semantic] || [];
    for (const alias of choices) {
      const exact = nodes.find(node => node.type !== 'End Site' && normalizeName(node.name) === alias);
      if (exact) return exact;
    }
    return nodes.find(node => node.type !== 'End Site' && choices.some(alias => {
      const name = normalizeName(node.name); return name.startsWith(alias) || name.endsWith(alias);
    })) || null;
  }

  function pathBefore(start, end) {
    if (!start || !end) return null;
    const path = []; let node = end;
    while (node && node !== start) { path.unshift(node); node = node.parent; }
    return node === start ? [start,...path.slice(0,-1)] : null;
  }
  function conjugate(rotation, basis) {
    return global.RetargetCore.multiplyQuaternion(global.RetargetCore.multiplyQuaternion(basis,rotation),inverse(basis));
  }
  function parentRestWorld(pose, node) { return node?.parent ? pose.get(node.parent).rotation : identity(); }
  function sourceDeltaInChainSpace(localDelta, node, restPose, chainBaseWorld) {
    const worldDelta = conjugate(localDelta,restPose.get(node).rotation);
    return conjugate(worldDelta,inverse(chainBaseWorld));
  }
  function targetDeltaFromChainSpace(chainDelta, node, restPose, chainBaseWorld) {
    const worldDelta = conjugate(chainDelta,chainBaseWorld);
    return conjugate(worldDelta,inverse(restPose.get(node).rotation));
  }

  function axisQuaternion(axis, radians) {
    const half = radians / 2, sine = Math.sin(half);
    if (axis === 'X') return [sine,0,0,Math.cos(half)];
    if (axis === 'Y') return [0,sine,0,Math.cos(half)];
    return [0,0,sine,Math.cos(half)];
  }
  function compose(axes, angles) {
    let q = identity();
    for (let index = 0; index < axes.length; index++) q = global.RetargetCore.multiplyQuaternion(q,axisQuaternion(axes[index],angles[index] || 0));
    return q;
  }
  function errorVector(current, target) {
    let q = global.RetargetCore.multiplyQuaternion(inverse(current),target);
    if (q[3] < 0) q = q.map(value => -value);
    const sine = Math.hypot(q[0],q[1],q[2]);
    if (sine < epsilon) return [0,0,0];
    const angle = 2 * Math.atan2(sine,Math.max(-1,Math.min(1,q[3])));
    return q.slice(0,3).map(value => value * angle / sine);
  }
  function solveLinear(matrix, vector) {
    const size = vector.length, rows = matrix.map((row,index) => [...row,vector[index]]);
    for (let column = 0; column < size; column++) {
      let pivot = column;
      for (let row = column + 1; row < size; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
      if (Math.abs(rows[pivot][column]) < 1e-10) return null;
      [rows[column],rows[pivot]] = [rows[pivot],rows[column]];
      const divisor = rows[column][column]; for (let cell = column; cell <= size; cell++) rows[column][cell] /= divisor;
      for (let row = 0; row < size; row++) if (row !== column) {
        const factor = rows[row][column]; for (let cell = column; cell <= size; cell++) rows[row][cell] -= factor * rows[column][cell];
      }
    }
    return rows.map(row => row[size]);
  }
  function toEulerChannels(quaternion, axes) {
    if (!axes.length) return [];
    const angles = axes.map(() => 0), step = 1e-4;
    for (let iteration = 0; iteration < 28; iteration++) {
      const error = errorVector(compose(axes,angles),quaternion);
      if (Math.hypot(...error) < 1e-7) break;
      const jacobian = Array.from({length:3},() => Array(axes.length).fill(0));
      for (let column = 0; column < axes.length; column++) {
        const adjusted = angles.slice(); adjusted[column] += step;
        const next = errorVector(compose(axes,adjusted),quaternion);
        for (let row = 0; row < 3; row++) jacobian[row][column] = (next[row] - error[row]) / step;
      }
      const normal = axes.map((_,left) => axes.map((__,right) => {
        let value = 0; for (let row = 0; row < 3; row++) value += jacobian[row][left] * jacobian[row][right]; return value;
      }));
      const right = axes.map((_,column) => {
        let value = 0; for (let row = 0; row < 3; row++) value -= jacobian[row][column] * error[row]; return value;
      });
      const update = solveLinear(normal,right); if (!update) break;
      update.forEach((value,index) => { angles[index] += Math.max(-0.6,Math.min(0.6,value)); });
    }
    return angles.map(value => value * 180 / Math.PI);
  }
  function span(bvh, pose) {
    const positions = bvh.nodes.filter(node => node.type !== 'End Site').map(node => pose.get(node).position);
    return Math.max(...[0,1,2].map(axis => Math.max(...positions.map(p => p[axis])) - Math.min(...positions.map(p => p[axis]))),epsilon);
  }

  function retarget(source, target, sourceMappings = {}, options = {}) {
    if (!global.BvhIO || !global.RetargetCore) throw new Error('BVH or retarget modules are not loaded.');
    if (!source?.frames?.length || !target?.frames?.length) throw new Error('소스 BVH와 대상 BVH를 모두 불러오세요.');
    const sourceNodes = source.nodes.filter(node => node.type !== 'End Site');
    const targetNodes = target.nodes.filter(node => node.type !== 'End Site');
    const semantics = Object.keys(aliases), sourceMap = new Map(), targetMap = new Map();
    for (const semantic of semantics) {
      const sourceNode = findSemantic(sourceNodes,semantic,sourceMappings[semantic]);
      const targetNode = findSemantic(targetNodes,semantic);
      if (sourceNode && targetNode) { sourceMap.set(semantic,sourceNode); targetMap.set(semantic,targetNode); }
    }
    if (!sourceMap.size) throw new Error('대응되는 본을 찾지 못했습니다. 본 이름 매핑을 확인하세요.');
    const missing = semantics.filter(name => !sourceMap.has(name) || !targetMap.has(name));
    const sourceRest = global.BvhIO.poseAt(source,0), targetRest = global.BvhIO.poseAt(target,0);
    const scale = options.scaleMode === 'Preserve source' ? 1 : span(target,targetRest) / span(source,sourceRest);
    const frames = [], rootMotion = [], mapped = new Set();
    const chainPairs = [['Hips','Spine'],['Spine','Chest'],['Chest','Neck'],['Neck','Head']];

    for (let frameIndex = 0; frameIndex < source.frameCount; frameIndex++) {
      const sourcePose = global.BvhIO.poseAt(source,frameIndex), targetDeltas = new Map();
      for (const [from,to] of chainPairs) {
        const sourcePath = pathBefore(sourceMap.get(from),sourceMap.get(to));
        const targetPath = pathBefore(targetMap.get(from),targetMap.get(to));
        if (!sourcePath?.length || !targetPath?.length) continue;
        const sourceBaseWorld = parentRestWorld(sourceRest,sourcePath[0]);
        const targetBaseWorld = parentRestWorld(targetRest,targetPath[0]);
        const segments = sourcePath.map(node => ({
          length:Math.max(Math.hypot(...node.offset),epsilon),
          delta:sourceDeltaInChainSpace(global.RetargetCore.multiplyQuaternion(inverse(sourceRest.get(node).localRotation),sourcePose.get(node).localRotation),node,sourceRest,sourceBaseWorld)
        }));
        const lengths = targetPath.map(node => Math.max(Math.hypot(...node.offset),epsilon));
        const distribution = from === 'Neck' ? options.neckDistribution : options.spineDistribution;
        const result = global.RetargetCore.distributeChainRotations(segments,lengths,{targetDistribution:distribution || options.chainDistribution || 'length'});
        targetPath.forEach((node,index) => { targetDeltas.set(node,targetDeltaFromChainSpace(result.targetDeltas[index],node,targetRest,targetBaseWorld)); mapped.add(node); });
      }
      for (const [semantic,sourceNode] of sourceMap) {
        const targetNode = targetMap.get(semantic);
        if (!targetDeltas.has(targetNode)) {
          const sourceLocal = global.RetargetCore.multiplyQuaternion(inverse(sourceRest.get(sourceNode).localRotation),sourcePose.get(sourceNode).localRotation);
          const sourceBase = parentRestWorld(sourceRest,sourceNode), targetBase = parentRestWorld(targetRest,targetNode);
          const common = sourceDeltaInChainSpace(sourceLocal,sourceNode,sourceRest,sourceBase);
          targetDeltas.set(targetNode,targetDeltaFromChainSpace(common,targetNode,targetRest,targetBase));
        }
        mapped.add(targetNode);
      }
      const output = target.frames[0].slice();
      for (const [node,delta] of targetDeltas) {
        const base = targetRest.get(node).localRotation;
        const desired = global.RetargetCore.multiplyQuaternion(base,delta);
        const rotationChannels = node.channels.map((channel,index) => ({channel,index})).filter(item => item.channel.toLowerCase().endsWith('rotation'));
        const angles = toEulerChannels(desired,rotationChannels.map(item => item.channel[0].toUpperCase()));
        rotationChannels.forEach((item,index) => { output[node.channelStart + item.index] = angles[index]; });
      }
      const sourceRoot = sourcePose.get(source.root), sourceRootRest = sourceRest.get(source.root);
      const rootDelta = sourceRoot.localPosition.map((value,index) => (value - sourceRootRest.localPosition[index]) * scale);
      rootMotion.push(rootDelta);
      if (options.rootMotion !== 'In-place' && options.rootMotion !== 'Extract') {
        target.root.channels.forEach((channel,index) => {
          if (!channel.toLowerCase().endsWith('position')) return;
          const axis = channel[0].toUpperCase() === 'X' ? 0 : channel[0].toUpperCase() === 'Y' ? 1 : 2;
          output[target.root.channelStart + index] += rootDelta[axis];
        });
      }
      frames.push(output);
    }
    return {frames,frameTime:source.frameTime,fps:source.fps,scale,missing,rootMotion:options.rootMotion === 'Extract' ? rootMotion : null,mappedBoneCount:mapped.size};
  }

  global.BvhRetarget = Object.freeze({retarget, toEulerChannels});
})(window);
