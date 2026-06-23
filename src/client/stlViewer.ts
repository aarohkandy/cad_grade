import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const GEOMETRY_CACHE_LIMIT = 24;
const EDGE_VERTEX_LIMIT = 150000;
const geometryCache = new Map<string, Promise<THREE.BufferGeometry>>();
const stlLoader = new STLLoader();
let worker: Worker | null = null;
let workerRequestId = 0;
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};
const workerRequests = new Map<
  number,
  {
    resolve: (geometry: THREE.BufferGeometry) => void;
    reject: (error: Error) => void;
  }
>();

function geometryFromArrays(positions: Float32Array, normals: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals.length === positions.length) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();
  return geometry;
}

function parseInWorker(stlUrl: string): Promise<THREE.BufferGeometry> | null {
  if (typeof Worker === "undefined") return null;
  worker ||= new Worker(new URL("./stlParseWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage ||= (event: MessageEvent<{
    id: number;
    positions?: Float32Array;
    normals?: Float32Array;
    error?: string;
  }>) => {
    const request = workerRequests.get(event.data.id);
    if (!request) return;
    workerRequests.delete(event.data.id);
    if (event.data.error || !event.data.positions || !event.data.normals) {
      request.reject(new Error(event.data.error || "STL parse failed"));
      return;
    }
    request.resolve(geometryFromArrays(event.data.positions, event.data.normals));
  };

  return new Promise((resolve, reject) => {
    const id = workerRequestId++;
    workerRequests.set(id, { resolve, reject });
    worker?.postMessage({ id, url: stlUrl });
  });
}

async function loadGeometry(stlUrl: string): Promise<THREE.BufferGeometry> {
  try {
    const workerGeometry = await parseInWorker(stlUrl);
    if (workerGeometry) return workerGeometry;
  } catch {
    // Fall back to Three's loader if a browser blocks module workers.
  }
  const geometry = await stlLoader.loadAsync(stlUrl);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

async function cachedGeometry(stlUrl: string): Promise<THREE.BufferGeometry> {
  const existing = geometryCache.get(stlUrl);
  if (existing) {
    geometryCache.delete(stlUrl);
    geometryCache.set(stlUrl, existing);
    return (await existing).clone();
  }

  const loading = loadGeometry(stlUrl);
  geometryCache.set(stlUrl, loading);
  void loading.then(() => {
    while (geometryCache.size > GEOMETRY_CACHE_LIMIT) {
      const oldest = geometryCache.entries().next().value as [string, Promise<THREE.BufferGeometry>] | undefined;
      if (!oldest) break;
      geometryCache.delete(oldest[0]);
      oldest[1].then((geometry) => geometry.dispose()).catch(() => undefined);
    }
  });
  return (await loading).clone();
}

export function preloadStlGeometry(stlUrl: string): void {
  void cachedGeometry(stlUrl).then((geometry) => geometry.dispose()).catch(() => undefined);
}

export class StlViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  private controls: OrbitControls;
  private root = new THREE.Group();
  private frame = 0;
  private needsRender = true;
  private activeUntil = 0;
  private disposed = false;
  private edgeTask: { type: "idle" | "timeout"; id: number } | null = null;
  private edgeGeneration = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x0d201b, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = false;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotate = false;
    this.controls.addEventListener("change", this.scheduleRender);
    this.canvas.addEventListener("pointerdown", this.beginInteraction);
    this.canvas.addEventListener("wheel", this.beginInteraction, { passive: true });

    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xeafff4, 0x25382d, 1.1));

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(120, -150, 160);
    key.castShadow = true;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9bdcff, 0.85);
    fill.position.set(-130, 80, 120);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xdff38e, 0.7);
    rim.position.set(-120, -90, 160);
    this.scene.add(rim);

    const grid = new THREE.GridHelper(180, 18, 0x86a894, 0x355247);
    grid.rotation.x = Math.PI / 2;
    grid.name = "floor-grid";
    this.scene.add(grid);

    window.addEventListener("resize", this.resize);
    this.resize();
    this.requestRender(500);
  }

  async load(stlUrl: string, label: string): Promise<void> {
    const geometry = await cachedGeometry(stlUrl);
    if (this.disposed) {
      geometry.dispose();
      return;
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x9acaa2,
        roughness: 0.58,
        metalness: 0.03,
      }),
    );
    mesh.name = label;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.clearRoot();
    this.root.add(mesh);
    this.root.rotation.set(0, 0, 0);
    this.fitCamera();
    this.requestRender(500);
    this.scheduleEdges(mesh);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("resize", this.resize);
    this.controls.removeEventListener("change", this.scheduleRender);
    this.canvas.removeEventListener("pointerdown", this.beginInteraction);
    this.canvas.removeEventListener("wheel", this.beginInteraction);
    cancelAnimationFrame(this.frame);
    this.clearRoot();
    this.controls.dispose();
    this.renderer.dispose();
  }

  private resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender(500);
  };

  private scheduleRender = (): void => {
    this.requestRender(450);
  };

  private beginInteraction = (): void => {
    this.requestRender(1400);
  };

  private requestRender(durationMs = 0): void {
    if (this.disposed) return;
    this.needsRender = true;
    if (durationMs > 0) this.activeUntil = Math.max(this.activeUntil, performance.now() + durationMs);
    if (!this.frame) this.frame = requestAnimationFrame(this.animate);
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.frame = 0;
    const changed = this.controls.update();
    if (this.needsRender || changed) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
    if (changed || performance.now() < this.activeUntil) {
      this.frame = requestAnimationFrame(this.animate);
    }
  };

  private clearRoot(): void {
    this.cancelPendingEdges();
    while (this.root.children.length) {
      const child = this.root.children.pop();
      child?.traverse((node) => {
        const mesh = node as THREE.Mesh;
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => material.dispose());
        } else {
          mesh.material?.dispose();
        }
      });
    }
  }

  private cancelPendingEdges(): void {
    this.edgeGeneration += 1;
    if (!this.edgeTask) return;
    const win = window as IdleWindow;
    if (this.edgeTask.type === "idle") {
      win.cancelIdleCallback?.(this.edgeTask.id);
    } else {
      window.clearTimeout(this.edgeTask.id);
    }
    this.edgeTask = null;
  }

  private scheduleEdges(mesh: THREE.Mesh): void {
    if (!mesh.geometry.attributes.position || mesh.geometry.attributes.position.count > EDGE_VERTEX_LIMIT) return;
    const generation = this.edgeGeneration;
    const run = (): void => {
      this.edgeTask = null;
      if (this.disposed || generation !== this.edgeGeneration || !this.root.children.includes(mesh)) return;
      this.addEdges(mesh);
      this.requestRender(400);
    };
    const win = window as IdleWindow;
    if (win.requestIdleCallback) {
      this.edgeTask = { type: "idle", id: win.requestIdleCallback(run, { timeout: 700 }) };
    } else {
      this.edgeTask = { type: "timeout", id: window.setTimeout(run, 90) };
    }
  }

  private addEdges(mesh: THREE.Mesh): void {
    if (!mesh.geometry.attributes.position || mesh.geometry.attributes.position.count > EDGE_VERTEX_LIMIT) return;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 28),
      new THREE.LineBasicMaterial({
        color: 0x17251d,
        transparent: true,
        opacity: 0.3,
      }),
    );
    mesh.add(edges);
  }

  private fitCamera(): void {
    const box = new THREE.Box3().setFromObject(this.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const distance = (maxDim / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * 1.34;
    this.camera.position.set(center.x + distance * 0.24, center.y - distance * 0.78, center.z + distance * 1.5);
    this.camera.near = Math.max(distance / 120, 0.1);
    this.camera.far = distance * 24;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(center.x, center.y, center.z);
    this.controls.update();

    const floor = this.scene.getObjectByName("floor-grid");
    if (floor) floor.position.set(center.x, center.y, box.min.z - 0.5);
  }
}
