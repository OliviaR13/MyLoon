/* 玻璃球（移植自 Bencho 的 Glass bubble，MIT 许可，bencho.dev/licence；原版是 React，这里改成原生 JS）。
   一颗可以在图片上拖动的玻璃球：它把下面的东西放大一点、在边缘处把画面弯进去、在最边上把颜色分开一丁点、
   沿上缘接一道光，也可以被拖到图片外面的卡片上——那里没有东西可弯，只剩下光和影。

   ── 着色器，不是滤镜 ────────────────────────────────
   页面是一张纹理，每个像素问一个有向距离函数「我离这个胶囊的边有多远」，所以弯曲、边缘光和阴影都跟着同一条边，
   包括快速拖动时胶囊被拉长的那一刻。靠近边缘的像素从沿法线更外面一点的地方取样，边缘那一圈显示的是边外面刚好被聚拢进来的内容，
   这正是真玻璃边缘处文字会弯的原因；中间只做放大。

   本站只在新手引导的第一步里用它，贴在欢迎图标上。WebGL 不可用、着色器编译失败或上下文丢失时，
   mountGlassLens 返回 false / 自动还原，宿主里原来的 <img> 原样保留。 */

const VERT = `
attribute vec2 pos;
varying vec2 vUv;
void main() {
  vUv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform sampler2D tex;
uniform vec2 res;
uniform vec2 c;
uniform vec2 b;
uniform float r;
uniform float bend;
uniform float fringe;
uniform float dark;
varying vec2 vUv;

float sdf(vec2 p) {
  vec2 q = abs(p - c) - b + vec2(r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

/* 预乘 alpha：图片外面那圈余量是透明的，真正的卡片从它后面透出来，
   那里的玻璃什么也弯不了，只剩下它的光和影 */
vec4 read(vec2 p) {
  return texture2D(tex, clamp(p / res, 0.0, 1.0));
}

void main() {
  vec2 p = vUv * res;
  float d = sdf(p);
  vec4 col = read(p);

  /* 它投下的影：柔和、略偏下。有图的地方压暗图，没有图的地方自己就是一块影 */
  float ds = sdf(p - vec2(0.0, 9.0));
  float sh = (1.0 - smoothstep(-8.0, 26.0, ds)) * mix(0.14, 0.3, dark);
  if (d > 0.0) col = vec4(col.rgb * (1.0 - sh), col.a) + vec4(0.0, 0.0, 0.0, sh * (1.0 - col.a));

  if (d < 1.0) {
    float e = 1.5;
    vec2 n = normalize(vec2(
      sdf(p + vec2(e, 0.0)) - sdf(p - vec2(e, 0.0)),
      sdf(p + vec2(0.0, e)) - sdf(p - vec2(0.0, e))
    ) + 1e-5);
    /* 弯曲带随球的大小缩放，大球仍是透镜，小球也不会全是边 */
    float bevel = min(b.y, max(22.0, b.y * 0.36));
    /* 边上是 0，越过弯曲带是 1 */
    float t = clamp(-d / bevel, 0.0, 1.0);
    float edge = pow(1.0 - t, 2.4);

    vec2 mag = c + (p - c) / 1.1;
    vec2 off = n * edge * bevel * 1.1 * bend;
    vec2 q = mag + off;
    vec4 mid = read(q);
    vec4 g = vec4(read(q + off * fringe).r, mid.g, read(q - off * fringe).b, mid.a);

    /* 光：紧贴边内侧的一道细亮带，朝左上的地方最亮；对面一侧有一点较弱的光，是光线穿过去又出来 */
    vec2 L = normalize(vec2(-0.55, -0.85));
    float rim = smoothstep(0.0, 1.6, -d) * (1.0 - smoothstep(1.6, 4.5, -d));
    float lit = max(dot(n, L), 0.0);
    float far = max(dot(n, -L), 0.0);
    g.rgb *= mix(1.03, 1.08, dark);
    /* 光是当作光加进去的：颜色和覆盖一起加，所以在卡片上和在图片上都看得见 */
    float light = rim * (0.18 + 0.75 * lit) + rim * far * 0.22 + edge * mix(0.05, 0.08, dark);
    g += vec4(vec3(light), light);
    g = clamp(g, 0.0, 1.0);

    float a = 1.0 - smoothstep(-0.6, 0.6, d);
    col = mix(col, g, a);
  }
  gl_FragColor = col;
}`;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const still = () =>
  document.documentElement.hasAttribute("data-reduce-motion") ||
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* 深色还是浅色，读页面：<html data-theme> 是用户强制的，没有就跟系统（和 base.css 的规则一致） */
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t !== "light" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
};

function compile(gl) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
}

/* 圆角矩形路径：不用 roundRect（Safari 16 以前没有） */
function roundRectPath(x, px, py, w, h, r) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

/* host：放画布的元素（里面原来的内容是兜底）；返回 Promise<boolean>，true 表示玻璃球已经在了。
   pic 图片边长；pad 球可以越出图片的余量；size 球的直径；corner 图片的圆角，默认 22%（和图标一致）。 */
export async function mountGlassLens(host, { src, pic = 96, pad = 28, size = 70, bend = 55, fringe = 30, corner, label = "一颗可以拖动的玻璃球，盖在图标上" } = {}) {
  const W = pic + pad * 2;
  const H = W;
  const cr = corner ?? Math.round(pic * 0.22);
  const rad = clamp(size, 40, W) / 2;

  const canvas = document.createElement("canvas");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.className = "tour-lens";
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);

  let gl;
  try {
    gl = canvas.getContext("webgl", { antialias: true, premultipliedAlpha: true, alpha: true });
  } catch { gl = null; }
  if (!gl) return false;
  const prog = compile(gl);
  if (!prog) return false;

  const img = new Image();
  img.src = src;
  try { await img.decode(); } catch { /* 下面按 naturalWidth 判断 */ }
  if (!img.naturalWidth) return false;

  /* 图片画在一张 2D 画布上，余量保持透明，再整张传给 GPU */
  const k = canvas.width / W;
  const page = document.createElement("canvas");
  page.width = canvas.width;
  page.height = canvas.height;
  const x = page.getContext("2d");
  const px = pad * k;
  const ps = pic * k;
  const s = Math.max(ps / img.naturalWidth, ps / img.naturalHeight);
  const iw = img.naturalWidth * s;
  const ih = img.naturalHeight * s;
  x.save();
  roundRectPath(x, px, px, ps, ps, clamp(cr, 0, 60) * k);
  x.clip();
  x.drawImage(img, px + (ps - iw) / 2, px + (ps - ih) / 2, iw, ih);
  x.restore();

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, page);
  gl.useProgram(prog);
  const U = Object.fromEntries(["res", "c", "b", "r", "bend", "fringe", "dark"].map((n) => [n, gl.getUniformLocation(prog, n)]));

  /* 起点：在图上，略偏右上 */
  const st = { x: W * 0.62, y: H * 0.42, vx: 0, vy: 0, tx: W * 0.62, ty: H * 0.42 };
  let grab = null;
  let raf = 0;

  /* ── 一帧 ── */
  const draw = () => {
    /* 快速拖动时沿运动方向拉长、横向变细——体积不变，只是在动 */
    const sp = Math.hypot(st.vx, st.vy);
    const stretch = still() ? 0 : Math.min(0.14, sp * 0.012);
    const ax = sp > 0.01 ? Math.abs(st.vx) / sp : 1;
    const bx = rad * (1 + stretch * ax - stretch * 0.5 * (1 - ax));
    const by = rad * (1 + stretch * (1 - ax) - stretch * 0.5 * ax);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.uniform2f(U.res, canvas.width, canvas.height);
    gl.uniform2f(U.c, st.x * k, st.y * k);
    gl.uniform2f(U.b, bx * k, by * k);
    gl.uniform1f(U.r, Math.min(bx, by) * k);
    gl.uniform1f(U.bend, clamp(bend, 0, 100) / 100);
    gl.uniform1f(U.fringe, clamp(fringe, 0, 40) / 100);
    gl.uniform1f(U.dark, isDark() ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  /* ── 循环：朝手的位置走一根弹簧，然后停下 ── */
  const run = () => {
    if (raf) return;
    let prev = 0;
    const tick = (t) => {
      const dt = prev ? clamp((t - prev) / 16.67, 0, 2.5) : 1;
      prev = t;
      if (still()) { st.x = st.tx; st.y = st.ty; st.vx = 0; st.vy = 0; }
      else {
        const kk = 0.22;
        const d = Math.pow(0.66, dt);
        st.vx = (st.vx + (st.tx - st.x) * kk * dt) * d;
        st.vy = (st.vy + (st.ty - st.y) * kk * dt) * d;
        st.x += st.vx * dt;
        st.y += st.vy * dt;
      }
      draw();
      const moving = Math.abs(st.tx - st.x) > 0.05 || Math.abs(st.ty - st.y) > 0.05 || Math.abs(st.vx) > 0.05 || Math.abs(st.vy) > 0.05 || grab;
      raf = moving ? requestAnimationFrame(tick) : 0;
    };
    raf = requestAnimationFrame(tick);
  };

  /* ── 手 ── */
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    const f = r.width / W;
    return { x: (e.clientX - r.left) / f, y: (e.clientY - r.top) / f };
  };
  const onGlass = (p) => Math.hypot(p.x - st.x, p.y - st.y) <= rad + 4;

  canvas.addEventListener("pointerdown", (e) => {
    const p = at(e);
    if (!onGlass(p)) return;
    grab = { dx: p.x - st.x, dy: p.y - st.y };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 脚本派发的事件没有指针可捕获 */ }
    run();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = at(e);
    canvas.dataset.over = String(onGlass(p) || !!grab);
    if (!grab) return;
    st.tx = clamp(p.x - grab.dx, 0, W);
    st.ty = clamp(p.y - grab.dy, 0, H);
    run();
  });
  const release = () => { if (!grab) return; grab = null; run(); };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  /* 主题切换时重画一帧（影的深浅随主题） */
  const mo = new MutationObserver(() => draw());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  /* 上下文丢失：还原成宿主里原来的内容 */
  const fallback = [...host.childNodes];
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    raf = 0;
    mo.disconnect();
    host.replaceChildren(...fallback);
    host.classList.remove("has-lens");
  });

  host.replaceChildren(canvas);
  host.classList.add("has-lens");
  draw();
  return true;
}
