'use strict';
/* ============================================================
   mesher.js — builds GPU buffers for a chunk
   Face-culled quads with per-vertex baked ambient occlusion.

   Vertex layout (9 floats, 36 bytes):
     0..2  position
     3..4  uv
     5texture layer
     6     baked light
     7     ambient occlusion
     8     flags (1 = liquid)

   Performance note: instead of calling world.getBlock() millions of
   times (each one is a Map lookup + string key), we copy a padded
   18 x 66 x 18 snapshot of the chunk and its neighbours into flat
   typed arrays first, then mesh against those. Same result, ~40x
   faster, which is what makes chunk edits feel instant.
   ============================================================ */

const FACES = [
  // dir, normal, shade, 4 corners (CCW seen from outside), uvs, which tile slot
  { dir: [1, 0, 0],  n: [1, 0, 0],  shade: 0.80, corners: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]], uvs: [[0,1],[1,1],[1,0],[0,0]], tile: 'side' },
  { dir: [-1, 0, 0], n: [-1, 0, 0], shade: 0.80, corners: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]], uvs: [[0,1],[1,1],[1,0],[0,0]], tile: 'side' },
  { dir: [0, 1, 0],  n: [0, 1, 0],  shade: 1.00, corners: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], uvs: [[0,1],[1,1],[1,0],[0,0]], tile: 'top' },
  { dir: [0, -1, 0], n: [0, -1, 0], shade: 0.52, corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], uvs: [[0,0],[1,0],[1,1],[0,1]], tile: 'bottom' },
  { dir: [0, 0, 1],  n: [0, 0, 1],  shade: 0.66, corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], uvs: [[0,1],[1,1],[1,0],[0,0]], tile: 'side' },
  { dir: [0, 0, -1], n: [0, 0, -1], shade: 0.66, corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], uvs: [[0,1],[1,1],[1,0],[0,0]], tile: 'side' },
];

const VERT_FLOATS = 9;

// padded snapshot dimensions (1 block of margin on every side)
const PW = CHUNK + 2;      // 18
const PH = WORLD_H + 2;    // 66
const PAD_LEN = PW * PH * PW;

// index into the padded arrays: x + z*PW + (y+1)*PW*PW
function pidx(x, y, z) {
  return x + z * PW + (y + 1) * PW * PW;
}

// scratch buffers reused for every chunk so we don't thrash the GC
const _padBlocks = new Uint8Array(PAD_LEN);
const _padSun = new Uint8Array(PAD_LEN);
const _padBlk = new Uint8Array(PAD_LEN);
const _padKnown = new Uint8Array(PAD_LEN);

function fillPad(world, chunk) {
  _padBlocks.fill(0);
  _padSun.fill(15);
  _padBlk.fill(0);
  _padKnown.fill(0);

  const ox = chunk.cx * CHUNK, oz = chunk.cz * CHUNK;

  for (let pz = -1; pz <= CHUNK; pz++) {
    const wz = oz + pz;
    const ccz = Math.floor(wz / CHUNK);
    const lz = wz - ccz * CHUNK;
    const ncz = (pz === -1 || pz === CHUNK) ? world.getChunk(ccz, chunk.cz, false) : chunk;
    const ncz2 = world.getChunk(ccz, chunk.cz, false);

    for (let px = -1; px <= CHUNK; px++) {
      const wx = ox + px;
      const ccx = Math.floor(wx / CHUNK);
      const lx = wx - ccx * CHUNK;
      // the corner pixels need the diagonal neighbour chunk
      const src = (px === -1 || px === CHUNK) ? ncz2 : ncz;
      if (!src || !src.generated) {
        // ungenerated neighbour: treat as air but mark unknown so faces
        // at the very edge of loaded terrain still get drawn
        continue;
      }
      const known = pidx(px + 1, 0, pz + 1);
      // copy this column
      for (let y = 0; y < WORLD_H; y++) {
        const srcI = Chunk.idx(lx, y, lz);
        const dstI = pidx(px, y, pz);
        const id = src.blocks[srcI];
        _padBlocks[dstI] = id;
        _padSun[dstI] = src.light[srcI];
        _padBlk[dstI] = src.blockLight[srcI];
        _padKnown[dstI] = 1;
      }
      void known;
    }
  }
}

// ambient occlusion for one vertex of a face, using the padded snapshot
function aoAt(fx, fy, fz, corner, face) {
  const ox = face.corners[corner][0], oy = face.corners[corner][1], oz = face.corners[corner][2];
  const px = fx + face.n[0], py = fy + face.n[1], pz = fz + face.n[2];
  const s1 = occludes(_padBlocks[pidx(px + ox, py + oy - 1, pz + oz)]);
  const s2 = occludes(_padBlocks[pidx(px + ox, py + oy, pz + oz - 1)]);
  const sc = occludes(_padBlocks[pidx(px + ox, py + oy - 1, pz + oz - 1)]);
  if (s1 && s2) return 0;
  return 3 - (s1 + s2 + sc);
}

function occludes(id) {
  // water, glass and leaves don't cast ambient shadows
  return (id === 0 || id === 9 || id === 10 || id === 12) ? 0 : 1;
}

function buildChunkMesh(gl, world, chunk) {
  fillPad(world, chunk);
  const ox = chunk.cx * CHUNK, oz = chunk.cz * CHUNK;

  // growable scratch for the two vertex streams
  let cap = 4096;
  let opaque = new Float32Array(cap * VERT_FLOATS);
  let oLen = 0;                       // in vertices
  let oIdx = [];
  let trans = new Float32Array(cap * VERT_FLOATS);
  let tLen = 0;
  let tIdx = [];

  const growO = () => { cap *= 2; const n = new Float32Array(cap * VERT_FLOATS); n.set(opaque); opaque = n; };
  const growT = () => { cap *= 2; const n = new Float32Array(cap * VERT_FLOATS); n.set(trans); trans = n; };

  for (let y = 0; y < WORLD_H; y++) {
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const here = pidx(x, y, z);
        const id = _padBlocks[here];
        if (id === 0) continue;

        const b = BLOCKS[id];
        const liquid = !!b.liquid;
        const cutout = !!b.cutout;
        const wx = ox + x, wy = y, wz = oz + z;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const ni = pidx(x + face.dir[0], y + face.dir[1], z + face.dir[2]);
          const nid = _padBlocks[ni];

          // --- visibility ---
          let visible;
          if (liquid) {
            // a water face is only visible against air / glass / leaves
            visible = (nid === 0) || (nid === 9) || (nid === 10);
          } else if (nid === id && (cutout || liquid)) {
            // glass next to glass / leaves next to leaves: hide the shared face
            visible = false;
          } else if (isOpaque(nid)) {
            // anything solid and opaque in front hides this face
            visible = false;
          } else {
            visible = true;
          }
          if (!visible) continue;

          const tile = b[face.tile];

          // light sampled from the neighbouring (open) cell
          const sl = _padSun[ni] / 15;
          const bl = _padBlk[ni] / 15;
          let light = Math.max(sl * 0.94, bl * 0.88);
          if (liquid) light = Math.max(light, 0.58);

          const intoTrans = liquid || cutout;
          const arr = intoTrans ? trans : opaque;
          let len = intoTrans ? tLen : oLen;
          const idxArr = intoTrans ? tIdx : oIdx;

          if (len + 4 > cap) { if (intoTrans) growT(); else growO(); }

          const base = len;
          let o = (intoTrans ? tLen : oLen) * VERT_FLOATS;
          const dst = intoTrans ? trans : opaque;

          for (let c = 0; c < 4; c++) {
            const co = face.corners[c];
            const uvo = face.uvs[c];
            const ao = intoTrans ? 3 : aoAt(x, y, z, c, face);
            const aoF = 0.56 + (ao / 3) * 0.44;
            dst[o]     = wx + co[0];
            dst[o + 1] = wy + co[1];
            dst[o + 2] = wz + co[2];
            dst[o + 3] = uvo[0];
            dst[o + 4] = uvo[1];
            dst[o + 5] = tile;
            dst[o + 6] = light * face.shade;
            dst[o + 7] = aoF;
            dst[o + 8] = liquid ? 1 : 0;
            o += VERT_FLOATS;
          }

          idxArr.push(base, base + 1, base + 2, base, base + 2, base + 3);
          if (intoTrans) tLen += 4; else oLen += 4;
        }
      }
    }
  }

  return {
    opaque: makeBuffer(gl, opaque, oLen, oIdx),
    trans: makeBuffer(gl, trans, tLen, tIdx),
  };
}

function makeBuffer(gl, verts, vertCount, indices) {
  if (vertCount === 0 || indices.length === 0) return null;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, vertCount * VERT_FLOATS), gl.STATIC_DRAW);

  const stride = VERT_FLOATS * 4;
  const layout = [
    [0, 3, 0],   // position
    [1, 2, 12],  // uv
    [2, 1, 20],  // texture layer
    [3, 1, 24],  // light
    [4, 1, 28],  // ao
    [5, 1, 32],  // flags
  ];
  for (const [loc, size, off] of layout) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
  }

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, count: indices.length };
}

function disposeMesh(gl, mesh) {
  if (!mesh) return;
  if (mesh.opaque) gl.deleteVertexArray(mesh.opaque.vao);
  if (mesh.trans) gl.deleteVertexArray(mesh.trans.vao);
}