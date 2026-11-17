import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const EPSILON = 1e-8;
const SOURCE_SLOT_INFO = {
  Hips: ['Hips', ['hips','hip','pelvis','root']],
  Spine: ['Spine', ['spine','spine1','spine01','abdomen']],
  Chest: ['Chest', ['chest','upperchest','spine2','spine02','spine3','spine03','torso']],
  Neck: ['Neck', ['neck']],
  Head: ['Head', ['head']],
  LeftArm: ['Left Arm', ['leftarm','leftupperarm','upperarmleft','upperarml','lupperarm']],
  RightArm: ['Right Arm', ['rightarm','rightupperarm','upperarmright','upperarmr','rupperarm']],
  LeftForeArm: ['Left ForeArm', ['leftforearm','forearmleft','lowerarmleft','lowerarml','forearml']],
  RightForeArm: ['Right ForeArm', ['rightforearm','forearmright','lowerarmright','lowerarmr','forearmr']],
  LeftHand: ['Left Hand', ['lefthand','handleft','handl','lhand']],
  RightHand: ['Right Hand', ['righthand','handright','handr','rhand']],
  LeftUpLeg: ['Left Leg', ['leftupleg','leftupperleg','leftthigh','thighleft','thighl','upperlegl']],
  RightUpLeg: ['Right Leg', ['rightupleg','rightupperleg','rightthigh','thighright','thighr','upperlegr']],
  LeftLeg: ['Left Calf', ['leftleg','leftcalf','calfleft','calfl','lowerlegl','shinl']],
  RightLeg: ['Right Calf', ['rightleg','rightcalf','calfright','calfr','lowerlegr','shinr']],
  LeftFoot: ['Left Foot', ['leftfoot','footleft','footl','lfoot']],
  RightFoot: ['Right Foot', ['rightfoot','footright','footr','rfoot']]
};

const TARGET_SLOT_LABELS = {
  Hips: 'Hips', Spine: 'Spine', Neck: 'Neck', Head: 'Head',
  LeftArm: 'Left Arm', RightArm: 'Right Arm',
  LeftForeArm: 'Left ForeArm', RightForeArm: 'Right ForeArm',
  LeftHand: 'Left Hand', RightHand: 'Right Hand',
  LeftUpLeg: 'Left Leg', RightUpLeg: 'Right Leg',
  LeftLeg: 'Left Calf', RightLeg: 'Right Calf',
  LeftFoot: 'Left Foot', RightFoot: 'Right Foot'
};

const DIRECT_PAIRS = [
  ['Hips','Hips'],['Head','Head'],
  ['LeftArm','Left Arm'],['LeftForeArm','Left ForeArm'],['LeftHand','Left Hand'],
  ['RightArm','Right Arm'],['RightForeArm','Right ForeArm'],['RightHand','Right Hand'],
  ['LeftUpLeg','Left Leg'],['LeftLeg','Left Calf'],['LeftFoot','Left Foot'],
  ['RightUpLeg','Right Leg'],['RightLeg','Right Calf'],['RightFoot','Right Foot']
];

function normalizedName(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g,''); }
function quaternionFor(asset,node) { return asset.restTransforms?.get(node)?.quaternion || node.quaternion; }
function restFor(asset,node) { return asset.restTransforms?.get(node); }
function inverse(q) { return q.clone().invert(); }
function mirroredRotation(q) { return new THREE.Quaternion(q.x,-q.y,-q.z,q.w).normalize(); }
function boneIdPath(bone) {
  const path = []; let item = bone;
  while (item) { if (item.isBone) path.unshift(item.name || 'Bone'); item = item.parent; }
  return path.join('/');
}
function collectBoneRecords(root) {
  const records = [], depths = new Map();
  root.traverse(node => {
    if (!node.isBone) return;
    let parent = node.parent; while (parent && !parent.isBone) parent = parent.parent;
    const parentId = parent ? boneIdPath(parent) : '';
    const id = boneIdPath(node), depth = parent ? (depths.get(parentId) || 0) + 1 : 0;
    depths.set(id,depth); records.push({id,name:node.name || 'Bone',parentId,depth,node});
  });
  return records;
}
function resolveSourceBone(asset,sourceMap,slot) {
  const [label,aliases] = SOURCE_SLOT_INFO[slot] || [slot,[]];
  const requested = sourceMap?.[label];
  if (requested === '— 미지정 —') return null;
  if (requested) {
    const exact = asset.bones.find(bone => bone.name === requested);
    if (exact) return exact.node;
  }
  const names = aliases.length ? aliases : [normalizedName(slot)];
  const exact = asset.bones.find(bone => names.includes(normalizedName(bone.name)));
  if (exact) return exact.node;
  return asset.bones.find(bone => names.some(alias => normalizedName(bone.name).startsWith(alias) || normalizedName(bone.name).endsWith(alias)))?.node || null;
}
function resolveTargetBone(asset,targetMap,slot) {
  const id = targetMap?.[slot] || targetMap?.[TARGET_SLOT_LABELS[slot]];
  return id ? asset.bones.find(bone => bone.id === id)?.node || null : null;
}
function isAncestor(ancestor,descendant) {
  let item = descendant;
  while (item) { if (item === ancestor) return true; item = item.parent; }
  return false;
}
function bonesBefore(start,end) {
  if (!start || !end || start === end) return null;
  const reverse = []; let item = end;
  while (item && item !== start) { if (item.isBone) reverse.push(item); item = item.parent; }
  if (item !== start) return null;
  const path = [start,...reverse.reverse()]; path.pop();
  return path.length ? path : null;
}
function chainLengths(asset,path,end) {
  return path.map((bone,index) => {
    const next = path[index + 1] || end;
    const a = restFor(asset,bone)?.worldPosition, b = restFor(asset,next)?.worldPosition;
    const distance = a && b ? a.distanceTo(b) : 0;
    return Math.max(distance,EPSILON);
  });
}
function parentRestWorld(asset,node) {
  const parent = node.parent;
  return parent ? (restFor(asset,parent)?.worldQuaternion || parent.getWorldQuaternion(new THREE.Quaternion())).clone() : new THREE.Quaternion();
}
function localDeltaInBase(asset,node,currentLocal,baseWorld) {
  const rest = restFor(asset,node), restLocal = rest?.quaternion || node.quaternion;
  const localDelta = inverse(restLocal).multiply(currentLocal).normalize();
  const restWorld = rest?.worldQuaternion || node.getWorldQuaternion(new THREE.Quaternion());
  const worldDelta = restWorld.clone().multiply(localDelta).multiply(inverse(restWorld)).normalize();
  return inverse(baseWorld).multiply(worldDelta).multiply(baseWorld).normalize();
}
function localDeltaFromBase(asset,node,baseWorld,delta) {
  const rest = restFor(asset,node), restWorld = rest?.worldQuaternion || node.getWorldQuaternion(new THREE.Quaternion());
  const worldDelta = baseWorld.clone().multiply(delta).multiply(inverse(baseWorld)).normalize();
  return inverse(restWorld).multiply(worldDelta).multiply(restWorld).normalize();
}
function weightedPositions(lengths,distribution) {
  const weights = distribution === 'even' ? lengths.map(() => 1) : lengths.map(length => Math.max(length,EPSILON));
  const total = weights.reduce((sum,value) => sum + value,0), positions = [0]; let sum = 0;
  for (const weight of weights) { sum += weight / total; positions.push(sum); }
  positions[positions.length - 1] = 1; return positions;
}
function sampleRotationCurve(knots,positions,location) {
  if (location <= 0) return knots[0].clone();
  if (location >= 1) return knots[knots.length - 1].clone();
  for (let index = 0; index < positions.length - 1; index++) {
    if (location <= positions[index + 1]) {
      const span = positions[index + 1] - positions[index];
      return knots[index].clone().slerp(knots[index + 1],span < EPSILON ? 0 : (location - positions[index]) / span);
    }
  }
  return knots[knots.length - 1].clone();
}
function redistributeChain(asset,targetAsset,sourcePath,targetPath,sourceEnd,targetEnd,sourceBase,targetBase,currentRotations,distribution,mirror) {
  if (!sourcePath?.length || !targetPath?.length) return new Map();
  const sourceLengths = chainLengths(asset,sourcePath,sourceEnd), targetLengths = chainLengths(targetAsset,targetPath,targetEnd);
  const sourcePositions = weightedPositions(sourceLengths,'length'), targetPositions = weightedPositions(targetLengths,distribution);
  const cumulative = [new THREE.Quaternion()];
  sourcePath.forEach((node,index) => {
    const delta = localDeltaInBase(asset,node,currentRotations.get(node),sourceBase);
    if (mirror) delta.copy(mirroredRotation(delta));
    cumulative.push(cumulative[cumulative.length - 1].clone().multiply(delta).normalize());
  });
  const sampled = targetPositions.map(position => sampleRotationCurve(cumulative,sourcePositions,position));
  const result = new Map();
  targetPath.forEach((node,index) => {
    const targetDelta = inverse(sampled[index]).multiply(sampled[index + 1]).normalize();
    const localDelta = localDeltaFromBase(targetAsset,node,targetBase,targetDelta);
    result.set(node,quaternionFor(targetAsset,node).clone().multiply(localDelta).normalize());
  });
  return result;
}

export function restoreRestPose(asset) {
  if (!asset?.restTransforms) return;
  for (const [node,transform] of asset.restTransforms) {
    node.position.copy(transform.position); node.quaternion.copy(transform.quaternion); node.scale.copy(transform.scale);
  }
  asset.root.updateMatrixWorld(true);
}

export function retargetFBX(source,target,sourceMap,targetMap,options = {}) {
  if (!source?.root || !target?.root) throw new Error('소스 FBX와 대상 FBX를 모두 불러오세요.');
  const clipIndex = Number(options.clipIndex) || 0, sourceClip = source.animations?.[clipIndex];
  if (!sourceClip) throw new Error('소스 FBX에 재생 가능한 애니메이션 클립이 없습니다.');
  const targetSlots = Object.fromEntries(Object.keys(TARGET_SLOT_LABELS).map(slot => [slot,resolveTargetBone(target,targetMap,slot)]));
  const missingTarget = ['Hips','Head','Spine','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot','LeftArm','LeftForeArm','LeftHand','RightArm','RightForeArm','RightHand'].filter(slot => !targetSlots[slot]);
  if (missingTarget.length) throw new Error(`대상 Character Definition 필수 슬롯을 확인하세요: ${missingTarget.join(', ')}`);

  const sourceSlots = Object.fromEntries(Object.keys(SOURCE_SLOT_INFO).map(slot => [slot,resolveSourceBone(source,sourceMap,slot)]));
  if (!sourceSlots.Spine) sourceSlots.Spine=sourceSlots.Chest;
  const requiredSource = ['Hips','Spine','Head','LeftArm','LeftForeArm','LeftHand','RightArm','RightForeArm','RightHand','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'];
  const missingSource = requiredSource.filter(slot => !sourceSlots[slot]);
  if (missingSource.length) throw new Error(`소스 본 매핑을 확인하세요: ${missingSource.join(', ')} · Source Semantic Map에서 지정하세요.`);
  if (!isAncestor(sourceSlots.Hips,sourceSlots.Spine) || !isAncestor(sourceSlots.Spine,sourceSlots.Head)) throw new Error('소스 Hips·Spine·Head 본 계층이 연결되지 않았습니다. 매핑을 확인하세요.');
  if (!isAncestor(targetSlots.Hips,targetSlots.Spine) || !isAncestor(targetSlots.Spine,targetSlots.Head)) throw new Error('대상 Hips·Spine·Head 본 계층이 연결되지 않았습니다. Character Definition을 확인하세요.');
  const hierarchyLinks=[['Spine','Hips'],['Head','Spine'],['LeftUpLeg','Hips'],['LeftLeg','LeftUpLeg'],['LeftFoot','LeftLeg'],['RightUpLeg','Hips'],['RightLeg','RightUpLeg'],['RightFoot','RightLeg'],['LeftArm','Spine'],['LeftForeArm','LeftArm'],['LeftHand','LeftForeArm'],['RightArm','Spine'],['RightForeArm','RightArm'],['RightHand','RightForeArm']];
  const sourceWarnings=hierarchyLinks.filter(([child,parent]) => sourceSlots[parent] && !isAncestor(sourceSlots[parent],sourceSlots[child])).map(([child,parent]) => `${child}→${parent}`);
  if (sourceWarnings.length) throw new Error(`소스 본 계층이 맞지 않습니다: ${sourceWarnings.join(', ')} · Source Semantic Map을 확인하세요.`);
  const targetWarnings=hierarchyLinks.filter(([child,parent]) => !isAncestor(targetSlots[parent],targetSlots[child])).map(([child,parent]) => `${child}→${parent}`);
  if (targetWarnings.length) throw new Error(`대상 본 계층이 맞지 않습니다: ${targetWarnings.join(', ')} · Character Definition을 확인하세요.`);

  restoreRestPose(source); restoreRestPose(target);
  target.root.updateMatrixWorld(true);
  const resultRoot = SkeletonUtils.clone(target.root), resultBones = collectBoneRecords(resultRoot);
  const originalTargetBones = target.bones.map(record => record.node), clonedBoneMap = new Map();
  const clonedBones = resultBones.map(record => record.node);
  originalTargetBones.forEach((node,index) => { if (clonedBones[index]) clonedBoneMap.set(node,clonedBones[index]); });
  const clonedTarget = {root:resultRoot,bones:resultBones,restTransforms:new Map()};
  resultRoot.updateMatrixWorld(true);
  resultRoot.traverse(node => {
    const position=node.position.clone(), quaternion=node.quaternion.clone(), scale=node.scale.clone();
    const worldPosition=node.getWorldPosition(new THREE.Vector3()), worldQuaternion=node.getWorldQuaternion(new THREE.Quaternion());
    clonedTarget.restTransforms.set(node,{position,quaternion,scale,worldPosition,worldQuaternion});
  });

  const sourceHips=sourceSlots.Hips,sourceSpine=sourceSlots.Spine,sourceHead=sourceSlots.Head,targetHips=targetSlots.Hips,targetSpine=targetSlots.Spine,targetHead=targetSlots.Head;
  const sourceNeck=sourceSlots.Neck,targetNeck=targetSlots.Neck;
  const hasNeckChain=sourceNeck && targetNeck && isAncestor(sourceSpine,sourceNeck) && isAncestor(sourceNeck,sourceHead) && isAncestor(targetSpine,targetNeck) && isAncestor(targetNeck,targetHead);
  const chains = hasNeckChain
    ? [
        {sourceStart:sourceSpine,sourceEnd:sourceNeck,targetStart:targetSpine,targetEnd:targetNeck,distribution:options.spineDistribution || 'length'},
        {sourceStart:sourceNeck,sourceEnd:sourceHead,targetStart:targetNeck,targetEnd:targetHead,distribution:options.neckDistribution || 'length'}
      ]
    : [{sourceStart:sourceSpine,sourceEnd:sourceHead,targetStart:targetSpine,targetEnd:targetHead,distribution:options.spineDistribution || 'length'}];
  for (const chain of chains) {
    chain.sourcePath=bonesBefore(chain.sourceStart,chain.sourceEnd); chain.targetPath=bonesBefore(chain.targetStart,chain.targetEnd);
    if (!chain.sourcePath || !chain.targetPath) throw new Error('Spine/Neck 체인 계층을 읽지 못했습니다. Character Definition과 소스 매핑을 확인하세요.');
    chain.sourceBase=parentRestWorld(source,chain.sourcePath[0]); chain.targetBase=parentRestWorld(clonedTarget,clonedBoneMap.get(chain.targetPath[0]));
    chain.targetPath=chain.targetPath.map(node => clonedBoneMap.get(node)); chain.targetEnd=clonedBoneMap.get(chain.targetEnd);
  }

  const heightSource=restFor(source,sourceHead).worldPosition.distanceTo(restFor(source,sourceHips).worldPosition);
  const heightTarget=restFor(target,targetHead).worldPosition.distanceTo(restFor(target,targetHips).worldPosition);
  const scale=options.scaleMode === 'Preserve source' ? 1 : options.scaleMode === 'Manual' ? Math.max(0.01,Number(options.manualScale)||1) : heightSource > EPSILON ? heightTarget / heightSource : 1;
  const fps=Math.max(1,Math.min(120,Number(options.fps) || 30)), frameCount=Math.max(2,Math.ceil(sourceClip.duration*fps)+1), times=new Float32Array(frameCount);
  for (let index=0;index<frameCount;index++) times[index]=index/fps;
  const mixer=new THREE.AnimationMixer(source.root),action=mixer.clipAction(sourceClip);
  action.reset(); action.setLoop(THREE.LoopOnce,1); action.clampWhenFinished=true; action.play();
  const rotationTracks=new Map(),positionTrack=[],rootMotion=[],animatedBoneSet=new Set();
  for (const chain of chains) chain.targetPath.forEach(node => animatedBoneSet.add(node));
  const opposite={LeftArm:'RightArm',RightArm:'LeftArm',LeftForeArm:'RightForeArm',RightForeArm:'LeftForeArm',LeftHand:'RightHand',RightHand:'LeftHand',LeftUpLeg:'RightUpLeg',RightUpLeg:'LeftUpLeg',LeftLeg:'RightLeg',RightLeg:'LeftLeg',LeftFoot:'RightFoot',RightFoot:'LeftFoot'};
  const directPairs=DIRECT_PAIRS.map(([targetSlot,label]) => ({target:clonedBoneMap.get(targetSlots[targetSlot]),source:sourceSlots[options.mirror && opposite[targetSlot] ? opposite[targetSlot] : targetSlot],label}));
  for (const pair of directPairs) { if (pair.target && pair.source) animatedBoneSet.add(pair.target); }
  const targetHipClone=clonedBoneMap.get(targetHips), targetHipRest=restFor(clonedTarget,targetHipClone);
  const sourceHipRest=restFor(source,sourceHips), targetHipParent=parentRestWorld(clonedTarget,targetHipClone);
  for (let index=0;index<frameCount;index++) {
    const time=Math.min(sourceClip.duration,index/fps); mixer.setTime(time); source.root.updateMatrixWorld(true);
    const sourceRotations=new Map(source.bones.map(record => [record.node,record.node.quaternion.clone()]));
    const targetRotations=new Map();
    for (const chain of chains) {
      const values=redistributeChain(source,clonedTarget,chain.sourcePath,chain.targetPath,chain.sourceEnd,chain.targetEnd,chain.sourceBase,chain.targetBase,sourceRotations,chain.distribution,options.mirror);
      for (const [node,quaternion] of values) targetRotations.set(node,quaternion);
    }
    for (const pair of directPairs) {
      if (!pair.source || !pair.target || targetRotations.has(pair.target)) continue;
      const sourceBase=parentRestWorld(source,pair.source), targetBase=parentRestWorld(clonedTarget,pair.target);
      const delta=localDeltaInBase(source,pair.source,sourceRotations.get(pair.source),sourceBase);
      if (options.mirror) delta.copy(mirroredRotation(delta));
      const targetDelta=localDeltaFromBase(clonedTarget,pair.target,targetBase,delta);
      targetRotations.set(pair.target,quaternionFor(clonedTarget,pair.target).clone().multiply(targetDelta).normalize());
    }
    for (const [node,quaternion] of targetRotations) {
      let values=rotationTracks.get(node); if (!values) { values=[]; rotationTracks.set(node,values); }
      values.push(quaternion.x,quaternion.y,quaternion.z,quaternion.w);
    }
    const worldDelta=sourceSlots.Hips.getWorldPosition(new THREE.Vector3()).sub(sourceHipRest.worldPosition);
    const targetDelta=worldDelta.applyQuaternion(inverse(targetHipParent)).multiplyScalar(scale);
    if (options.mirror) targetDelta.x *= -1;
    rootMotion.push([targetDelta.x,targetDelta.y,targetDelta.z]);
    const rootMode=options.rootMotion || 'Apply to root';
    if (rootMode === 'Apply to root') {
      positionTrack.push(targetHipRest.position.x+targetDelta.x,targetHipRest.position.y+targetDelta.y,targetHipRest.position.z+targetDelta.z);
    }
  }
  action.stop(); mixer.stopAllAction(); mixer.uncacheRoot(source.root); restoreRestPose(source); restoreRestPose(target);

  const tracks=[];
  for (const [originalNode,values] of rotationTracks) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${originalNode.uuid}.quaternion`,times,new Float32Array(values)));
  }
  if (positionTrack.length) tracks.push(new THREE.VectorKeyframeTrack(`${targetHipClone.uuid}.position`,times,new Float32Array(positionTrack)));
  const outputDuration=times[times.length-1], outputClip=new THREE.AnimationClip(`${sourceClip.name || 'Motion'}_Retargeted`,outputDuration,tracks);
  resultRoot.animations=[outputClip];
  const asset={root:resultRoot,bones:resultBones,restTransforms:clonedTarget.restTransforms,animations:[outputClip],fileName:`${target.fileName || 'Target'}_Retargeted.fbx`,sampleFps:fps};
  return {asset,clip:outputClip,fps,frameCount,duration:outputDuration,scale,rootMotion:options.rootMotion === 'Extract' ? rootMotion : null,mappedBoneCount:rotationTracks.size,sourceClip:sourceClip.name || 'Animation'};
}
