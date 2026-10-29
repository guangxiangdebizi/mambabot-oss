import { createHash } from 'node:crypto';

// Minimal RFC 6455 server side: enough to carry a binary VNC stream to noVNC.
// No extensions, no compression. Client frames must be masked.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;

export function acceptUpgrade(req, socket, { protocols = [] } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return false;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const proto = offered.find((p) => protocols.includes(p));
  socket.write([
    'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`, ...(proto ? [`Sec-WebSocket-Protocol: ${proto}`] : []), '', '',
  ].join('\r\n'));
  return true;
}

export function rejectUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function encodeFrame(payload, opcode = 2) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Incremental frame parser; calls onMessage(opcode, payload) per frame (fragments passed through). */
export class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
  }

  /** Returns an error string on protocol violation. */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return null;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      if (!(b1 & 0x80)) return 'unmasked client frame';
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return null;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return null;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return 'frame too large';
        len = Number(big);
        off = 10;
      }
      if (len > MAX_FRAME) return 'frame too large';
      if (this.buf.length < off + 4 + len) return null;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.onFrame(opcode, payload);
    }
  }
}

/** Pipes a WebSocket (already upgraded) to a duplex stream, with a hook on client data. */
export function bridge(socket, target, { filterIn, onClose } = {}) {
  let closed = false;
  const close = (code = 1000) => {
    if (closed) return;
    closed = true;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try { socket.end(encodeFrame(body, 8)); } catch { /* gone */ }
    target.destroy();
    onClose?.();
  };
  const parser = new FrameParser((opcode, payload) => {
    if (opcode === 8) return close();
    if (opcode === 9) { socket.write(encodeFrame(payload, 10)); return undefined; }
    if (opcode === 10) return undefined;
    if (opcode === 1) return close(1003);
    const result = filterIn ? filterIn(payload) : { out: [payload] };
    for (const part of result.out) if (part.length) target.write(part);
    if (result.error) close(1008);
    return undefined;
  });
  socket.on('data', (chunk) => {
    const err = parser.push(chunk);
    if (err) close(1002);
  });
  target.on('data', (chunk) => {
    if (!socket.write(encodeFrame(chunk))) {
      target.pause();
      socket.once('drain', () => target.resume());
    }
  });
  socket.on('close', () => close());
  socket.on('error', () => close());
  target.on('close', () => close(1001));
  target.on('error', () => close(1011));
  return { close };
}
