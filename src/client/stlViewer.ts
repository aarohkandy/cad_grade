import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const GEOMETRY_CACHE_LIMIT = 24;
const EDGE_VERTEX_LIMIT = 70000;
const geometryCache = new Map<string, Promise<THREE.BufferGeometry>>();
const stlLoader = new STLLoader();

async function cachedGeometry(stlUrl: string): Promise<THREE.BufferGeometry> {
  const existing = geometryCache.get(stlUrl);
  if (existing) {
    geometryCache.delete(stlUrl);
    geometryCache.set(stlUrl, existing);
    return (await existing).clone();
  }

  const loading = stlLoader.loadAsync(stlUrl).then((geometry) => {
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  });
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

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
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
        color: 0x83d49a,
        roughness: 0.46,
        metalness: 0.07,
      }),
    );
    mesh.name = label;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.addEdges(mesh);
    this.clearRoot();
    this.root.add(mesh);
    this.root.rotation.set(0, 0, 0);
    this.fitCamera();
    this.requestRender(800);
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

  private addEdges(mesh: THREE.Mesh): void {
    if (!mesh.geometry.attributes.position || mesh.geometry.attributes.position.count > EDGE_VERTEX_LIMIT) return;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 28),
      new THREE.LineBasicMaterial({
        color: 0x17251d,
        transparent: true,
        opacity: 0.42,
      }),
    );
    mesh.add(edges);
  }

  private fitCamera(): void {
    const box = new THREE.Box3().setFromObject(this.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const distance = (maxDim / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * 1.18;
    this.camera.position.set(center.x + distance * 0.22, center.y - distance * 0.72, center.z + distance * 1.48);
    this.camera.near = Math.max(distance / 120, 0.1);
    this.camera.far = distance * 24;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(center.x, center.y, center.z);
    this.controls.update();

    const floor = this.scene.getObjectByName("floor-grid");
    if (floor) floor.position.set(center.x, center.y, box.min.z - 0.5);
  }
}
