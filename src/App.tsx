import {
  Component,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Html, useGLTF } from '@react-three/drei'
import {
  EffectComposer,
  SelectiveBloom,
} from '@react-three/postprocessing'
import * as THREE from 'three'
import './App.css'

const STAR_VERTEX = `
  uniform vec2 uWorld;
  uniform float uDpr;

  attribute float aRadius, aBrightness, aPhase, aSpeed, aFlare;
  attribute vec3 aTint;

  varying float vRadius, vBrightness, vPhase, vSpeed, vFlare;
  varying vec3 vTint;

  void main() {
    vRadius = aRadius;
    vBrightness = aBrightness;
    vPhase = aPhase;
    vSpeed = aSpeed;
    vFlare = aFlare;
    vTint = aTint;

    vec3 point = vec3(
      position.x * uWorld.x,
      -4.0,
      position.y * uWorld.y
    );

    gl_Position =
      projectionMatrix * modelViewMatrix * vec4(point, 1.0);

    gl_PointSize = mix(6.0, 14.0, aFlare) * uDpr;
  }
`

const STAR_FRAGMENT = `
  uniform float uTime, uTwinkle;

  varying float vRadius, vBrightness, vPhase, vSpeed, vFlare;
  varying vec3 vTint;

  void main() {
    vec2 pixel =
      (gl_PointCoord - 0.5) * mix(6.0, 14.0, vFlare);

    float core = exp(
      -dot(pixel, pixel) / (vRadius * vRadius)
    );

    float horizontal =
      exp(-abs(pixel.y) * 7.0) *
      exp(-abs(pixel.x) / 1.6);

    float vertical =
      exp(-abs(pixel.x) * 7.0) *
      exp(-abs(pixel.y) / 2.3);

    float rays =
      (horizontal + vertical) * vFlare * 0.10;

    float pulse =
      1.0 + uTwinkle * 0.12 *
      sin(uTime * vSpeed + vPhase);

    float light = (core + rays) * vBrightness * pulse;

    if (light < 0.006) discard;

    gl_FragColor = vec4(vTint * light, 1.0);

    #include <colorspace_fragment>
  }
`

const EDGE_VERTEX = `
  varying vec3 vNormal;

  void main() {
    vNormal = normalize(normalMatrix * normal);

    gl_Position =
      projectionMatrix * modelViewMatrix *
      vec4(position, 1.0);
  }
`

const EDGE_FRAGMENT = `
  uniform float uStrength, uOuter;
  varying vec3 vNormal;

  void main() {
    float facing = abs(normalize(vNormal).z);

    float rim = pow(
      1.0 - facing,
      mix(2.2, 1.3, uOuter)
    );

    float body = mix(0.025, 0.085, uOuter);

    float light = (
      rim * mix(1.0, 1.4, uOuter) + body
    ) * uStrength;

    vec3 violet = mix(
      vec3(0.65, 0.12, 1.8),
      vec3(1.0, 0.35, 2.2),
      rim
    );

    gl_FragColor = vec4(violet * light, 0.55);
  }
`

type Options = {
  progress: number
  glass: boolean
  inner: number
  outer: number
  glow: number
  stars: boolean
  twinkle: boolean
}

const APPEARANCE = {
  glass: true,
  inner: 1,
  outer: 1,
  glow: 0.95,
  stars: true,
  twinkle: true,
}

type Task = {
  id: string
  text: string
  done: boolean
}

type Note = {
  title: string
  tasks: Task[]
}

const STORAGE_KEY = 'lotus-task-note-v1'

function readNote(): Note {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { title: 'Tasks', tasks: [] }

    const value: unknown = JSON.parse(raw)

    if (!value || typeof value !== 'object') {
      throw new Error('Invalid note')
    }

    const note = value as Partial<Note>

    if (
      typeof note.title !== 'string' ||
      !Array.isArray(note.tasks)
    ) {
      throw new Error('Invalid note')
    }

    const ids = new Set<string>()

    const tasks = note.tasks.filter(
      (task: unknown): task is Task => {
        if (!task || typeof task !== 'object') return false

        const item = task as Partial<Task>

        if (
          typeof item.id !== 'string' ||
          typeof item.text !== 'string' ||
          typeof item.done !== 'boolean' ||
          ids.has(item.id)
        ) {
          return false
        }

        ids.add(item.id)
        return true
      },
    )

    return { title: note.title, tasks }
  } catch {
    return { title: 'Tasks', tasks: [] }
  }
}

class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    return this.state.failed ? (
      <div className="error-message">
        Scene failed to load. Check the browser console and
        public/models/lotus-working.glb.
      </div>
    ) : (
      this.props.children
    )
  }
}

function Camera() {
  const camera = useThree(state => state.camera)
  const size = useThree(state => state.size)

  useLayoutEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return

    camera.position.set(0, 12, 0)
    camera.up.set(0, 0, -1)
    camera.lookAt(0, 0, 0)
    camera.zoom = Math.min(size.width, size.height) / 8
    camera.updateProjectionMatrix()
  }, [camera, size.width, size.height])

  return null
}

function StarField({ options }: { options: Options }) {
  const size = useThree(state => state.size)
  const gl = useThree(state => state.gl)
  const material = useRef<THREE.ShaderMaterial>(null)

  const geometry = useMemo(() => {
    let seed = 749327

    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0

      let t = Math.imul(seed ^ (seed >>> 15), seed | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    const count = 650
    const positions = new Float32Array(count * 3)
    const radii = new Float32Array(count)
    const brightness = new Float32Array(count)
    const phases = new Float32Array(count)
    const speeds = new Float32Array(count)
    const flares = new Float32Array(count)
    const tints = new Float32Array(count * 3)

    for (let i = 0; i < count; i++) {
      positions[i * 3] = random() - 0.5
      positions[i * 3 + 1] = random() - 0.5

      const prominence = Math.pow(random(), 4)

      radii[i] = 0.32 + prominence * 0.48
      brightness[i] = 0.12 + prominence * 0.55
      phases[i] = random() * Math.PI * 2
      speeds[i] = 0.35 + random() * 0.85
      flares[i] = prominence > 0.90 ? 1 : 0

      const tint = random()

      tints.set(
        tint < 0.15
          ? [1, 0.88, 0.77]
          : tint > 0.70
            ? [0.75, 0.84, 1]
            : [0.91, 0.94, 1],
        i * 3,
      )
    }

    const result = new THREE.BufferGeometry()

    result.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    )
    result.setAttribute(
      'aRadius',
      new THREE.BufferAttribute(radii, 1),
    )
    result.setAttribute(
      'aBrightness',
      new THREE.BufferAttribute(brightness, 1),
    )
    result.setAttribute(
      'aPhase',
      new THREE.BufferAttribute(phases, 1),
    )
    result.setAttribute(
      'aSpeed',
      new THREE.BufferAttribute(speeds, 1),
    )
    result.setAttribute(
      'aFlare',
      new THREE.BufferAttribute(flares, 1),
    )
    result.setAttribute(
      'aTint',
      new THREE.BufferAttribute(tints, 3),
    )

    return result
  }, [])

  const uniforms = useMemo(
    () => ({
      uWorld: { value: new THREE.Vector2(8, 8) },
      uDpr: { value: 1 },
      uTime: { value: 0 },
      uTwinkle: { value: 1 },
    }),
    [],
  )

  useLayoutEffect(() => {
    const shorter = Math.max(
      1,
      Math.min(size.width, size.height),
    )

    uniforms.uWorld.value.set(
      (size.width / shorter) * 8,
      (size.height / shorter) * 8,
    )

    uniforms.uDpr.value = gl.getPixelRatio()
    uniforms.uTwinkle.value = Number(options.twinkle)
  }, [size.width, size.height, gl, options.twinkle, uniforms])

  useFrame(({ clock }) => {
    if (material.current) {
      material.current.uniforms.uTime.value = clock.elapsedTime
    }
  })

  return (
    <points
      geometry={geometry}
      visible={options.stars}
      frustumCulled={false}
    >
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={STAR_VERTEX}
        fragmentShader={STAR_FRAGMENT}
        toneMapped={false}
        depthWrite={false}
      />
    </points>
  )
}

function makeGlass(outer: boolean) {
  return new THREE.MeshPhysicalMaterial({
    color: outer ? '#c5a0ef' : '#e3d0ff',
    metalness: 0,
    roughness: outer ? 0.25 : 0.18,
    transmission: 1,
    thickness: 0,
    ior: 1.15,
    specularIntensity: 0.08,
    specularColor: new THREE.Color('#bca0e8'),
    clearcoat: 0,
    envMapIntensity: 0.2,
    emissive: outer ? '#4c197a' : '#28103f',
    emissiveIntensity: outer ? 0.12 : 0.045,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
  })
}

function makeGlow(outer: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uStrength: { value: 0.95 },
      uOuter: { value: Number(outer) },
    },
    vertexShader: EDGE_VERTEX,
    fragmentShader: EDGE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
}

function Lotus({ options }: { options: Options }) {
  const { scene, animations } = useGLTF(
    '/models/lotus-working.glb',
  )

  const displayed = useRef(options.progress)

  const model = useMemo(() => {
    const root = scene.clone(true)
    const mixer = new THREE.AnimationMixer(root)

    const tracks = animations.flatMap(clip =>
      clip.tracks.map(track => track.clone()),
    )

    if (!tracks.length) {
      throw new Error('No animation tracks found')
    }

    const clip = new THREE.AnimationClip(
      'LotusBloom',
      -1,
      tracks,
    )

    const action = mixer.clipAction(clip)

    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.play()
    action.paused = true
    action.time = clip.duration

    mixer.update(0)
    root.updateMatrixWorld(true)

    const bounds = new THREE.Box3().setFromObject(root, true)
    const center = bounds.getCenter(new THREE.Vector3())
    const dimensions = bounds.getSize(new THREE.Vector3())

    const scale =
      4 / Math.max(dimensions.x, dimensions.z, 0.001)

    const petals: {
      mesh: THREE.Mesh
      original: THREE.Material | THREE.Material[]
      radius: number
      outer: boolean
    }[] = []

    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return

      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material]

      const isPetal = materials.some(
        material => material.name === 'wire_196088225.002',
      )

      if (!isPetal) {
        const warmed = materials.map(material => {
          if (
            !(material instanceof THREE.MeshStandardMaterial)
          ) {
            return material
          }

          const gold = material.clone()

          gold.color.set('#e3ae43')
          gold.emissive.set('#ffca68')
          gold.emissiveIntensity = 0.5
          gold.emissiveMap = gold.map
          gold.metalness = 0.22
          gold.roughness = 0.4
          gold.envMapIntensity = 0.25

          return gold
        })

        object.material = Array.isArray(object.material)
          ? warmed
          : warmed[0]

        return
      }

      const petalCenter = new THREE.Box3()
        .setFromObject(object, true)
        .getCenter(new THREE.Vector3())

      petals.push({
        mesh: object,
        original: object.material,
        radius: Math.hypot(
          petalCenter.x - center.x,
          petalCenter.z - center.z,
        ),
        outer: false,
      })
    })

    const sortedPetals = [...petals].sort(
      (a, b) => b.radius - a.radius,
    )

    sortedPetals.forEach((petal, index) => {
      petal.outer =
        index < Math.ceil(petals.length * 0.37)
    })

    const innerGlass = makeGlass(false)
    const outerGlass = makeGlass(true)
    const innerGlow = makeGlow(false)
    const outerGlow = makeGlow(true)

    const glows = petals.map(petal => {
      const edge = new THREE.Mesh(
        petal.mesh.geometry,
        petal.outer ? outerGlow : innerGlow,
      )

      edge.name = `${petal.mesh.name}_Glow`
      edge.renderOrder = 2
      petal.mesh.add(edge)

      return edge
    })

    action.time = 0
    mixer.update(0)

    return {
      root,
      mixer,
      action,
      duration: clip.duration,
      center,
      scale,
      petals,
      glows,
      innerGlass,
      outerGlass,
      innerGlow,
      outerGlow,
    }
  }, [scene, animations])

  useLayoutEffect(() => {
    model.action.reset().play()
    model.action.paused = true
    model.mixer.update(0)

    return () => {
      model.mixer.stopAllAction()
    }
  }, [model])

  useLayoutEffect(() => {
    model.innerGlass.transmission = options.inner
    model.outerGlass.transmission = options.outer
    model.innerGlow.uniforms.uStrength.value = options.glow
    model.outerGlow.uniforms.uStrength.value = options.glow

    for (const petal of model.petals) {
      const glass = petal.outer
        ? model.outerGlass
        : model.innerGlass

      const replace = (material: THREE.Material) =>
        material.name === 'wire_196088225.002'
          ? glass
          : material

      petal.mesh.material = options.glass
        ? Array.isArray(petal.original)
          ? petal.original.map(replace)
          : replace(petal.original)
        : petal.original
    }

    model.glows.forEach(mesh => {
      mesh.visible = options.glass && options.glow > 0
    })
  }, [
    model,
    options.glass,
    options.inner,
    options.outer,
    options.glow,
  ])

  useFrame((_, delta) => {
    displayed.current = THREE.MathUtils.damp(
      displayed.current,
      options.progress,
      7,
      Math.min(delta, 0.1),
    )

    if (
      Math.abs(displayed.current - options.progress) < 0.0001
    ) {
      displayed.current = options.progress
    }

    model.action.time =
      displayed.current * model.duration

    model.mixer.update(0)
  })

  return (
    <>
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

      <EffectComposer multisampling={0}>
        <SelectiveBloom
          selection={model.glows}
          lights={[]}
          selectionLayer={10}
          ignoreBackground
          mipmapBlur
          luminanceThreshold={0.03}
          luminanceSmoothing={0.2}
          intensity={options.glass ? 0.7 : 0}
          radius={0.7}
        />
      </EffectComposer>
    </>
  )
}

function Scene({ options }: { options: Options }) {
  return (
    <Canvas
      orthographic
      camera={{
        position: [0, 12, 0],
        near: 0.1,
        far: 100,
        zoom: 80,
      }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false }}
    >
      <color attach="background" args={['#000000']} />

      <Camera />
      <StarField options={options} />

      <ambientLight intensity={0.4} />

      <directionalLight
        position={[3, 8, 2]}
        intensity={0.85}
        color="#e8d6ff"
      />

      <Suspense
        fallback={
          <Html center>
            <div className="loading-message">
              Loading your lotus…
            </div>
          </Html>
        }
      >
        <Environment
          resolution={64}
          frames={1}
          background={false}
        >
          <mesh>
            <sphereGeometry args={[20, 24, 16]} />

            <meshBasicMaterial
              color="#5f497a"
              side={THREE.BackSide}
              toneMapped={false}
            />
          </mesh>
        </Environment>

        <Lotus options={options} />
      </Suspense>
    </Canvas>
  )
}

function TaskRow({
  task,
  onChange,
  onRemove,
}: {
  task: Task
  onChange: (patch: Partial<Task>) => void
  onRemove: () => void
}) {
  const field = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    if (!field.current) return

    field.current.style.height = '0px'
    field.current.style.height =
      `${field.current.scrollHeight}px`
  }, [task.text])

  return (
    <div
      className={`task-row ${
        task.done ? 'task-row--done' : ''
      }`}
    >
      <input
        className="task-check"
        type="checkbox"
        checked={task.done}
        aria-label={`${
          task.done ? 'Mark incomplete' : 'Complete'
        }: ${task.text || 'task'}`}
        onChange={event =>
          onChange({ done: event.target.checked })
        }
      />

      <textarea
        ref={field}
        className="task-text"
        rows={1}
        value={task.text}
        aria-label="Task text"
        placeholder="List item"
        maxLength={1000}
        onChange={event =>
          onChange({ text: event.target.value })
        }
        onKeyDown={event => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            field.current?.blur()
          }
        }}
      />

      <button
        className="remove-task"
        aria-label={`Delete ${task.text || 'task'}`}
        onClick={onRemove}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  )
}

export default function App() {
  const root = useRef<HTMLElement>(null)
  const star = useRef<HTMLButtonElement>(null)

  const [open, setOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [notice, setNotice] = useState('')

  const [note, setNote] = useState<Note>(readNote)
  const [draft, setDraft] = useState('')
  const [showCompleted, setShowCompleted] = useState(true)
  const [saveFailed, setSaveFailed] = useState(false)

  const completed = note.tasks.filter(task => task.done)
  const pending = note.tasks.filter(task => !task.done)

  const progress = note.tasks.length
    ? completed.length / note.tasks.length
    : 0

  const options: Options = {
    ...APPEARANCE,
    progress,
  }

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(note),
      )
      setSaveFailed(false)
    } catch {
      setSaveFailed(true)
    }
  }, [note])

  useEffect(() => {
    const changed = () => {
      setFullscreen(
        document.fullscreenElement === root.current,
      )
    }

    document.addEventListener('fullscreenchange', changed)

    return () => {
      document.removeEventListener(
        'fullscreenchange',
        changed,
      )
    }
  }, [])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        setOpen(false)
        star.current?.focus()
      }
    }

    document.addEventListener('keydown', keydown)

    return () => {
      document.removeEventListener('keydown', keydown)
    }
  }, [open])

  function addTask() {
    const text = draft.trim()
    if (!text) return

    const task: Task = {
      id: crypto.randomUUID(),
      text,
      done: false,
    }

    setNote(previous => ({
      ...previous,
      tasks: [...previous.tasks, task],
    }))

    setDraft('')
  }

  function changeTask(id: string, patch: Partial<Task>) {
    setNote(previous => ({
      ...previous,
      tasks: previous.tasks.map(item =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }))
  }

  function removeTask(id: string) {
    setNote(previous => ({
      ...previous,
      tasks: previous.tasks.filter(task => task.id !== id),
    }))
  }

  async function toggleFullscreen() {
    setNotice('')

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else if (root.current?.requestFullscreen) {
        await root.current.requestFullscreen()
      } else {
        setNotice(
          'Fullscreen is unavailable in this browser.',
        )
      }
    } catch {
      setNotice(
        'Open this page in a normal browser tab to use fullscreen.',
      )
    }
  }

  function renderTask(task: Task) {
    return (
      <TaskRow
        key={task.id}
        task={task}
        onChange={patch => changeTask(task.id, patch)}
        onRemove={() => removeTask(task.id)}
      />
    )
  }

  return (
    <main ref={root} className="app">
      <SceneBoundary>
        <Scene options={options} />
      </SceneBoundary>

      <button
        ref={star}
        className={`star-button ${
          open ? 'star-button--open' : ''
        }`}
        aria-label={open ? 'Close tasks' : 'Open tasks'}
        aria-expanded={open}
        aria-controls="task-panel"
        onClick={() => setOpen(previous => !previous)}
      >
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <path
            d="
              M32 5
              C33 27 36 30 59 32
              C36 34 33 37 32 59
              C31 37 28 34 5 32
              C28 30 31 27 32 5Z
            "
            fill="currentColor"
          />

          <circle
            cx="32"
            cy="32"
            r="3"
            fill="#ffffff"
          />
        </svg>
      </button>

      {open && (
        <aside
          id="task-panel"
          className="task-panel"
          aria-label="Task list"
        >
          <input
            className="note-title"
            aria-label="List title"
            placeholder="Title"
            maxLength={80}
            value={note.title}
            onChange={event =>
              setNote(previous => ({
                ...previous,
                title: event.target.value,
              }))
            }
          />

          <div className="note-body">
            {pending.map(renderTask)}

            <form
              className="add-task"
              onSubmit={event => {
                event.preventDefault()
                addTask()
              }}
            >
              <button
                type="submit"
                className="add-task-button"
                aria-label="Add task"
              >
                +
              </button>

              <input
                aria-label="New task"
                placeholder="List item"
                value={draft}
                maxLength={1000}
                onChange={event =>
                  setDraft(event.target.value)
                }
              />
            </form>

            {completed.length > 0 && (
              <section
                className="completed-section"
                aria-label="Completed tasks"
              >
                <button
                  className="completed-toggle"
                  aria-expanded={showCompleted}
                  aria-controls="completed-items"
                  onClick={() =>
                    setShowCompleted(previous => !previous)
                  }
                >
                  <svg
                    className={
                      showCompleted
                        ? 'chevron chevron--open'
                        : 'chevron'
                    }
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>

                  {completed.length} completed{' '}
                  {completed.length === 1
                    ? 'item'
                    : 'items'}
                </button>

                {showCompleted && (
                  <div id="completed-items">
                    {completed.map(renderTask)}
                  </div>
                )}
              </section>
            )}
          </div>

          {saveFailed && (
            <p className="save-error" role="status">
              Your browser could not save this list.
              Keep this tab open to retain your changes.
            </p>
          )}

          <footer className="note-footer">
            <span className="task-count">
              {note.tasks.length
                ? `${completed.length} of ${note.tasks.length} done`
                : 'No tasks yet'}
            </span>

            <button
              onClick={() => {
                setOpen(false)
                star.current?.focus()
              }}
            >
              Close
            </button>
          </footer>
        </aside>
      )}

      {!fullscreen && !open && (
        <button
          className="fullscreen-button"
          onClick={toggleFullscreen}
          aria-label="Enter fullscreen"
        >
          ⛶
        </button>
      )}

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </main>
  )
}