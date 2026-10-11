'use strict';
/* ============================================================
   gl.js — WebGL2 helpers + matrix math
   ============================================================ */

function createGL(canvas) {
  const opts = { antialias: true, alpha: false, powerPreference: 'high-performance' };
  const gl = canvas.getContext('webgl2', opts);
  if (!gl) return null;
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  return gl;
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('Shader error:', gl.getShaderInfoLog(sh));
    console.error(src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('Link error:', gl.getProgramInfoLog(p));
    return null;
  }
  // cache locations
  p.u = {};
  p.a = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    p.u[name] = gl.getUniformLocation(p, name);
  }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(p, i);
    p.a[info.name] = gl.getAttribLocation(p, info.name);
  }
  return p;
}

/* ---------- mat4 (column-major, like OpenGL) ---------- */
const M4 = {
  create() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  identity(o) {
    o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o;
  },

  perspective(o, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    o.fill(0);
    o[0] = f / aspect; o[5] = f; o[11] = -1;
    o[10] = (far + near) / (near - far);
    o[14] = (2 * far * near) / (near - far);
    return o;
  },

  lookAt(o, eye, center, up) {
    let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
    let len = Math.hypot(z0, z1, z2) || 1;
    z0 /= len; z1 /= len; z2 /= len;
    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    len = Math.hypot(x0, x1, x2);
    if (len < 1e-6) { x0 = 1; x1 = 0; x2 = 0; } else { x0 /= len; x1 /= len; x2 /= len; }
    const y0 = z1 * x2 - z2 * x1;
    const y1 = z2 * x0 - z0 * x2;
    const y2 = z0 * x1 - z1 * x0;
    o[0] = x0; o[1] = y0; o[2] = z0; o[3] = 0;
    o[4] = x1; o[5] = y1; o[6] = z1; o[7] = 0;
    o[8] = x2; o[9] = y2; o[10] = z2; o[11] = 0;
    o[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    o[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    o[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    o[15] = 1;
    return o;
  },

  multiply(o, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4]     = b0 * a[0] + b1 * a[4] + b2 * a[8]  + b3 * a[12];
      o[c * 4 + 1] = b0 * a[1] + b1 * a[5] + b2 * a[9]  + b3 * a[13];
      o[c * 4 + 2] = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
      o[c * 4 + 3] = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
    }
    return o;
  },

  translate(o, x, y, z) {
    M4.identity(o); o[12] = x; o[13] = y; o[14] = z; return o;
  },

  scale(o, x, y, z) {
    M4.identity(o); o[0] = x; o[5] = y; o[10] = z; return o;
  },

  // Compose T * RY * S for a box in one pass. The individual helpers above
  // initialize their output matrix, so calling translate(), rotateY(), then
  // scale() on the same matrix would erase the earlier transforms.
  composeTRS(o, position, scale, rotationY) {
    const c = Math.cos(rotationY || 0), s = Math.sin(rotationY || 0);
    o.fill(0);
    o[0] = c * scale[0];  o[2] = -s * scale[0];
    o[5] = scale[1];
    o[8] = s * scale[2];  o[10] = c * scale[2];
    o[12] = position[0];  o[13] = position[1];  o[14] = position[2];
    o[15] = 1;
    return o;
  },

  rotateX(o, r) {
    const c = Math.cos(r), s = Math.sin(r);
    M4.identity(o); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o;
  },

  rotateY(o, r) {
    const c = Math.cos(r), s = Math.sin(r);
    M4.identity(o); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o;
  },

  rotateZ(o, r) {
    const c = Math.cos(r), s = Math.sin(r);
    M4.identity(o); o[0] = c; o[1] = s; o[4] = -s; o[5] = c; return o;
  },

  invert(o, a) {
    const b00 = a[0]*a[5] - a[1]*a[4],  b01 = a[0]*a[6] - a[2]*a[4];
    const b02 = a[0]*a[7] - a[3]*a[4],  b03 = a[1]*a[6] - a[2]*a[5];
    const b04 = a[1]*a[7] - a[3]*a[5],  b05 = a[2]*a[7] - a[3]*a[6];
    const b06 = a[8]*a[13] - a[9]*a[12], b07 = a[8]*a[14] - a[10]*a[12];
    const b08 = a[8]*a[15] - a[11]*a[12], b09 = a[9]*a[14] - a[10]*a[13];
    const b10 = a[9]*a[15] - a[11]*a[13], b11 = a[10]*a[15] - a[11]*a[14];
    let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
    if (!det) return M4.identity(o);
    det = 1 / det;
    o[0]=(a[5]*b11-a[6]*b10+a[7]*b09)*det;  o[1]=(a[2]*b10-a[1]*b11-a[3]*b09)*det;
    o[2]=(a[13]*b05-a[14]*b04+a[15]*b03)*det; o[3]=(a[10]*b04-a[9]*b05-a[11]*b03)*det;
    o[4]=(a[6]*b08-a[4]*b11-a[7]*b07)*det;  o[5]=(a[0]*b11-a[2]*b08+a[3]*b07)*det;
    o[6]=(a[14]*b02-a[12]*b05-a[15]*b01)*det; o[7]=(a[8]*b05-a[10]*b02+a[11]*b01)*det;
    o[8]=(a[4]*b10-a[5]*b08+a[7]*b06)*det;  o[9]=(a[1]*b08-a[0]*b10-a[3]*b06)*det;
    o[10]=(a[12]*b04-a[13]*b02+a[15]*b00)*det; o[11]=(a[9]*b02-a[8]*b04-a[11]*b00)*det;
    o[12]=(a[5]*b07-a[4]*b09-a[6]*b06)*det; o[13]=(a[0]*b09-a[1]*b07+a[2]*b06)*det;
    o[14]=(a[13]*b01-a[12]*b03-a[14]*b00)*det; o[15]=(a[8]*b03-a[9]*b01+a[10]*b00)*det;
    return o;
  },
};

/* ---------- geometry helpers ---------- */

// Axis-aligned box, returns {positions, normals, uvs} in unit space.
function buildCube() {
  const faces = [
    { n: [0, 0, 1],  v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
    { n: [1, 0, 0],  v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
    { n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
    { n: [0, 1, 0],  v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  ];
  const pos = [], nor = [], uv = [];
  const quadUV = [[0, 1], [1, 1], [1, 0], [0, 0]];
  for (const f of faces) {
    for (let i = 0; i < 4; i++) {
      pos.push(f.v[i][0] - 0.5, f.v[i][1] - 0.5, f.v[i][2] - 0.5);
      nor.push(f.n[0], f.n[1], f.n[2]);
      uv.push(quadUV[i][0], quadUV[i][1]);
    }
  }
  const idx = [];
  for (let f = 0; f < 6; f++) {
    const b = f * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    uvs: new Float32Array(uv),
    indices: new Uint16Array(idx),
  };
}

// Flat XZ quad lying on the ground, used for the shadow blob.
function buildQuad() {
  return {
    positions: new Float32Array([
      -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, -0.5,
    ]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

// A flat vertical quad in XY, used for hit sparks and the held-block outline.
function buildSprite() {
  return {
    positions: new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}
