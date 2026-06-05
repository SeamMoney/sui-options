'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

type Pine3DVariant = 'surface' | 'trail' | 'bars';

type Pine3DPaneProps = {
  variant?: Pine3DVariant;
  title?: string;
  height?: number | string;
};

const VARIANT_LABELS: Record<Pine3DVariant, string> = {
  surface: 'Contour Surface',
  trail: 'Trail3D',
  bars: 'Bars3D',
};

export function Pine3DPane({ variant = 'surface', title, height = '100%' }: Pine3DPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 1000);
    camera.position.set(130, 92, 158);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(80, 140, 65);
    scene.add(key);

    const rig = new THREE.Group();
    scene.add(rig);
    buildGrid(THREE, rig);
    if (variant === 'surface') buildSurface(THREE, rig);
    if (variant === 'trail') buildTrail(THREE, rig);
    if (variant === 'bars') buildBars(THREE, rig);

    let frame = 0;
    let disposed = false;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const viewportHeight = Math.max(1, rect.height);
      renderer.setSize(width, viewportHeight, false);
      camera.aspect = width / viewportHeight;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const animate = () => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      rig.rotation.y += 0.0022;
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      renderer.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else if (material) material.dispose();
      });
      renderer.domElement.remove();
    };
  }, [variant]);

  return (
    <section
      style={{
        height,
        minHeight: 280,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,.1)',
        borderRadius: 8,
        background: '#101218',
        color: '#f5f7ff',
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <div
        style={{
          height: 38,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px',
          borderBottom: '1px solid rgba(255,255,255,.08)',
          background: 'linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.015))',
          fontSize: 13,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 999, background: '#58e6ff', boxShadow: '0 0 14px rgba(88,230,255,.75)' }} />
        <strong style={{ fontWeight: 700 }}>{title ?? VARIANT_LABELS[variant]}</strong>
        <span style={{ marginLeft: 'auto', color: '#9da7bc', fontSize: 12 }}>Pine3D</span>
      </div>
      <div ref={hostRef} style={{ position: 'relative', flex: 1, minHeight: 0 }} />
    </section>
  );
}

function buildGrid(_three: typeof THREE, rig: THREE.Group) {
  const grid = new THREE.GridHelper(220, 10, 0x566070, 0x2b303b);
  grid.position.y = -34;
  rig.add(grid);

  const box = new THREE.Box3(new THREE.Vector3(-110, -34, -110), new THREE.Vector3(110, 76, 110));
  const helper = new THREE.Box3Helper(box, new THREE.Color(0x3b4658));
  rig.add(helper);
}

function buildSurface(_three: typeof THREE, rig: THREE.Group) {
  const rows = 34;
  const cols = 34;
  const size = 180;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const low = new THREE.Color(0x1557ff);
  const mid = new THREE.Color(0x21d4a4);
  const high = new THREE.Color(0xff6a44);

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = (c / (cols - 1) - 0.5) * size;
      const z = (r / (rows - 1) - 0.5) * size;
      const d = Math.sqrt(x * x + z * z) * 0.055;
      const y = Math.cos(d) * Math.exp(-d * 0.12) * 38 + Math.sin(c * 0.42) * 8 + Math.cos(r * 0.28) * 5;
      positions.push(x, y, z);
      const t = Math.max(0, Math.min(1, (y + 48) / 96));
      const col = t < 0.5 ? low.clone().lerp(mid, t * 2) : mid.clone().lerp(high, (t - 0.5) * 2);
      colors.push(col.r, col.g, col.b);
    }
  }

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const surface = new THREE.Mesh(geometry, material);
  rig.add(surface);

  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xdde6ff, transparent: true, opacity: 0.17 }),
  );
  rig.add(wire);
}

function buildTrail(_three: typeof THREE, rig: THREE.Group) {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 180; i += 1) {
    const t = i * 0.12;
    points.push(new THREE.Vector3(Math.sin(t) * 64, i * 0.42 - 30, Math.cos(t * 0.82) * 58));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const tube = new THREE.TubeGeometry(curve, 160, 2.2, 10, false);
  const mesh = new THREE.Mesh(tube, new THREE.MeshStandardMaterial({ color: 0xffe45c, roughness: 0.35, metalness: 0.1 }));
  rig.add(mesh);

  const shadowMaterial = new THREE.LineBasicMaterial({ color: 0x42f5ff, transparent: true, opacity: 0.45 });
  const projected = points.map((p) => new THREE.Vector3(p.x, -34, p.z));
  rig.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(projected), shadowMaterial));
}

function buildBars(_three: typeof THREE, rig: THREE.Group) {
  const values = [28, 46, -22, 64, 38, -34, 72, 54, 18, -16, 42, 58];
  const low = new THREE.Color(0x2c74ff);
  const high = new THREE.Color(0xff3f72);
  values.forEach((value, i) => {
    const height = Math.abs(value);
    const geometry = new THREE.BoxGeometry(11, height, 18);
    const t = (value + 40) / 120;
    const material = new THREE.MeshStandardMaterial({ color: low.clone().lerp(high, Math.max(0, Math.min(1, t))), roughness: 0.42 });
    const bar = new THREE.Mesh(geometry, material);
    bar.position.x = (i - (values.length - 1) / 2) * 15;
    bar.position.y = value >= 0 ? -34 + height / 2 : -34 - height / 2;
    bar.position.z = Math.sin(i * 0.9) * 34;
    rig.add(bar);
  });
}
