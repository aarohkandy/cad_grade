import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { EMPTY_STL_ERROR } from "./stlParse";

const GEOMETRY_CACHE_LIMIT = 24;
const EDGE_VERTEX_LIMIT = 150000;
// The worker fetches the model as well as parsing it, and the largest STL in the dataset is
// 3.6 MB, so this has to cover a slow phone downloading one. Twice the 30s the browser specs
// allow for a model to appear.
const WORKER_REQUEST_TIMEOUT_MS = 60_000;
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
    timer: ReturnType<typeof setTimeout>;
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

// The worker awaits its fetch, so it handles a second message while the first is still in
// flight: requests overlap rather than queue. A deadline therefore belongs to one request
// and not to whatever else happens to be on the worker at the time.
function timeOutRequest(id: number): void {
  const request = workerRequests.get(id);
  if (!request) return;
  workerRequests.delete(id);
  clearTimeout(request.timer);
  request.reject(new Error(`STL worker did not answer within ${WORKER_REQUEST_TIMEOUT_MS / 1000}s`));
  // A worker that missed a deadline is wedged, and terminating is the only way to reclaim
  // it. Waiting until it is idle keeps that from cancelling a load that still has time on
  // its own clock; those requests will arrive here in turn if the worker really is stuck.
  if (workerRequests.size === 0) {
    worker?.terminate();
    worker = null;
  }
}

// A worker that died takes every request on it down, so these get failed together: nothing
// is going to answer them and the arena would sit in its loading state with no error and
// no retry. Dropping the handle makes the next load build a fresh worker.
function failPendingRequests(reason: string): void {
  worker?.terminate();
  worker = null;
  const pending = [...workerRequests.values()];
  workerRequests.clear();
  for (const request of pending) {
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
}

function createWorker(): Worker {
  const created = new Worker(new URL("./stlParseWorker.ts", import.meta.url), { type: "module" });
  created.onmessage = (
    event: MessageEvent<{
      id: number;
      positions?: Float32Array;
      normals?: Float32Array;
      error?: string;
    }>,
  ) => {
    const request = workerRequests.get(event.data.id);
    if (!request) return;
    workerRequests.delete(event.data.id);
    clearTimeout(request.timer);
    if (event.data.error || !event.data.positions || !event.data.normals) {
      request.reject(new Error(event.data.error || "STL parse failed"));
      return;
    }
    request.resolve(geometryFromArrays(event.data.positions, event.data.normals));
  };
  created.onerror = () => failPendingRequests("STL worker failed to run");
  created.onmessageerror = () => failPendingRequests("STL worker sent an unreadable message");
  return created;
}

function parseInWorker(stlUrl: string): Promise<THREE.BufferGeometry> | null {
  if (typeof Worker === "undefined") return null;
  const target = (worker ||= createWorker());

  return new Promise((resolve, reject) => {
    const id = workerRequestId++;
    // onerror only fires for a worker that died. One that is alive and silent has to be
    // given up on from this side.
    const timer = setTimeout(() => timeOutRequest(id), WORKER_REQUEST_TIMEOUT_MS);
    workerRequests.set(id, { resolve, reject, timer });
    target.postMessage({ id, url: stlUrl });
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
  // Three's loader accepts a header claiming zero faces and hands back an empty mesh,
  // so the fallback needs the same guard the worker parser has.
  if (!geometry.attributes.position?.count) {
    geometry.dispose();
    throw new Error(EMPTY_STL_ERROR);
  }
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
  void loading.then(
    () => {
      while (geometryCache.size > GEOMETRY_CACHE_LIMIT) {
        const oldest = geometryCache.entries().next().value as [string, Promise<THREE.BufferGeometry>] | undefined;
        if (!oldest) break;
        geometryCache.delete(oldest[0]);
        oldest[1].then((geometry) => geometry.dispose()).catch(() => undefined);
      }
    },
    // Keeping the rejected promise would blacklist the URL for the life of the page:
    // the retry in main.ts re-throws the cached failure without touching the network.
    () => {
      if (geometryCache.get(stlUrl) === loading) geometryCache.delete(stlUrl);
    },
  );
  return (await loading).clone();
}

// For tests. The module keeps one worker for the life of the page, which is right in a
// browser and wrong in a suite: a test that stubs Worker otherwise hands its stub to
// whichever test runs next, and the file only passes in the order it was written.
export function resetStlWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  for (const request of workerRequests.values()) clearTimeout(request.timer);
  workerRequests.clear();
}

export function preloadStlGeometry(stlUrl: string): void {
  void cachedGeometry(stlUrl)
    .then((geometry) => geometry.dispose())
    .catch(() => undefined);
}

export class StlViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  private controls: OrbitControls;
  private root = new THREE.Group();
  private grid: THREE.GridHelper;
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
    // Two of these run side by side on whatever phone the voter has. Three lights and the
    // edge overlay carry the shape, so nothing here pays for a shadow pass.
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
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9bdcff, 0.85);
    fill.position.set(-130, 80, 120);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xdff38e, 0.7);
    rim.position.set(-120, -90, 160);
    this.scene.add(rim);

    this.grid = new THREE.GridHelper(180, 18, 0x86a894, 0x355247);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);

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
    this.grid.dispose();
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

    this.grid.position.set(center.x, center.y, box.min.z - 0.5);
  }
}
