import * as THREE from 'three';

// The living core inside Ghost's lens. The motion model (idle drift, inward listening waves, thought
// belts, outward speech waves, band-driven sparks) is adapted from Ship Notes' Voice Orb
// (vendor/shipnotes/voice-orb.js, MIT). It is re-hosted as THREE.Points so it sits in 3D inside the
// eye, turns with the body and feeds the bloom pass. A fifth "scan" weight collapses the points
// onto orbiting rings for searching, after the Signal Orb.

const VERT = /* glsl */ `
  attribute vec4 seed;
  uniform float time, size, onset;
  uniform vec4 weights;   // idle, listening, thinking, speaking
  uniform float scan;     // searching rings
  uniform vec3 bands;     // low, mid, high
  varying float strength, spark, cool;
  float hash(vec3 p) { return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
  float noise(vec3 p) {
    vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=mix(hash(i),hash(i+vec3(1,0,0)),f.x), b=mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x);
    float c=mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x), d=mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x);
    return mix(mix(a,b,f.y),mix(c,d,f.y),f.z)*2.0-1.0;
  }
  vec3 turn(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x+s*p.z,p.y,c*p.z-s*p.x);}
  vec3 roll(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x-s*p.y,s*p.x+c*p.y,p.z);}
  void main() {
    float t=time; vec3 n=seed.xyz;
    float angle=acos(clamp(n.z,-1.0,1.0));
    float drift=noise(n*2.7+vec3(t*.19,-t*.11,t*.08));
    float bass=noise(n*1.8+vec3(t*.32,0,-t*.2));
    float grain=noise(n*17.0+vec3(-t*1.8,t*.7,t));
    float low=bands.x, mid=bands.y, high=bands.z;
    float idleR=1.0+.03*drift+.012*sin(t*.85);
    float inward=sin(angle*13.0+t*5.4+drift*1.6);
    float outward=sin(angle*12.0-t*6.2+drift*1.6);
    float listenR=1.0-.045*low+.10*low*bass+(.018+.12*mid)*inward+.032*high*grain;
    float speakR=1.0+.08*low+.2*low*bass+(.02+.18*mid)*outward+.06*high*grain;
    speakR+=onset*(.08+.18*max(0.0,outward))*(.4+.6*seed.w);
    vec3 thought=turn(n,t*.55+n.y*1.45+drift*.12)*(1.0+.035*drift); thought.y*=.92;
    vec3 pos=turn(n,t*.11)*idleR*weights.x + turn(n,t*.16)*listenR*weights.y + thought*weights.z + turn(n,t*.20)*speakR*weights.w;
    // Searching: three tilted rings that orbit at different speeds.
    float k=floor(seed.w*3.0);
    float ang=atan(n.y,n.x)+t*(1.2+k*.7)*(mod(k,2.0)*2.0-1.0);
    vec3 ringP=vec3(cos(ang),sin(ang),0.0)*(.9+.12*k);
    ringP=roll(turn(ringP,.9+k*1.05),k*.8+t*.2);
    ringP+=n*.04;
    pos=mix(pos,ringP,scan);
    float act=weights.y+weights.w;
    float rim=pow(max(0.0,1.0-abs(n.z)),2.2);
    float pop=pow(max(0.0,sin(t*8.0+seed.w*149.0)),18.0)*step(.9,seed.w);
    pos*=1.0+act*high*pop*.17;
    vec3 q=turn(n,t*.33);
    float b1=exp(-pow((dot(q,normalize(vec3(.24,.83,.50)))-.13)*23.0,2.0));
    float b2=exp(-pow((dot(q,normalize(vec3(-.71,.48,.39)))+.16)*23.0,2.0));
    float b3=exp(-pow((dot(q,normalize(vec3(.69,.58,-.41)))-.06)*23.0,2.0));
    float belts=min(1.5,b1+b2+b3)*(.6+.4*sin(atan(n.y,n.x)*2.0-t*2.3));
    float flow=pow(.5+.5*sin(angle*13.0+(weights.y-weights.w)*t*5.8+drift*2.0),7.0);
    vec4 mv=modelViewMatrix*vec4(pos,1.0);
    gl_Position=projectionMatrix*mv;
    float depth=clamp(pos.z*.5+.5,0.0,1.0);
    gl_PointSize=size*(0.7+0.5*depth+0.4*rim+act*high*pop*1.5)/-mv.z;
    cool=.5+.5*sin(n.y*2.1+n.x*1.6+drift*.65);
    strength=(.25+.45*depth+.6*rim)*(.65+.35*seed.w);
    strength+=act*(mid*flow*.95+onset*rim*.9)+weights.z*belts*1.6+scan*.5;
    spark=act*(high*pop*.8+onset*rim*.22)+weights.z*belts*.13;
  }`;

const FRAG = /* glsl */ `
  uniform vec3 colorA, colorB;
  uniform float intensity;
  varying float strength, spark, cool;
  void main() {
    float r=length(gl_PointCoord-.5)*2.0;
    if(r>1.0) discard;
    float core=1.0-smoothstep(.18,.64,r);
    float halo=exp(-r*r*4.0)*.24*(1.0-smoothstep(.75,1.0,r));
    float a=(core+halo)*strength*intensity;
    vec3 col=mix(colorA,colorB,cool)*a+vec3(1.0,.95,.9)*spark*core;
    gl_FragColor=vec4(col,min(1.0,a+spark*core));
  }`;

export class ParticleCore {
  readonly points: THREE.Points;
  readonly uniforms = {
    time: { value: 0 },
    size: { value: 22 },
    onset: { value: 0 },
    weights: { value: new THREE.Vector4(1, 0, 0, 0) },
    scan: { value: 0 },
    bands: { value: new THREE.Vector3() },
    colorA: { value: new THREE.Color('#3f8fb8') },
    colorB: { value: new THREE.Color('#bff4ff') },
    intensity: { value: 1.4 },
  };

  constructor(count: number, radius: number) {
    const seeds = new Float32Array(count * 4);
    const rnd = (i: number) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
    for (let i = 0; i < count; i++) {
      const y = 1 - (2 * (i + 0.5)) / count;
      const a = i * 2.399963229728653;
      const r = Math.sqrt(1 - y * y);
      seeds.set([r * Math.cos(a), y, r * Math.sin(a), rnd(i + 31)], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    // Positions are computed in the shader; a dummy attribute keeps three.js happy, and bounds are fixed.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.scale.setScalar(radius);
    this.points.frustumCulled = false;
  }

  /** Point size scales with the canvas's pixel height so the core looks the same at any size. */
  setPixelScale(heightPx: number): void { this.uniforms.size.value = heightPx * 0.04; }
}
