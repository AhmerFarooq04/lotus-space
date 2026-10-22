import {
  Component,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import './App.css'

const MODEL_URL = '/models/lotus-working.glb'

class SceneErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="error-message" role="alert">
          Could not load the 3D scene. Check that lotus-working.glb
          is inside public/models, then refresh.
        </div>
      )
    }

    return this.props.children
  }
}

function TopDownCamera() {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)

  useLayoutEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return

    camera.position.set(0, 12, 0)

    // Looking down the Y axis, with north toward negative Z.
    camera.up.set(0, 0, -1)
    camera.lookAt(0, 0, 0)

    // The normalized flower spans about half the shorter dimension.
    camera.zoom = Math.min(size.width, size.height) / 8
    camera.updateProjectionMatrix()
  }, [camera, size.width, size.height])

  return null
}

function Lotus({ progress }: { progress: number }) {
  const { scene, animations } = useGLTF(MODEL_URL)
  const displayedProgress = useRef(0)

  const model = useMemo(() => {
    const root = scene.clone(true)
    const mixer = new THREE.AnimationMixer(root)

    // Each exported clip controls a different part of the lotus.
    // Combine their tracks so one action controls the whole bloom.
    const tracks = animations.flatMap((clip) =>
      clip.tracks.map((track) => track.clone()),
    )

    if (tracks.length === 0) {
      throw new Error('The model contains no animation tracks.')
    }

    const clip = new THREE.AnimationClip('LotusBloom', -1, tracks)
    const action = mixer.clipAction(clip)

    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.play()
    action.paused = true

    // Measure at full bloom so framing stays fixed while opening.
    action.time = clip.duration
    mixer.update(0)
    root.updateMatrixWorld(true)

    const bounds = new THREE.Box3().setFromObject(root, true)
    const center = bounds.getCenter(new THREE.Vector3())
    const size = bounds.getSize(new THREE.Vector3())

    // glTF uses Y-up, so X/Z describe the top-down footprint.
    const diameter = Math.max(size.x, size.z, 0.001)
    const scale = 4 / diameter

    action.time = 0
    mixer.update(0)

    return { root, mixer, action, duration: clip.duration, center, scale }
  }, [scene, animations])

  useLayoutEffect(() => {
    displayedProgress.current = 0
    model.action.reset().play()
    model.action.paused = true
    model.mixer.update(0)

    return () => {
      model.mixer.stopAllAction()
    }
  }, [model])

  useFrame((_, delta) => {
    displayedProgress.current = THREE.MathUtils.damp(
      displayedProgress.current,
      progress,
      7,
      Math.min(delta, 0.1),
    )

    if (Math.abs(displayedProgress.current - progress) < 0.0001) {
      displayedProgress.current = progress
    }

    // Sample a precise pose instead of playing a looping animation.
    model.action.time = displayedProgress.current * model.duration
    model.mixer.update(0)
  })

  return (
    <group scale={model.scale}>
      <group
        position={[
          -model.center.x,
          -model.center.y,
          -model.center.z,
        ]}
      >
        <primitive object={model.root} dispose={null} />
      </group>
    </group>
  )
}

function LoadingMessage() {
  return (
    <Html center>
      <div className="loading-message">Loading your lotus…</div>
    </Html>
  )
}

export default function App() {
  const [progress, setProgress] = useState(0)
  const [controlsVisible, setControlsVisible] = useState(true)

  return (
    <main className="app">
      <SceneErrorBoundary>
        <Canvas
          orthographic
          camera={{
            position: [0, 12, 0],
            near: 0.1,
            far: 100,
            zoom: 80,
          }}
          dpr={[1, 1.5]}
          gl={{ antialias: true, alpha: false }}
        >
          <color attach="background" args={['#000000']} />

          <TopDownCamera />

          <ambientLight intensity={0.65} />
          <directionalLight
            position={[4, 8, 3]}
            intensity={2.5}
            color="#fff4ff"
          />
          <directionalLight
            position={[-4, 5, -3]}
            intensity={1.5}
            color="#bfa5ff"
          />

          <Suspense fallback={<LoadingMessage />}>
            <Lotus progress={progress} />
          </Suspense>
        </Canvas>
      </SceneErrorBoundary>

      <button
        className="view-toggle"
        onClick={() => setControlsVisible((visible) => !visible)}
        aria-expanded={controlsVisible}
        aria-controls="bloom-controls"
      >
        {controlsVisible ? 'Hide controls' : 'Show controls'}
      </button>

      {controlsVisible && (
        <section
          className="controls"
          id="bloom-controls"
          aria-label="Lotus animation preview"
        >
          <div className="controls-heading">
            <label htmlFor="bloom-progress">Bloom progress</label>
            <output htmlFor="bloom-progress">
              {Math.round(progress * 100)}%
            </output>
          </div>

          <input
            id="bloom-progress"
            type="range"
            min="0"
            max="1"
            step="0.001"
            value={progress}
            onChange={(event) =>
              setProgress(Number(event.target.value))
            }
          />

          <div className="presets">
            <button onClick={() => setProgress(0)}>Bud</button>
            <button onClick={() => setProgress(0.5)}>Half bloom</button>
            <button onClick={() => setProgress(1)}>Full bloom</button>
          </div>

          <p>Animation preview · glass and glow come next</p>
        </section>
      )}
    </main>
  )
}