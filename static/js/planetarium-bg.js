/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Hanging Orrery — White Minimalist Toy Solar System         ║
 * ║  Three.js WebGL · Suspended planetarium mobile              ║
 * ║  Reference: Veo-style white-on-white orrery render          ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
(function () {
  'use strict';

  const canvas = document.getElementById('webgl-bg');
  if (!canvas) return;

  /* ═══ RENDERER ═══ */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  /* ═══ SCENE ═══ */
  const scene = new THREE.Scene();

  /* ═══ CAMERA ═══ */
  const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 5000);
  camera.position.set(0, 120, 900);
  camera.lookAt(0, -20, 0);

  /* ═══ LIGHTING ═══ */
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  const keyLight = new THREE.DirectionalLight(0xffffff, 0.5);
  keyLight.position.set(200, 400, 300);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 2000;
  keyLight.shadow.camera.left = -600;
  keyLight.shadow.camera.right = 600;
  keyLight.shadow.camera.top = 600;
  keyLight.shadow.camera.bottom = -600;
  keyLight.shadow.bias = -0.0003;
  scene.add(keyLight);

  scene.add((() => { const l = new THREE.DirectionalLight(0xf0f0ff, 0.2); l.position.set(-200, 100, -150); return l; })());
  scene.add((() => { const l = new THREE.DirectionalLight(0xffffff, 0.1); l.position.set(0, -100, -200); return l; })());

  /* ═══ MATERIALS ═══ */
  const matWhite = new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.3, metalness: 0.0 });
  const matCool = new THREE.MeshStandardMaterial({ color: 0xeef0f4, roughness: 0.25, metalness: 0.03 });
  const matWarm = new THREE.MeshStandardMaterial({ color: 0xf8f4ec, roughness: 0.35, metalness: 0.0 });
  const matGlass = new THREE.MeshPhysicalMaterial({ color: 0xfafafa, roughness: 0.05, metalness: 0.0, transmission: 0.3, thickness: 1.5, clearcoat: 1.0 });
  const matWire = new THREE.LineBasicMaterial({ color: 0xc5c5c0, linewidth: 1 });
  const matString = new THREE.LineBasicMaterial({ color: 0xc0c0bc, linewidth: 1 });
  const matOrbitRing = new THREE.LineBasicMaterial({ color: 0xd0d0cc, transparent: true, opacity: 0.5 });
  const matSaturnRing = new THREE.MeshStandardMaterial({ color: 0xeae8e2, roughness: 0.2, metalness: 0.0, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  const matMoon = new THREE.MeshStandardMaterial({ color: 0xf0f0ed, roughness: 0.4, metalness: 0.0 });

  /* ═══ SUN GLOW MATERIAL ═══ */
  const sunMat = new THREE.MeshStandardMaterial({ color: 0xfffef5, roughness: 0.5, metalness: 0.0, emissive: 0xfffef5, emissiveIntensity: 0.35 });

  /* ═══ GEOMETRY HELPERS ═══ */

  // Hanging string (thin line from y=0 going up by 'len')
  function mkHangString(len) {
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, len, 0)];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, matString);
  }

  // Orbit ring (elliptical, tilted)
  function mkOrbitEllipse(rx, rz, tiltX, tiltZ, segments) {
    segments = segments || 128;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * rx, 0, Math.sin(a) * rz));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, matOrbitRing);
    line.rotation.x = tiltX || 0;
    line.rotation.z = tiltZ || 0;
    return line;
  }

  // Smooth planet
  function mkPlanet(r, mat) {
    const geo = new THREE.SphereGeometry(r, 64, 48);
    const m = new THREE.Mesh(geo, mat || matWhite);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // Low-poly / geodesic planet (icosahedron)
  function mkGeoPlanet(r, detail, mat) {
    const geo = new THREE.IcosahedronGeometry(r, detail || 1);
    const m = new THREE.Mesh(geo, mat || matCool);
    m.castShadow = true;
    return m;
  }

  // Wireframe-textured planet (sphere with wireframe overlay)
  function mkWireframePlanet(r, mat) {
    const grp = new THREE.Group();
    // Solid sphere
    const solid = mkPlanet(r, mat || matWarm);
    grp.add(solid);
    // Wireframe overlay
    const wfGeo = new THREE.SphereGeometry(r * 1.005, 24, 16);
    const wfMat = new THREE.MeshBasicMaterial({ color: 0xd8d8d3, wireframe: true, transparent: true, opacity: 0.3 });
    const wf = new THREE.Mesh(wfGeo, wfMat);
    grp.add(wf);
    return grp;
  }

  // Saturn-like planet with concentric rings
  function mkSaturnPlanet(bodyR, ringInner, ringOuter, mat) {
    const grp = new THREE.Group();
    // Body — smooth with subtle banding via slight squish
    const bodyGeo = new THREE.SphereGeometry(bodyR, 64, 48);
    const body = new THREE.Mesh(bodyGeo, mat || matWhite);
    body.scale.y = 0.85; // oblate
    body.castShadow = true;
    body.receiveShadow = true;
    grp.add(body);

    // Multi-ring system (3 concentric rings for detail)
    const ringCount = 4;
    for (let i = 0; i < ringCount; i++) {
      const inner = ringInner + (ringOuter - ringInner) * (i / ringCount);
      const outer = ringInner + (ringOuter - ringInner) * ((i + 1) / ringCount) - 0.3;
      const rGeo = new THREE.RingGeometry(inner, outer, 96);
      const rMat = matSaturnRing.clone();
      rMat.opacity = 0.6 + Math.random() * 0.25;
      const ring = new THREE.Mesh(rGeo, rMat);
      ring.rotation.x = -Math.PI / 2;
      ring.castShadow = true;
      grp.add(ring);
    }
    return grp;
  }

  // Scatter small moons along an orbit path
  function mkOrbitMoons(rx, rz, count, moonR) {
    const grp = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const m = new THREE.Mesh(new THREE.SphereGeometry(moonR || 2, 12, 8), matMoon);
      m.position.set(Math.cos(a) * rx, (Math.random() - 0.5) * 4, Math.sin(a) * rz);
      m.castShadow = true;
      grp.add(m);
    }
    return grp;
  }

  /* ═══════════════════════════════════════════
     BUILD THE ORRERY
  ═══════════════════════════════════════════ */
  const orrery = new THREE.Group();

  // ── CENTRAL SUN — glowing dot-textured sphere ──
  const sunGroup = new THREE.Group();

  // Sun core
  const sun = mkPlanet(55, sunMat);
  sunGroup.add(sun);

  // Sun particle/dot texture overlay (tiny points on surface)
  const sunDotsCount = 3000;
  const sunDotsPos = new Float32Array(sunDotsCount * 3);
  for (let i = 0; i < sunDotsCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 56;
    sunDotsPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    sunDotsPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    sunDotsPos[i * 3 + 2] = r * Math.cos(phi);
  }
  const sunDotsGeo = new THREE.BufferGeometry();
  sunDotsGeo.setAttribute('position', new THREE.BufferAttribute(sunDotsPos, 3));
  const sunDotsMat = new THREE.PointsMaterial({ color: 0xe8e4d8, size: 1.2, transparent: true, opacity: 0.5, sizeAttenuation: true });
  sunGroup.add(new THREE.Points(sunDotsGeo, sunDotsMat));

  // Sun glow sprite
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 256;
  const gCtx = glowCanvas.getContext('2d');
  const grad = gCtx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,245,0.4)');
  grad.addColorStop(0.3, 'rgba(255,255,240,0.15)');
  grad.addColorStop(1, 'rgba(255,255,240,0)');
  gCtx.fillStyle = grad;
  gCtx.fillRect(0, 0, 256, 256);
  const glowTex = new THREE.CanvasTexture(glowCanvas);
  const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.7, depthWrite: false }));
  glowSprite.scale.set(220, 220, 1);
  sunGroup.add(glowSprite);

  // Point light at sun
  const sunLight = new THREE.PointLight(0xfff8e8, 0.3, 600, 2);
  sunGroup.add(sunLight);

  orrery.add(sunGroup);

  // ── CENTRAL VERTICAL ROD (string from sun down to base) ──
  const centralRod = mkHangString(-180);
  centralRod.position.y = -55;
  orrery.add(centralRod);

  // Small base/stand at bottom
  const baseGeo = new THREE.CylinderGeometry(8, 12, 3, 32);
  const base = new THREE.Mesh(baseGeo, matWhite);
  base.position.y = -235;
  base.castShadow = true;
  orrery.add(base);

  // ── HANGING STRINGS FROM CEILING ──
  // Sun center string
  const sunString = mkHangString(400);
  sunString.position.y = 0;
  orrery.add(sunString);

  // ── ORBIT RINGS (concentric tilted ellipses) ──
  const orbit1 = mkOrbitEllipse(160, 140, 0.15, 0.05);
  const orbit2 = mkOrbitEllipse(260, 230, 0.12, -0.03);
  const orbit3 = mkOrbitEllipse(370, 320, 0.08, 0.04);
  const orbit4 = mkOrbitEllipse(460, 400, 0.1, -0.02);
  orrery.add(orbit1, orbit2, orbit3, orbit4);

  // ── ORBIT DEBRIS — small moons scattered along orbit paths ──
  const debris1 = mkOrbitMoons(160, 140, 8, 1.5);
  debris1.rotation.x = 0.15;
  orrery.add(debris1);

  const debris2 = mkOrbitMoons(260, 230, 12, 2);
  debris2.rotation.x = 0.12;
  orrery.add(debris2);

  const debris3 = mkOrbitMoons(370, 320, 10, 2.2);
  debris3.rotation.x = 0.08;
  orrery.add(debris3);

  const debris4 = mkOrbitMoons(460, 400, 8, 1.8);
  debris4.rotation.x = 0.1;
  orrery.add(debris4);

  /* ═══ PLANETS — each hanging from its own string ═══ */

  // Planet config: { name, create, radius, orbitRx, orbitRz, angle, stringLen, y }
  const planets = [];

  function addPlanet(createFn, orbitRx, orbitRz, angle, stringLen, yOffset) {
    const grp = new THREE.Group();
    // Horizontal position on orbit
    const x = Math.cos(angle) * orbitRx;
    const z = Math.sin(angle) * orbitRz;
    grp.position.set(x, yOffset || 0, z);

    // Hanging string going up to ceiling
    const str = mkHangString(stringLen);
    grp.add(str);

    // Planet at bottom
    const planet = createFn();
    grp.add(planet);

    orrery.add(grp);
    planets.push({ group: grp, planet: planet, angle: angle });
    return planet;
  }

  // ── Planet 1: Geodesic/faceted planet (orbit 1, upper-left area) ──
  const p1 = addPlanet(
    () => mkGeoPlanet(30, 1, matCool),
    160, 140, Math.PI * 0.7, 350, 10
  );

  // ── Planet 2: Large Saturn (orbit 2-3, front-bottom) ──
  const saturn = addPlanet(
    () => {
      const s = mkSaturnPlanet(40, 55, 82, matWhite);
      s.rotation.z = 0.2;
      s.rotation.x = 0.15;
      return s;
    },
    310, 270, Math.PI * 1.3, 300, -30
  );

  // ── Planet 3: Small smooth planet with ring (orbit 1, upper-right) ──
  const p3 = addPlanet(
    () => {
      const grp = new THREE.Group();
      grp.add(mkPlanet(15, matWhite));
      const ringGeo = new THREE.RingGeometry(20, 28, 64);
      const ring = new THREE.Mesh(ringGeo, matSaturnRing.clone());
      ring.rotation.x = -Math.PI * 0.45;
      ring.material.opacity = 0.6;
      grp.add(ring);
      return grp;
    },
    180, 160, Math.PI * -0.3, 320, 20
  );

  // ── Planet 4: Large smooth sphere (orbit 3, right side) ──
  const p4 = addPlanet(
    () => mkPlanet(35, matGlass),
    400, 350, Math.PI * -0.15, 280, -5
  );

  // ── Planet 5: Wireframe-textured sphere (orbit 2, bottom-right) ──
  const p5 = addPlanet(
    () => mkWireframePlanet(20, matWarm),
    280, 250, Math.PI * 0.1, 310, -15
  );

  // ── Planet 6: Small smooth sphere with own orbit ring (orbit 4, far right) ──
  const p6 = addPlanet(
    () => {
      const grp = new THREE.Group();
      grp.add(mkPlanet(22, matCool));
      const orbRing = mkOrbitEllipse(35, 35, 0.3, 0);
      grp.add(orbRing);
      return grp;
    },
    450, 390, Math.PI * -0.5, 290, 5
  );

  // ── Planet 7: Tiny sphere (orbit 4, left) ──
  addPlanet(
    () => mkPlanet(10, matMoon),
    420, 370, Math.PI * 0.95, 340, 15
  );

  scene.add(orrery);

  /* ═══ SCROLL-LINKED CAMERA ═══ */
  gsap.registerPlugin(ScrollTrigger);
  const scrub = { trigger: 'body', start: 'top top', end: 'bottom bottom', scrub: 1.5 };
  gsap.to(camera.position, { y: -100, z: 750, ease: 'none', scrollTrigger: scrub });

  /* ═══ RESIZE ═══ */
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ═══ ANIMATION LOOP ═══ */
  const clock = new THREE.Clock();

  (function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // Whole orrery: slow majestic rotation
    orrery.rotation.y += 0.0008;

    // Sun: subtle rotation
    sun.rotation.y += 0.002;

    // Sun glow pulse
    glowSprite.material.opacity = 0.55 + Math.sin(t * 0.8) * 0.15;

    // Planet self-rotations
    planets.forEach((p, i) => {
      if (p.planet.rotation) p.planet.rotation.y += 0.003 + i * 0.001;
    });

    // Orbit debris: slow counter-rotation for depth
    debris1.rotation.y -= 0.0003;
    debris2.rotation.y += 0.0002;
    debris3.rotation.y -= 0.00015;
    debris4.rotation.y += 0.00025;

    // Gentle camera drift
    const dx = Math.sin(t * 0.08) * 30;
    camera.position.x += (dx - camera.position.x) * 0.006;

    renderer.render(scene, camera);
  })();

  /* ═══ THEME (no-op, forced light) ═══ */
  window.updateParticleTheme = function () {};

})();
