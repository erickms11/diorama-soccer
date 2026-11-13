import * as THREE from 'three';
import './style.css';
import { DEFAULT_DIORAMA_POS, DEFAULT_DIORAMA_SCALE } from './constants';
import { MatchSimulation } from './entities';
import { StadiumDiorama } from './stadium';
import { XRAndInputManager } from './xrInput';

const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnAr = document.getElementById('btn-ar') as HTMLButtonElement;
const btnVr = document.getElementById('btn-vr') as HTMLButtonElement;
const btnReposition = document.getElementById('btn-reposition') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const xrStatusEl = document.getElementById('xr-status') as HTMLParagraphElement;
const scoreBlueEl = document.getElementById('score-blue') as HTMLElement;
const scoreRedEl = document.getElementById('score-red') as HTMLElement;
const timerEl = document.getElementById('match-timer') as HTMLElement;
const goalBannerEl = document.getElementById('goal-banner') as HTMLElement;

// 1. Renderer & Scene
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.02,
  40
);
camera.position.set(0, 1.54, 0.34);

// 2. Lighting
const hemiLight = new THREE.HemisphereLight(0xf8fafc, 0x334155, 1.15);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfffbeb, 1.75);
sunLight.position.set(1.2, 2.8, 1.4);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024, 1024);
sunLight.shadow.camera.near = 0.2;
sunLight.shadow.camera.far = 8;
const d = 2.4;
sunLight.shadow.camera.left = -d;
sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d;
sunLight.shadow.camera.bottom = -d;
scene.add(sunLight);

// Subtle room floor / table guide visible only in Desktop and VR (hidden in AR Passthrough)
const vrFloorGroup = new THREE.Group();
const gridHelper = new THREE.GridHelper(6, 24, 0x334155, 0x1e293b);
vrFloorGroup.add(gridHelper);
const tableSurface = new THREE.Mesh(
  new THREE.BoxGeometry(1.92, 0.04, 1.44),
  new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.85 })
);
tableSurface.position.set(DEFAULT_DIORAMA_POS.x, DEFAULT_DIORAMA_POS.y - 0.02, DEFAULT_DIORAMA_POS.z);
tableSurface.receiveShadow = true;
vrFloorGroup.add(tableSurface);
scene.add(vrFloorGroup);

// 3. Stadium Diorama & Match Simulation
const stadium = new StadiumDiorama();
stadium.dioramaRoot.position.set(
  DEFAULT_DIORAMA_POS.x,
  DEFAULT_DIORAMA_POS.y,
  DEFAULT_DIORAMA_POS.z
);
stadium.dioramaRoot.scale.setScalar(DEFAULT_DIORAMA_SCALE);
scene.add(stadium.dioramaRoot);

let goalBannerTimeout: number | undefined;
let match!: MatchSimulation;

function syncMatchUI(): void {
  if (!match) return;
  btnStart.textContent = match.matchStarted ? 'Novo Jogo' : 'Iniciar Jogo';
  btnPause.disabled = !match.matchStarted;
  btnPause.textContent = match.paused ? 'Continuar Jogo' : 'Pausar Jogo';
  btnPause.classList.toggle('is-paused', match.paused);

  if (match.paused) {
    goalBannerEl.textContent = 'JOGO PAUSADO';
    goalBannerEl.classList.remove('hidden');
  } else if (goalBannerEl.textContent === 'JOGO PAUSADO') {
    goalBannerEl.classList.add('hidden');
  }
}

match = new MatchSimulation(stadium.fieldRoot, {
  onScoreChange: (blue, red, timeText, statusText) => {
    scoreBlueEl.textContent = String(blue);
    scoreRedEl.textContent = String(red);
    timerEl.textContent = timeText;
    stadium.updateScoreboard(blue, red, timeText, statusText);
    syncMatchUI();
  },
  onGoal: (team) => {
    stadium.triggerGoalCelebration(2.6);
    xrInput.pulseHaptics(0.9, 180);
    goalBannerEl.textContent = team === 0 ? 'GOL DO PRETO/BRANCO!' : 'GOL DO VERDE/BRANCO!';
    goalBannerEl.classList.remove('hidden');
    window.clearTimeout(goalBannerTimeout);
    goalBannerTimeout = window.setTimeout(() => {
      goalBannerEl.classList.add('hidden');
    }, 2400);
  },
  onKick: (power) => {
    xrInput.pulseHaptics(0.25 + power * 0.45, 45);
  },
});
syncMatchUI();

// 4. XR & Desktop Input Manager
const xrInput = new XRAndInputManager(renderer, scene, camera, stadium, {
  onModeChange: (mode) => {
    vrFloorGroup.visible = mode !== 'ar';
    if (mode === 'desktop') {
      xrStatusEl.textContent = 'Modo Desktop ativo. No Quest 3, use os botões verdes acima.';
    }
  },
  onPlacementChange: (placing) => {
    btnReposition.textContent = placing ? 'Confirmar Posição (Gatilho)' : 'Reposicionar Estádio';
  },
  onStartRequested: () => {
    match.startMatch();
    syncMatchUI();
  },
  onPauseToggleRequested: () => {
    match.togglePause();
    syncMatchUI();
  },
  onResetRequested: () => {
    match.resetMatch();
    syncMatchUI();
  },
  onStatusMessage: (msg) => {
    xrStatusEl.textContent = msg;
  },
});

// 5. Check WebXR Support
async function initWebXRButtons(): Promise<void> {
  if (!('xr' in navigator) || !navigator.xr) {
    xrStatusEl.textContent =
      'WebXR não detectado neste navegador (modo Desktop ativo). Abra este link HTTPS no Meta Quest Browser.';
    return;
  }

  try {
    const [arSupported, vrSupported] = await Promise.all([
      navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
      navigator.xr.isSessionSupported('immersive-vr').catch(() => false),
    ]);

    btnAr.disabled = !arSupported;
    btnVr.disabled = !vrSupported;

    if (arSupported && vrSupported) {
      xrStatusEl.textContent = 'Meta Quest WebXR pronto! Escolha Mixed Reality (Passthrough) ou VR.';
    } else if (vrSupported) {
      xrStatusEl.textContent = 'Modo VR suportado neste dispositivo.';
    } else {
      xrStatusEl.textContent =
        'Modo Desktop ativo. Abra este endereço HTTPS no Meta Quest 3 para Mixed Reality.';
    }
  } catch {
    xrStatusEl.textContent = 'Modo Desktop ativo (falha ao consultar WebXR).';
  }
}

void initWebXRButtons();

btnStart.addEventListener('click', () => {
  match.startMatch();
  syncMatchUI();
  btnStart.blur();
});
btnPause.addEventListener('click', () => {
  match.togglePause();
  syncMatchUI();
  btnPause.blur();
});
btnAr.addEventListener('click', () => {
  void xrInput.startSession('ar');
  btnAr.blur();
});
btnVr.addEventListener('click', () => {
  void xrInput.startSession('vr');
  btnVr.blur();
});
btnReposition.addEventListener('click', () => {
  xrInput.setPlacementMode(!xrInput.placementMode);
  btnReposition.blur();
});
btnReset.addEventListener('click', () => {
  match.resetMatch();
  syncMatchUI();
  btnReset.blur();
});

// 6. Resize & Main Animation Loop
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let lastTime = performance.now();
const camWorldPos = new THREE.Vector3();

renderer.setAnimationLoop((now, frame) => {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  const elapsed = now / 1000;

  const input = xrInput.update(dt, frame);
  xrInput.getCameraWorldPosition(camWorldPos);

  match.update(dt, elapsed, input, camWorldPos);
  stadium.update(dt, elapsed);

  renderer.render(scene, camera);
});

