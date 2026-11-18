// 只覆盖 WebAuthn 会用到的确定长度 CBOR：整数、字节串、文本、数组、映射。
// 不定长和浮点直接拒绝，避免把没测过的分支当成合法凭证。

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function encodeHead(major, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error("cbor length");
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  if (n < 65536) return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
  if (n < 2 ** 32) {
    const b = new Uint8Array(5);
    b[0] = (major << 5) | 26;
    new DataView(b.buffer).setUint32(1, n);
    return b;
  }
  throw new Error("cbor length");
}

export function encodeCbor(value) {
  const parts = [];
  const enc = (v) => {
    if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new Error("cbor number");
      if (v >= 0) parts.push(encodeHead(0, v));
      else parts.push(encodeHead(1, -1 - v));
      return;
    }
    if (v instanceof Uint8Array) {
      parts.push(encodeHead(2, v.length), v);
      return;
    }
    if (typeof v === "string") {
      const b = new TextEncoder().encode(v);
      parts.push(encodeHead(3, b.length), b);
      return;
    }
    if (Array.isArray(v)) {
      parts.push(encodeHead(4, v.length));
      for (const item of v) enc(item);
      return;
    }
    if (v instanceof Map) {
      parts.push(encodeHead(5, v.size));
      for (const [k, val] of v) {
        enc(k);
        enc(val);
      }
      return;
    }
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      parts.push(encodeHead(5, keys.length));
      for (const k of keys) {
        enc(k);
        enc(v[k]);
      }
      return;
    }
    throw new Error("cbor type");
  };
  enc(value);
  return concat(parts);
}

// 返回 { value, offset }。offset 是这个值结束的位置，后面如果还有扩展数据由调用方决定。
export function decodeCbor(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  let o = 0;
  const need = (n) => {
    if (o + n > u8.length) throw new Error("cbor truncated");
  };
  const readLen = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) {
      need(1);
      return u8[o++];
    }
    if (ai === 25) {
      need(2);
      const v = (u8[o] << 8) | u8[o + 1];
      o += 2;
      return v;
    }
    if (ai === 26) {
      need(4);
      const v = new DataView(u8.buffer, u8.byteOffset + o, 4).getUint32(0);
      o += 4;
      return v;
    }
    throw new Error("cbor length");
  };
  const read = () => {
    need(1);
    const ib = u8[o++];
    const major = ib >> 5;
    const ai = ib & 31;
    if (ai > 27) throw new Error("cbor indefinite");
    if (major === 0) return readLen(ai);
    if (major === 1) return -1 - readLen(ai);
    if (major === 2 || major === 3) {
      const n = readLen(ai);
      need(n);
      const b = u8.slice(o, o + n);
      o += n;
      return major === 2 ? b : new TextDecoder().decode(b);
    }
    if (major === 4) {
      const n = readLen(ai);
      const a = [];
      for (let i = 0; i < n; i++) a.push(read());
      return a;
    }
    if (major === 5) {
      const n = readLen(ai);
      const m = new Map();
      for (let i = 0; i < n; i++) {
        const k = read();
        m.set(k, read());
      }
      return m;
    }
    throw new Error("cbor type");
  };
  const value = read();
  return { value, offset: o };
}
