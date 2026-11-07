import * as THREE from 'three'
import type { TriangleMesh } from '@core/types'

/**
 * The orbitable 3D view: renders the box, handles raycast face picking, and
 * shows the live engraving preview (docs/PLAN.md §3). Z-up throughout.
 */
export class Viewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private template: THREE.Mesh | null = null
  private running = false

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000)
    this.camera.up.set(0, 0, 1) // Z-up — matches the face-basis math in core/faces.ts
    this.camera.position.set(120, -160, 120)
    this.camera.lookAt(0, 0, 0)

    this.scene.background = new THREE.Color(0x1e1f22)
    const key = new THREE.DirectionalLight(0xffffff, 2)
    key.position.set(1, -1, 1)
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.6))

    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  /** Replace the displayed template with a freshly parsed triangle soup. */
  setTemplate(mesh: TriangleMesh): void {
    if (this.template) this.scene.remove(this.template)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    geometry.computeVertexNormals()
    geometry.center()
    const material = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, metalness: 0.1, roughness: 0.8 })
    this.template = new THREE.Mesh(geometry, material)
    this.scene.add(this.template)
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.renderer.render(this.scene, this.camera)
      requestAnimationFrame(loop)
    }
    loop()
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }

  // TODO(stage1-step2): OrbitControls, raycast picking → detectFace().
}
