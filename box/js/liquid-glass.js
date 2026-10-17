/* 液态玻璃（把 Bencho 的 Glass bubble 的光学规则搬到网页控件上；Glass bubble 本身 MIT 许可，bencho.dev/licence）。

   Glass bubble 是一个着色器：每个像素问有向距离函数「我离胶囊的边多远」，弯曲、边缘光和阴影都跟着同一条边。
   网页里被玻璃盖住的是实时的页面，没法当纹理交给 WebGL，所以这里分两层做同一件事：

   ── 折射：SVG 位移图 + backdrop-filter（Chromium 系浏览器）──────
   用和着色器同样的公式在 canvas 上算一张位移图：中间只放大一点（/1.06），靠近边的一圈沿法线从更外面取样
   （(1 - t)^2.4 衰减，t 是离边距离 / 弯曲带宽），所以文字在边缘处会向内弯。红通道是 x 位移、绿通道是 y 位移，
   feDisplacementMap 用它把玻璃后面的内容挪开。页面宽度变了会重算，一张图几毫秒。

   ── 光和影：纯 CSS（所有浏览器）────────────────────
   沿上缘一道细亮带（朝左上最亮）、对面一侧较弱的一道、边缘处极轻的色散（红蓝各偏 1px）、向下的软影。
   iOS Safari 的 backdrop-filter 不支持 url() 滤镜，所以那里没有折射，只有模糊 + 提亮 + 上面这些光影；
   这一点和 Chromium 不同，是浏览器的限制，不是代码没生效。

   用法：initLiquidGlass(元素)。元素需要 position 非 static；CSS 在 styles/toolbar.css 的「液态玻璃」一节。
   不想要时删掉 app.js 里的调用，再去掉元素上的 .lg 类即可，别的都不依赖它。 */

const BEND = 0.4;   // 边缘弯多狠（Glass bubble 的 bend，0..1）
const MAG = 1.06;   // 中间放大倍数（Glass bubble 是 1.1，搜索框很宽，取小一点免得两头位移太大）
const NS = "http://www.w3.org/2000/svg";
let uid = 0;

/* 只有 Chromium 系（含 Android Chrome）的 backdrop-filter 认 url() 滤镜；iOS 上所有浏览器都是 WebKit，一律不算 */
const canRefract = () => {
  const ua = navigator.userAgent;
  return /(Chrome|Edg)\//.test(ua) && !/CriOS|FxiOS|OPiOS/.test(ua) && !!window.CSS?.supports?.("backdrop-filter", "blur(1px)");
};

function sdf(px, py, cx, cy, bx, by, r) {
  const qx = Math.abs(px - cx) - bx + r;
  const qy = Math.abs(py - cy) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/* 位移图：返回 { url, scale }。圆角 = 半高（药丸） */
function makeMap(W, H) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const img = g.createImageData(W, H);
  const d = img.data;
  const cx = W / 2, cy = H / 2, bx = W / 2, by = H / 2, r = H / 2;
  const bevel = Math.min(by, Math.max(22, by * 0.36));
  const maxOff = Math.ceil(bevel * 1.1 * BEND + (W / 2) * (1 - 1 / MAG)) + 2;
  const e = 1.5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;
      const dist = sdf(px, py, cx, cy, bx, by, r);
      let ox = 0, oy = 0;
      if (dist < 1) {
        let nx = sdf(px + e, py, cx, cy, bx, by, r) - sdf(px - e, py, cx, cy, bx, by, r);
        let ny = sdf(px, py + e, cx, cy, bx, by, r) - sdf(px, py - e, cx, cy, bx, by, r);
        const len = Math.hypot(nx, ny) + 1e-5;
        nx /= len; ny /= len;
        const t = Math.min(1, Math.max(0, -dist / bevel));
        const edge = Math.pow(1 - t, 2.4);
        /* 取样点 = 放大后的位置 + 沿法线向外的偏移；位移 = 取样点 - 当前点 */
        ox = (px - cx) * (1 / MAG - 1) + nx * edge * bevel * 1.1 * BEND;
        oy = (py - cy) * (1 / MAG - 1) + ny * edge * bevel * 1.1 * BEND;
      }
      const i = (y * W + x) * 4;
      d[i] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, ox / maxOff)));
      d[i + 1] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, oy / maxOff)));
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  /* feDisplacementMap：偏移 = scale * (通道值 - 0.5)，通道值 = 0.5 + 0.5 * off / maxOff → scale = 2 * maxOff */
  return { url: c.toDataURL("image/png"), scale: 2 * maxOff };
}

export function initLiquidGlass(box) {
  if (!box) return;
  box.classList.add("lg");
  const refract = canRefract();
  /* 先按「没有折射」算；位移图生成好之后再升级成 refract，这样 --lg-filter 没就绪时不会出现一条无效的滤镜 */
  if (document.documentElement.dataset.glass !== "refract") document.documentElement.dataset.glass = "plain";
  if (!refract) return;

  const id = `lg-bend-${++uid}`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  svg.innerHTML =
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">` +
    '<feImage x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="map" scale="1" xChannelSelector="R" yChannelSelector="G"/></filter>';
  document.body.append(svg);
  const filter = svg.querySelector("filter");
  const image = svg.querySelector("feImage");
  const disp = svg.querySelector("feDisplacementMap");

  let w = 0, h = 0, frame = 0;
  const rebuild = () => {
    frame = 0;
    const W = Math.round(box.offsetWidth), H = Math.round(box.offsetHeight);
    if (!W || !H || (W === w && H === h)) return;
    w = W; h = H;
    const { url, scale } = makeMap(W, H);
    for (const n of [filter, image]) {
      n.setAttribute("width", W);
      n.setAttribute("height", H);
    }
    image.setAttribute("href", url);
    image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", url);
    disp.setAttribute("scale", scale);
    box.style.setProperty("--lg-filter", `url(#${id})`);
    document.documentElement.dataset.glass = "refract";
  };
  const queue = () => { if (!frame) frame = requestAnimationFrame(rebuild); };
  if (window.ResizeObserver) new ResizeObserver(queue).observe(box);
  else window.addEventListener("resize", queue);
  rebuild();
}
