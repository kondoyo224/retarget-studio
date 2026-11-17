import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { retargetFBX, restoreRestPose } from './fbx-retarget.js';

let activeView = null;

function bonePath(bone) {
  const parts = []; let current = bone;
  while (current) { if (current.isBone) parts.unshift(current.name || 'Bone'); current = current.parent; }
  return parts.join('/');
}

export async function parseFBX(file) {
  const root = new FBXLoader().parse(await file.arrayBuffer(),'');
  root.updateMatrixWorld(true);
  const restTransforms = new Map();
  root.traverse(node => {
    restTransforms.set(node,{
      position:node.position.clone(),quaternion:node.quaternion.clone(),scale:node.scale.clone(),
      worldPosition:node.getWorldPosition(new THREE.Vector3()),worldQuaternion:node.getWorldQuaternion(new THREE.Quaternion())
    });
  });
  const bones = [], depths = new Map();
  root.traverse(node => {
    if (!node.isBone) return;
    const parent = (() => { let item = node.parent; while (item && !item.isBone) item = item.parent; return item; })();
    const parentId = parent ? bonePath(parent) : '';
    const depth = parent ? (depths.get(parentId) || 0) + 1 : 0;
    const id = bonePath(node); depths.set(id,depth);
    bones.push({id,name:node.name || 'Bone',parentId,depth,node});
  });
  if (!bones.length) throw new Error('FBX에 스켈레톤 본이 없습니다.');
  return {root,bones,restTransforms,animations:root.animations || [],fileName:file.name};
}

export function animationStats(asset, clipIndex = 0) {
  const clip = asset?.animations?.[clipIndex];
  if (!clip) return {fps:30,frameCount:1,duration:0};
  const fps = 30;
  return {fps,frameCount:Math.max(1,Math.ceil(clip.duration * fps) + 1),duration:clip.duration};
}

export function mount(container, asset, options = {}) {
  if (activeView) activeView.dispose();
  const svg = container.querySelector('.character'); if (svg) svg.style.display = 'none';
  const canvas = document.createElement('canvas'); canvas.className = 'fbx-renderer-canvas'; container.append(canvas);
  const renderer = new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x171a21);
  const camera = new THREE.PerspectiveCamera(38,1,0.01,10000);
  scene.add(new THREE.HemisphereLight(0xdce8ff,0x30313a,2.1));
  const key = new THREE.DirectionalLight(0xffffff,2.2); key.position.set(3,6,5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x8ab3ff,0.8); fill.position.set(-5,2,-3); scene.add(fill);
  const holder = new THREE.Group(); holder.add(asset.root); scene.add(holder);
  asset.root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(asset.root), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  holder.position.sub(center);
  const scale = Math.max(size.x,size.y,size.z,0.1);
  const floor = new THREE.GridHelper(scale * 3,30,0x667080,0x333944); floor.position.y = -size.y * 0.5; scene.add(floor);
  const helper = new THREE.SkeletonHelper(asset.root); helper.material.color.set(0xb8f36b); helper.material.depthTest = true; holder.add(helper);
  camera.position.set(scale * 1.2,scale * 0.75,scale * 2.5);
  const controls = new OrbitControls(camera,canvas); controls.enableDamping = true; controls.target.set(0,0,0); controls.update();
  const mixer = asset.animations.length ? new THREE.AnimationMixer(asset.root) : null;
  let activeAction = null;
  const setClip = index => {
    const clip = asset.animations[index];
    if (!mixer || !clip) return;
    mixer.stopAllAction(); activeAction = mixer.clipAction(clip); activeAction.reset(); activeAction.play(); mixer.setTime(0);
  };
  if (mixer) setClip(options.clipIndex || 0);
  function resize() {
    const width = Math.max(1,container.clientWidth), height = Math.max(1,container.clientHeight);
    renderer.setSize(width,height,false); camera.aspect = width / height; camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene,camera); });
  activeView = {
    asset,
    setFrame(frame,fps = asset.sampleFps || 30) { if (mixer) mixer.setTime(Math.max(0,Number(frame) / fps)); },
    setClip(index) { setClip(index); },
    setView(name) {
      const distance = scale * 2.7;
      if (name === 'Front') camera.position.set(0,0,distance);
      else if (name === 'Side') camera.position.set(distance,0,0);
      else camera.position.set(scale * 1.2,scale * 0.75,distance * 0.92);
      controls.target.set(0,0,0); controls.update();
    },
    dispose() {
      observer.disconnect(); renderer.setAnimationLoop(null); controls.dispose(); renderer.dispose();
      canvas.remove(); if (svg) svg.style.display = '';
    }
  };
  return activeView;
}

export { retargetFBX };

export function resampleClip(clip,{sourceFps=30,startFrame=1,endFrame=Math.ceil(clip.duration*sourceFps)+1,outputFps=sourceFps}={}) {
  if (!clip?.tracks?.length) throw new Error('출력할 애니메이션 키가 없습니다.');
  const lastSourceFrame=Math.max(1,Math.ceil(clip.duration*sourceFps)+1);
  const start=Math.max(1,Math.min(lastSourceFrame,Number(startFrame)||1));
  const end=Math.max(start,Math.min(lastSourceFrame,Number(endFrame)||lastSourceFrame));
  const from=(start-1)/sourceFps, to=Math.min(clip.duration,(end-1)/sourceFps), fps=Math.max(1,Math.min(120,Number(outputFps)||sourceFps));
  const count=Math.max(1,Math.floor((to-from)*fps+1e-6)+1), times=new Float32Array(count);
  for (let index=0;index<count;index++) times[index]=index/fps;
  const tracks=clip.tracks.map(track => {
    const valueSize=track.getValueSize(), values=new Float32Array(count*valueSize), interpolant=track.createInterpolant();
    for (let index=0;index<count;index++) {
      const sample=interpolant.evaluate(Math.min(to,from+times[index]));
      values.set(sample,index*valueSize);
    }
    return new track.constructor(track.name,times,values,track.getInterpolation());
  });
  return new THREE.AnimationClip(clip.name,Math.max(0,times[times.length-1]),tracks);
}

export function cloneClip(clip,name=clip?.name || 'Motion Layer') {
  if(!clip)throw new Error('복제할 애니메이션 클립이 없습니다.');
  const tracks=clip.tracks.map(track=>new track.constructor(track.name,track.times.slice(),track.values.slice(),track.getInterpolation()));
  return new THREE.AnimationClip(name,clip.duration,tracks);
}

export function createRestPoseClip(asset,duration=1,name='Empty Motion Layer') {
  const end=Math.max(1/30,Number(duration)||1),times=Float32Array.from([0,end]),tracks=[];
  for(const record of asset?.bones || []){
    const rest=asset.restTransforms?.get(record.node)?.quaternion || record.node.quaternion;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${record.node.uuid}.quaternion`,times,Float32Array.from([...rest.toArray(),...rest.toArray()])));
  }
  return new THREE.AnimationClip(name,end,tracks);
}

function layerAllowsTrack(trackName,mask,nodesByUUID) {
  if(!mask || mask==='full')return true;
  const uuid=trackName.slice(0,trackName.indexOf('.')),node=nodesByUUID.get(uuid);
  const name=`${node?.name || ''} ${node?.parent?.name || ''}`.toLowerCase();
  if(mask==='lower')return /hip|pelvis|leg|thigh|knee|calf|shin|foot|toe|ankle/.test(name);
  if(mask==='arms')return /clav|shoulder|arm|elbow|forearm|hand|wrist|finger/.test(name);
  if(mask==='upper')return !/hip|pelvis|leg|thigh|knee|calf|shin|foot|toe|ankle/.test(name);
  return true;
}

export function blendAnimationLayers(asset,layers,{fps=30,soloId=null}={}) {
  const active=(layers || []).filter(layer=>layer?.clip && !layer.muted && (soloId==null || layer.id===soloId) && Number(layer.weight ?? 1)>0);
  if(!active.length)throw new Error('재생 가능한 모션 레이어가 없습니다.');
  const rate=Math.max(1,Math.min(120,Number(fps)||30)),duration=Math.max(...active.map(layer=>layer.clip.duration)),count=Math.max(2,Math.ceil(duration*rate)+1),times=Float32Array.from({length:count},(_,index)=>Math.min(duration,index/rate));
  const nodesByUUID=new Map();asset?.root?.traverse(node=>nodesByUUID.set(node.uuid,node));
  const tracksByLayer=active.map(layer=>new Map(layer.clip.tracks.map(track=>[track.name,track]))),trackNames=[...new Set(tracksByLayer.flatMap(map=>[...map.keys()]))],result=[];
  for(const name of trackNames){
    const exemplar=tracksByLayer.map(map=>map.get(name)).find(Boolean),size=exemplar.getValueSize(),isQuaternion=exemplar instanceof THREE.QuaternionKeyframeTrack,nodeUUID=name.slice(0,name.indexOf('.')),node=nodesByUUID.get(nodeUUID),rest=asset?.restTransforms?.get(node);
    const restValue=isQuaternion?(rest?.quaternion || node?.quaternion || new THREE.Quaternion()).toArray():(name.endsWith('.position')?(rest?.position || node?.position || new THREE.Vector3()).toArray():name.endsWith('.scale')?(rest?.scale || node?.scale || new THREE.Vector3(1,1,1)).toArray():new Array(size).fill(0));
    const output=new Float32Array(count*size),samples=tracksByLayer.map(map=>map.get(name)?.createInterpolant() || null);
    for(let index=0;index<count;index++){
      let value=isQuaternion?new THREE.Quaternion().fromArray(restValue):restValue.slice();
      for(let layerIndex=0;layerIndex<active.length;layerIndex++){
        const layer=active[layerIndex],track=tracksByLayer[layerIndex].get(name),interpolant=samples[layerIndex],weight=Math.max(0,Math.min(1,Number(layer.weight ?? 1)));
        if(!track || !interpolant || !layerAllowsTrack(name,layer.mask,nodesByUUID))continue;
        const sample=interpolant.evaluate(Math.min(layer.clip.duration,times[index]));
        if(isQuaternion){
          const target=new THREE.Quaternion().fromArray(sample);
          if(layer.mode==='additive'){
            const restQ=new THREE.Quaternion().fromArray(restValue),delta=restQ.invert().multiply(target),weighted=new THREE.Quaternion().identity().slerp(delta,weight);
            value.multiply(weighted).normalize();
          }else value.slerp(target,weight).normalize();
        }else{
          for(let component=0;component<size;component++){
            const target=sample[component];
            value[component]=layer.mode==='additive' ? value[component]+(target-restValue[component])*weight : value[component]+(target-value[component])*weight;
          }
        }
      }
      if(isQuaternion)value.toArray(output,index*size);else output.set(value,index*size);
    }
    result.push(new exemplar.constructor(name,times,output,exemplar.getInterpolation()));
  }
  return new THREE.AnimationClip('Layered Motion',duration,result);
}

export function sequenceClips(segments,{fps=30}={}) {
  const usable=(segments || []).filter(segment=>segment?.clip?.tracks?.length);
  if(!usable.length)throw new Error('Story에 넣을 애니메이션 클립이 없습니다.');
  const rate=Math.max(1,Math.min(120,Number(fps)||30)),prepared=usable.map(segment=>({clip:segment.clip,count:Math.max(2,Number(segment.frameCount)||Math.ceil(segment.clip.duration*rate)+1),sourceStart:Math.max(0,Number(segment.sourceStart)||0)})),count=prepared.reduce((sum,segment)=>sum+segment.count,0),duration=(count-1)/rate,times=Float32Array.from({length:count},(_,index)=>index/rate),names=[...new Set(prepared.flatMap(segment=>segment.clip.tracks.map(track=>track.name)))],tracks=[];
  for(const name of names){
    const exemplars=prepared.map(segment=>segment.clip.tracks.find(track=>track.name===name)),exemplar=exemplars.find(Boolean),size=exemplar.getValueSize(),isQuaternion=exemplar instanceof THREE.QuaternionKeyframeTrack,values=new Float32Array(count*size);let cursor=0,last=isQuaternion?[0,0,0,1]:new Array(size).fill(0);
    for(let segmentIndex=0;segmentIndex<prepared.length;segmentIndex++){
      const segment=prepared[segmentIndex],track=exemplars[segmentIndex],interpolant=track?.createInterpolant();
      for(let frameIndex=0;frameIndex<segment.count;frameIndex++){
        const time=Math.min(segment.clip.duration,segment.sourceStart+frameIndex/rate);
        if(interpolant)last=Array.from(interpolant.evaluate(time));
        values.set(last,cursor*size);cursor++;
      }
    }
    tracks.push(new exemplar.constructor(name,times,values,exemplar.getInterpolation()));
  }
  return new THREE.AnimationClip('Story Sequence',duration,tracks);
}

function worldQuaternion(node) { return node.getWorldQuaternion(new THREE.Quaternion()); }
function rotateJointToward(joint,child,targetWorld) {
  const origin=joint.getWorldPosition(new THREE.Vector3()),current=child.getWorldPosition(new THREE.Vector3()).sub(origin),desired=targetWorld.clone().sub(origin);
  if(current.lengthSq()<1e-10 || desired.lengthSq()<1e-10)return;
  const delta=new THREE.Quaternion().setFromUnitVectors(current.normalize(),desired.normalize()),parent=joint.parent;
  const nextWorld=delta.multiply(worldQuaternion(joint)).normalize(),nextLocal=parent?worldQuaternion(parent).invert().multiply(nextWorld):nextWorld;
  joint.quaternion.copy(nextLocal);joint.updateMatrixWorld(true);
}

function solveTwoBoneTarget(root,upper,middle,end,targetWorld,weight=1) {
  const origin=upper.getWorldPosition(new THREE.Vector3()),knee=middle.getWorldPosition(new THREE.Vector3()),ankle=end.getWorldPosition(new THREE.Vector3()),axis=targetWorld.clone().sub(origin),distance=axis.length();
  const upperLength=Math.max(1e-6,origin.distanceTo(knee)),lowerLength=Math.max(1e-6,knee.distanceTo(ankle));
  if(distance<1e-6)return false;
  const direction=axis.clone().normalize(),reach=Math.max(Math.abs(upperLength-lowerLength)+1e-5,Math.min(distance,upperLength+lowerLength-1e-5)),target=origin.clone().addScaledVector(direction,reach);
  let pole=knee.clone().sub(origin).addScaledVector(direction,-knee.clone().sub(origin).dot(direction));
  if(pole.lengthSq()<1e-8){const reference=Math.abs(direction.y)<.9?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);pole.crossVectors(direction,reference);}
  pole.normalize();const along=(upperLength*upperLength+reach*reach-lowerLength*lowerLength)/(2*reach),height=Math.sqrt(Math.max(0,upperLength*upperLength-along*along)),kneeTarget=origin.clone().addScaledVector(direction,along).addScaledVector(pole,height);
  const upperStart=upper.quaternion.clone(),middleStart=middle.quaternion.clone();rotateJointToward(upper,middle,kneeTarget);root.updateMatrixWorld(true);rotateJointToward(middle,end,target);root.updateMatrixWorld(true);
  const blend=Math.max(0,Math.min(1,Number(weight)||0));upper.quaternion.copy(upperStart.slerp(upper.quaternion,blend));middle.quaternion.copy(middleStart.slerp(middle.quaternion,blend));root.updateMatrixWorld(true);return true;
}

export function bakeFootContacts(asset,clip,{fps=30,feet=[],auxEffectors=[],hipsId='',headId='',upAxis='Y',detectionHeightCm=4,plantStrength=.85,translationBlend=1,speedThreshold=.025}={}) {
  const rate=Math.max(1,Math.min(120,Number(fps)||30)),frameCount=Math.max(2,Math.ceil(clip.duration*rate)+1),axisIndex=upAxis==='X'?0:upAxis==='Z'?2:1;
  const originalNodes=[],sourceClone=SkeletonUtils.clone(asset.root),clonedNodes=[];asset.root.traverse(node=>originalNodes.push(node));sourceClone.traverse(node=>clonedNodes.push(node));
  const uuidMap=new Map(originalNodes.map((node,index)=>[node.uuid,clonedNodes[index]?.uuid])),cloneMap=new Map(originalNodes.map((node,index)=>[node,clonedNodes[index]]));
  const mappedTracks=clip.tracks.map(track=>{const dot=track.name.indexOf('.'),id=track.name.slice(0,dot),cloneId=uuidMap.get(id);return new track.constructor(`${cloneId || id}${track.name.slice(dot)}`,track.times,track.values,track.getInterpolation());});
  const samplingClip=new THREE.AnimationClip(`${clip.name}_ContactSample`,clip.duration,mappedTracks),mixer=new THREE.AnimationMixer(sourceClone),action=mixer.clipAction(samplingClip);action.reset();action.play();
  const resolvedFeet=feet.map(foot=>{
    const upper=asset.bones.find(record=>record.id===foot.upperId)?.node,middle=asset.bones.find(record=>record.id===foot.middleId)?.node,end=asset.bones.find(record=>record.id===foot.footId)?.node;
    return upper&&middle&&end?{...foot,upper:cloneMap.get(upper),middle:cloneMap.get(middle),end:cloneMap.get(end),samples:[],active:new Set()}:null;
  }).filter(Boolean);
  const resolvedEffectors=auxEffectors.map(effector=>{
    const upper=asset.bones.find(record=>record.id===effector.upperId)?.node,middle=asset.bones.find(record=>record.id===effector.middleId)?.node,end=asset.bones.find(record=>record.id===effector.endId)?.node;
    return upper&&middle&&end?{...effector,upper:cloneMap.get(upper),middle:cloneMap.get(middle),end:cloneMap.get(end)}:null;
  }).filter(Boolean);
  if(!resolvedFeet.length&&!resolvedEffectors.length){action.stop();mixer.uncacheRoot(sourceClone);return{clip:cloneClip(clip),contacts:[],contactFrames:0};}
  const heightNodes={hips:cloneMap.get(asset.bones.find(record=>record.id===hipsId)?.node),head:cloneMap.get(asset.bones.find(record=>record.id===headId)?.node)};
  let bodyHeight=1.7;
  if(heightNodes.hips&&heightNodes.head){sourceClone.updateMatrixWorld(true);bodyHeight=Math.max(.1,heightNodes.hips.getWorldPosition(new THREE.Vector3()).distanceTo(heightNodes.head.getWorldPosition(new THREE.Vector3())));}
  for(let frame=0;frame<frameCount;frame++){
    mixer.setTime(Math.min(clip.duration,frame/rate));sourceClone.updateMatrixWorld(true);
    for(const foot of resolvedFeet)foot.samples.push(foot.end.getWorldPosition(new THREE.Vector3()));
  }
  const floor=resolvedFeet.length?Math.min(...resolvedFeet.flatMap(foot=>foot.samples.map(point=>point.getComponent(axisIndex)))):0,heightTolerance=bodyHeight*Math.max(0,Number(detectionHeightCm)||0)/170,velocityLimit=bodyHeight*Math.max(.001,Number(speedThreshold)||.025);
  const intervals=[];
  for(const foot of resolvedFeet){
    const planted=foot.samples.map((point,index)=>{
      const previous=foot.samples[Math.max(0,index-1)],next=foot.samples[Math.min(frameCount-1,index+1)],delta=previous.distanceTo(next)/(index===0||index===frameCount-1?1:2);
      return point.getComponent(axisIndex)<=floor+heightTolerance && delta<=velocityLimit;
    });
    for(let index=1;index<planted.length-1;index++)if(planted[index-1]&&planted[index+1])planted[index]=true;
    for(let start=0;start<planted.length;){if(!planted[start]){start++;continue;}let end=start;while(end+1<planted.length&&planted[end+1])end++;if(end-start>=1){const anchor=foot.samples[start].clone();for(let frame=start;frame<=end;frame++)foot.active.add(frame);intervals.push({name:foot.name,startFrame:start+1,endFrame:end+1,anchor:anchor.toArray()});}start=end+1;}
  }
  if(!intervals.length&&!resolvedEffectors.length){action.stop();mixer.uncacheRoot(sourceClone);return{clip:cloneClip(clip),contacts:[],contactFrames:0};}
  const originalByClone=new Map([...cloneMap.entries()].map(([original,copy])=>[copy,original])),rotationSamples=new Map();
  for(const foot of resolvedFeet){if(!foot.active.size)continue;for(const joint of [foot.upper,foot.middle])if(!rotationSamples.has(joint))rotationSamples.set(joint,[]);}
  for(const effector of resolvedEffectors)for(const joint of [effector.upper,effector.middle])if(!rotationSamples.has(joint))rotationSamples.set(joint,[]);
  for(let frame=0;frame<frameCount;frame++){
    mixer.setTime(Math.min(clip.duration,frame/rate));sourceClone.updateMatrixWorld(true);
    const active=resolvedFeet.filter(foot=>foot.active.has(frame));
    for(const foot of active){
      const segment=intervals.find(item=>item.name===foot.name&&frame+1>=item.startFrame&&frame+1<=item.endFrame),anchor=new THREE.Vector3().fromArray(segment.anchor),ankle=foot.end.getWorldPosition(new THREE.Vector3()),target=ankle.lerp(anchor,Math.max(0,Math.min(1,Number(translationBlend)||0)));
      solveTwoBoneTarget(sourceClone,foot.upper,foot.middle,foot.end,target,plantStrength);
    }
    for(const effector of resolvedEffectors){const frameNumber=frame+1;if(frameNumber<Number(effector.startFrame||1)||frameNumber>Number(effector.endFrame||frameCount))continue;const current=effector.end.getWorldPosition(new THREE.Vector3()),target=current.lerp(new THREE.Vector3().fromArray(effector.target),Math.max(0,Math.min(1,Number(translationBlend)||0)));solveTwoBoneTarget(sourceClone,effector.upper,effector.middle,effector.end,target,Number(plantStrength)*Number(effector.weight ?? 1));}
    for(const joint of rotationSamples.keys())rotationSamples.get(joint).push(...joint.quaternion.toArray());
  }
  action.stop();mixer.stopAllAction();mixer.uncacheRoot(sourceClone);
  const times=Float32Array.from({length:frameCount},(_,index)=>Math.min(clip.duration,index/rate)),tracks=clip.tracks.filter(track=>{
    const originalUUID=track.name.slice(0,track.name.indexOf('.')),node=originalNodes.find(item=>item.uuid===originalUUID);return !node || ![...rotationSamples.keys()].includes(cloneMap.get(node));
  });
  for(const [joint,values] of rotationSamples){const original=originalByClone.get(joint);if(original)tracks.push(new THREE.QuaternionKeyframeTrack(`${original.uuid}.quaternion`,times,new Float32Array(values)));}
  return{clip:new THREE.AnimationClip(`${clip.name}_Contact`,clip.duration,tracks),contacts:intervals,contactFrames:new Set(resolvedFeet.flatMap(foot=>[...foot.active])).size,effectorCount:resolvedEffectors.length};
}

function boneTrack(clip,node) { return clip?.tracks.find(track=>track.name===`${node.uuid}.quaternion`) || null; }
function rotationAt(asset,clip,node,time) {
  const track=boneTrack(clip,node);
  if (track) return new THREE.Quaternion().fromArray(track.createInterpolant().evaluate(Math.max(0,Math.min(clip.duration,time))));
  return asset.restTransforms?.get(node)?.quaternion.clone() || node.quaternion.clone();
}
export function getBoneEulerDegrees(asset,clip,boneId,frame,fps=30) {
  const node=asset?.bones.find(record=>record.id===boneId)?.node;
  if (!node) throw new Error('선택한 본을 찾지 못했습니다.');
  const quaternion=rotationAt(asset,clip,node,(Math.max(1,Number(frame)||1)-1)/fps);
  const euler=new THREE.Euler().setFromQuaternion(quaternion,'XYZ'), factor=180/Math.PI;
  return [euler.x*factor,euler.y*factor,euler.z*factor];
}
export function getBoneWorldPosition(asset,boneId) {
  const node=asset?.bones.find(record=>record.id===boneId)?.node;
  if(!node)throw new Error('선택한 본을 찾지 못했습니다.');
  asset.root.updateMatrixWorld(true);return node.getWorldPosition(new THREE.Vector3()).toArray();
}
export function getBoneEulerSamples(asset,clip,boneId,axis=2) {
  const record=asset?.bones.find(item=>item.id===boneId); if (!record) return [];
  const track=boneTrack(clip,record.node);
  if (!track) return [];
  const factor=180/Math.PI, result=[];
  for (let index=0;index<track.times.length;index++) {
    const q=new THREE.Quaternion().fromArray(track.values.slice(index*4,index*4+4));
    const euler=new THREE.Euler().setFromQuaternion(q,'XYZ');
    result.push({time:track.times[index],value:[euler.x,euler.y,euler.z][axis]*factor});
  }
  return result;
}
export function setBoneInterpolation(clip,asset,boneId,mode='linear') {
  const node=asset?.bones.find(record=>record.id===boneId)?.node,track=node&&boneTrack(clip,node);
  if(!track)return false;
  track.setInterpolation(mode==='step'?THREE.InterpolateDiscrete:THREE.InterpolateLinear);return true;
}
export function setBoneEulerDegrees(asset,clip,boneId,frame,fps=30,degrees=[0,0,0]) {
  const node=asset?.bones.find(record=>record.id===boneId)?.node;
  if (!node || !clip) throw new Error('대상 본이나 애니메이션 클립을 찾지 못했습니다.');
  let track=boneTrack(clip,node), time=(Math.max(1,Number(frame)||1)-1)/fps;
  if (!track) {
    const template=clip.tracks[0], times=template?.times.slice() || Float32Array.from({length:Math.max(2,Math.ceil(clip.duration*fps)+1)},(_,index)=>index/fps);
    const rest=asset.restTransforms?.get(node)?.quaternion || node.quaternion;
    const values=new Float32Array(times.length*4);
    for(let index=0;index<times.length;index++) values.set(rest.toArray(),index*4);
    track=new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`,times,values);
    clip.tracks.push(track);
  }
  let nearest=0;for(let index=1;index<track.times.length;index++)if(Math.abs(track.times[index]-time)<Math.abs(track.times[nearest]-time))nearest=index;
  if (Math.abs(track.times[nearest]-time)>1e-4) {
    const sampled=track.createInterpolant().evaluate(time),times=Array.from(track.times),values=Array.from(track.values),size=4;
    let insert=times.findIndex(value=>value>time);if(insert<0)insert=times.length;
    times.splice(insert,0,time);values.splice(insert*size,0,...sampled);track=new THREE.QuaternionKeyframeTrack(track.name,times,values,track.getInterpolation());
    const index=insert; const euler=new THREE.Euler(...degrees.map(value=>Number(value)*Math.PI/180),'XYZ');
    new THREE.Quaternion().setFromEuler(euler).toArray(track.values,index*4);
    const trackIndex=clip.tracks.findIndex(item=>item.name===track.name);clip.tracks[trackIndex]=track;
  } else {
    const euler=new THREE.Euler(...degrees.map(value=>Number(value)*Math.PI/180),'XYZ');
    new THREE.Quaternion().setFromEuler(euler).toArray(track.values,nearest*4);
  }
  clip.resetDuration(); asset.animations[0]=clip; asset.root.animations=[clip];
  return clip;
}
export function reduceClipKeys(clip,tolerance=0.25) {
  let removed=0;
  clip.tracks=clip.tracks.map(track=>{
    if(track.times.length<=2)return track;
    const size=track.getValueSize(),isQuaternion=track instanceof THREE.QuaternionKeyframeTrack,limit=isQuaternion?tolerance*Math.PI/180:tolerance*0.001;
    const keep=Array.from({length:track.times.length},(_,index)=>index);
    for(let cursor=1;cursor<keep.length-1;){
      const before=keep[cursor-1],current=keep[cursor],after=keep[cursor+1];
      const blend=(track.times[current]-track.times[before])/(track.times[after]-track.times[before] || 1);
      let error=0;
      if(isQuaternion){
        const a=new THREE.Quaternion().fromArray(track.values.slice(before*size,before*size+4)),b=new THREE.Quaternion().fromArray(track.values.slice(after*size,after*size+4)),actual=new THREE.Quaternion().fromArray(track.values.slice(current*size,current*size+4));
        error=a.slerp(b,blend).angleTo(actual);
      }else{
        for(let component=0;component<size;component++){const predicted=track.values[before*size+component]+(track.values[after*size+component]-track.values[before*size+component])*blend;error=Math.max(error,Math.abs(predicted-track.values[current*size+component]));}
      }
      if(error<=limit){keep.splice(cursor,1);removed++;}else cursor++;
    }
    if(keep.length===track.times.length)return track;
    const times=Float32Array.from(keep.map(index=>track.times[index])),values=Float32Array.from(keep.flatMap(index=>Array.from(track.values.slice(index*size,index*size+size))));
    return new track.constructor(track.name,times,values,track.getInterpolation());
  });
  clip.resetDuration();return removed;
}
export function smoothBoneKeys(asset,clip,boneId,amount=0.35) {
  const node=asset?.bones.find(record=>record.id===boneId)?.node,track=node&&boneTrack(clip,node);
  if(!track||track.times.length<3)return 0;
  const output=track.values.slice();
  for(let index=1;index<track.times.length-1;index++){
    const before=new THREE.Quaternion().fromArray(track.values.slice((index-1)*4,(index-1)*4+4)),current=new THREE.Quaternion().fromArray(track.values.slice(index*4,index*4+4)),after=new THREE.Quaternion().fromArray(track.values.slice((index+1)*4,(index+1)*4+4));
    output.set(current.slerp(before.slerp(after,0.5),amount).toArray(),index*4);
  }
  const replacement=new THREE.QuaternionKeyframeTrack(track.name,track.times.slice(),output,track.getInterpolation());
  clip.tracks[clip.tracks.indexOf(track)]=replacement;clip.resetDuration();asset.animations[0]=clip;asset.root.animations=[clip];return track.times.length-2;
}

function cloneForExport(asset,clip) {
  restoreRestPose(asset);
  const root=SkeletonUtils.clone(asset.root), originalNodes=[], clonedNodes=[];
  asset.root.traverse(node => originalNodes.push(node)); root.traverse(node => clonedNodes.push(node));
  const uuidMap=new Map(originalNodes.map((node,index) => [node.uuid,clonedNodes[index]?.uuid]));
  const tracks=clip.tracks.map(track => {
    const separator=track.name.indexOf('.'), originalUuid=separator < 0 ? track.name : track.name.slice(0,separator), clonedUuid=uuidMap.get(originalUuid);
    if (!clonedUuid) throw new Error(`내보낼 본을 찾을 수 없습니다: ${track.name}`);
    return new track.constructor(`${clonedUuid}${track.name.slice(separator)}`,track.times,track.values,track.getInterpolation());
  });
  const clonedClip=new THREE.AnimationClip(clip.name,clip.duration,tracks); root.animations=[clonedClip];
  const scene=new THREE.Scene(); scene.add(root);
  return {scene,clip:clonedClip};
}

export async function exportFBX(asset,clip,options={}) {
  const {scene,clip:exportClip}=cloneForExport(asset,clip);
  const exporter=new FBXExporter();
  const exportOptions={preset:options.preset || 'blender',fps:options.fps || 30,animations:[exportClip],includeAnimations:true,onlyVisible:false};
  if (options.axisUp) exportOptions.axisUp=options.axisUp;
  if (Number.isFinite(options.unitScale)) exportOptions.unitScale=options.unitScale;
  return exporter.parseAsync(scene,exportOptions);
}

export async function exportGLB(asset,clip) {
  const {scene,clip:exportClip}=cloneForExport(asset,clip);
  return new GLTFExporter().parseAsync(scene,{binary:true,animations:[exportClip]});
}
