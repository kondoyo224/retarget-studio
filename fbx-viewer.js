import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let activeView = null;

function bonePath(bone) {
  const parts = []; let current = bone;
  while (current) { if (current.isBone) parts.unshift(current.name || 'Bone'); current = current.parent; }
  return parts.join('/');
}

export async function parseFBX(file) {
  const root = new FBXLoader().parse(await file.arrayBuffer(),'');
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
  return {root,bones,animations:root.animations || [],fileName:file.name};
}

export function animationStats(asset, clipIndex = 0) {
  const clip = asset?.animations?.[clipIndex];
  if (!clip) return {fps:30,frameCount:1,duration:0};
  const fps = 30;
  return {fps,frameCount:Math.max(1,Math.ceil(clip.duration * fps) + 1),duration:clip.duration};
}

export function mount(container, asset) {
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
  const clip = asset.animations[0] || null;
  if (mixer && clip) mixer.clipAction(clip).play();
  function resize() {
    const width = Math.max(1,container.clientWidth), height = Math.max(1,container.clientHeight);
    renderer.setSize(width,height,false); camera.aspect = width / height; camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene,camera); });
  activeView = {
    asset,
    setFrame(frame,fps = 30) { if (mixer) mixer.setTime(Math.max(0,Number(frame) / fps)); },
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
