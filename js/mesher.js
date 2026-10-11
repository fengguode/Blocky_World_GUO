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

const OPAQUE_BLOCK = BLOCKS.map(block => !!(block && block.opaque));
const AO_OCCLUDES = new Uint8Array(256).fill(1);
AO_OCCLUDES[0] = AO_OCCLUDES[9] = AO_OCCLUDES[10] = AO_OCCLUDES[12] = 0;
AO_OCCLUDES[18] = AO_OCCLUDES[19] = AO_OCCLUDES[20] = AO_OCCLUDES[21] = 0;

const VERT_FLOATS = 9;

// padded snapshot dimensions (1 block of margin on every side)
const PW = CHUNK + 2;      // 18
const PH = WORLD_H + 2;    // 66
const PAD_LEN = PW * PH * PW;
const PW2 = PW * PW;

// Precompute padded-array offsets used for every visible face and AO corner.
for (const face of FACES) {
  face.neighborOffset = face.dir[0] + face.dir[2] * PW + face.dir[1] * PW2;
  const tangentAxes = [0, 1, 2].filter(axis => face.n[axis] === 0);
  const offset = d => d[0] + d[2] * PW + d[1] * PW2;
  face.aoOffsets = face.corners.map(corner => {
    const sideA = face.n.slice();
    const sideB = face.n.slice();
    const diagonal = face.n.slice();
    for (const [vector, axis] of [[sideA, tangentAxes[0]], [sideB, tangentAxes[1]]]) {
      vector[axis] += corner[axis] === 0 ? -1 : 1;
    }
    diagonal[tangentAxes[0]] += corner[tangentAxes[0]] === 0 ? -1 : 1;
    diagonal[tangentAxes[1]] += corner[tangentAxes[1]] === 0 ? -1 : 1;
    return [offset(sideA), offset(sideB), offset(diagonal)];
  });
}

// index into the padded arrays: x + z*PW + (y+1)*PW*PW
function pidx(x, y, z) {
  return x + z * PW + (y + 1) * PW * PW;
}

// scratch buffers reused for every chunk so we don't thrash the GC
const _padBlocks = new Uint8Array(PAD_LEN);
const _padSun = new Uint8Array(PAD_LEN);
const _padBlk = new Uint8Array(PAD_LEN);

// Mesh uploads are synchronous, so staging arrays can be reused between
// chunks instead of allocating and collecting new buffers for every mesh.
const INITIAL_VERTEX_CAP = 4096;
const _meshScratch = {
  opaque: { vertexCap: INITIAL_VERTEX_CAP, vertices: new Float32Array(INITIAL_VERTEX_CAP * VERT_FLOATS), indices: new Uint32Array(INITIAL_VERTEX_CAP * 2) },
  cutout: { vertexCap: INITIAL_VERTEX_CAP, vertices: new Float32Array(INITIAL_VERTEX_CAP * VERT_FLOATS), indices: new Uint32Array(INITIAL_VERTEX_CAP * 2) },
  trans: { vertexCap: INITIAL_VERTEX_CAP, vertices: new Float32Array(INITIAL_VERTEX_CAP * VERT_FLOATS), indices: new Uint32Array(INITIAL_VERTEX_CAP * 2) },
};

function ensureMeshScratch(scratch, vertices, indices) {
  while (scratch.vertexCap < vertices) {
    scratch.vertexCap *= 2;
    const next = new Float32Array(scratch.vertexCap * VERT_FLOATS);
    next.set(scratch.vertices);
    scratch.vertices = next;
  }
  while (scratch.indices.length < indices) {
    const next = new Uint32Array(scratch.indices.length * 2);
    next.set(scratch.indices);
    scratch.indices = next;
  }
}

function fillPad(world, chunk) {
  _padBlocks.fill(0);
  _padSun.fill(15);
  _padBlk.fill(0);

  const ox = chunk.cx * CHUNK, oz = chunk.cz * CHUNK;

  for (let pz = -1; pz <= CHUNK; pz++) {
    const wz = oz + pz;
    const ccz = Math.floor(wz / CHUNK);
    const lz = wz - ccz * CHUNK;
    const zNeighbour = (pz === -1 || pz === CHUNK)
      ? world.getChunk(chunk.cx, ccz, false) : chunk;

    for (let px = -1; px <= CHUNK; px++) {
      const wx = ox + px;
      const ccx = Math.floor(wx / CHUNK);
      const lx = wx - ccx * CHUNK;
      // Corner columns come from the diagonal neighbour chunk.
      const src = (px === -1 || px === CHUNK)
        ? world.getChunk(ccx, ccz, false) : zNeighbour;
      if (!src || !src.generated) {
        // ungenerated neighbour: treat as air but mark unknown so faces
        // at the very edge of loaded terrain still get drawn
        continue;
      }
      // copy this column
      for (let y = 0; y < WORLD_H; y++) {
        const srcI = Chunk.idx(lx, y, lz);
        const dstI = pidx(px, y, pz);
        const id = src.blocks[srcI];
        _padBlocks[dstI] = id;
        _padSun[dstI] = src.light[srcI];
        _padBlk[dstI] = src.blockLight[srcI];
      }
    }
  }
}

// ambient occlusion for one vertex of a face, using the padded snapshot
function aoAt(here, corner, face) {
  const offsets = face.aoOffsets[corner];
  const s1 = occludes(_padBlocks[here + offsets[0]]);
  const s2 = occludes(_padBlocks[here + offsets[1]]);
  const sc = occludes(_padBlocks[here + offsets[2]]);
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

  // The two streams grow independently; one cannot alter the other's capacity.
  const opaqueScratch = _meshScratch.opaque;
  let opaque = opaqueScratch.vertices;
  let oLen = 0;                       // in vertices
  let oIdx = opaqueScratch.indices;
  let oIdxLen = 0;
  const cutoutScratch = _meshScratch.cutout;
  let cutoutVerts = cutoutScratch.vertices;
  let cLen = 0;
  let cIdx = cutoutScratch.indices;
  let cIdxLen = 0;
  const transScratch = _meshScratch.trans;
  let trans = transScratch.vertices;
  let tLen = 0;
  let tIdx = transScratch.indices;
  let tIdxLen = 0;

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
          const ni = here + face.neighborOffset;
          const nid = _padBlocks[ni];

          // --- visibility ---
          let visible;
          if (liquid) {
            // a water face is only visible against air / glass / leaves
            visible = (nid === 0) || (nid === 9) || (nid === 10);
            if (isLiquid(nid)) visible = false;
          } else if (nid === id && (cutout || liquid)) {
            // glass next to glass / leaves next to leaves: hide the shared face
            visible = false;
          } else if (OPAQUE_BLOCK[nid]) {
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

          const intoCutout = id === 9;
          const intoTrans = liquid || (cutout && !intoCutout);
          const len = intoTrans ? tLen : (intoCutout ? cLen : oLen);
          const indexLen = intoTrans ? tIdxLen : (intoCutout ? cIdxLen : oIdxLen);
          const scratch = intoTrans ? transScratch : (intoCutout ? cutoutScratch : opaqueScratch);
          ensureMeshScratch(scratch, len + 4, indexLen + 6);
          if (intoTrans) {
            trans = transScratch.vertices;
            tIdx = transScratch.indices;
          } else if (intoCutout) {
            cutoutVerts = cutoutScratch.vertices;
            cIdx = cutoutScratch.indices;
          } else {
            opaque = opaqueScratch.vertices;
            oIdx = opaqueScratch.indices;
          }

          const base = len;
          let o = len * VERT_FLOATS;
          const dst = intoTrans ? trans : (intoCutout ? cutoutVerts : opaque);

          for (let c = 0; c < 4; c++) {
            const co = face.corners[c];
            const uvo = face.uvs[c];
            let ao = 3;
            if (!intoTrans) {
              const offsets = face.aoOffsets[c];
              const s1 = AO_OCCLUDES[_padBlocks[here + offsets[0]]];
              const s2 = AO_OCCLUDES[_padBlocks[here + offsets[1]]];
              const sc = AO_OCCLUDES[_padBlocks[here + offsets[2]]];
              ao = s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
            }
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

          const idxArr = intoTrans ? tIdx : (intoCutout ? cIdx : oIdx);
          idxArr[indexLen] = base;
          idxArr[indexLen + 1] = base + 1;
          idxArr[indexLen + 2] = base + 2;
          idxArr[indexLen + 3] = base;
          idxArr[indexLen + 4] = base + 2;
          idxArr[indexLen + 5] = base + 3;
          if (intoTrans) { tLen += 4; tIdxLen += 6; }
          else if (intoCutout) { cLen += 4; cIdxLen += 6; }
          else { oLen += 4; oIdxLen += 6; }
        }
      }
    }
  }

  return {
    opaque: makeBuffer(gl, opaque, oLen, oIdx, oIdxLen),
    cutout: makeBuffer(gl, cutoutVerts, cLen, cIdx, cIdxLen),
    trans: makeBuffer(gl, trans, tLen, tIdx, tIdxLen),
  };
}

function makeBuffer(gl, verts, vertCount, indices, indexCount) {
  if (vertCount === 0 || indexCount === 0) return null;
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
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices.subarray(0, indexCount), gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, count: indexCount };
}

function disposeMesh(gl, mesh) {
  if (!mesh) return;
  if (mesh.opaque) gl.deleteVertexArray(mesh.opaque.vao);
  if (mesh.cutout) gl.deleteVertexArray(mesh.cutout.vao);
  if (mesh.trans) gl.deleteVertexArray(mesh.trans.vao);
}
