const net = require("node:net");
const crypto = require("node:crypto");

// --- Binary helpers ---

function writeInt32BE(buf, offset, val) {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

function writeInt16BE(buf, offset, val) {
  buf[offset] = (val >>> 8) & 0xff;
  buf[offset + 1] = val & 0xff;
}

function readInt32BE(buf, offset) {
  return (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
}

function readInt16BE(buf, offset) {
  return (buf[offset] << 8) | buf[offset + 1];
}

function md5hex(data) {
  return crypto.createHash("md5").update(data).digest("hex");
}

function cstring(buf, offset) {
  const end = buf.indexOf(0, offset);
  return { str: buf.toString("utf8", offset, end), next: end + 1 };
}

// --- Message builders ---

function buildStartup(user, database) {
  const params = `user\0${user}\0database\0${database}\0\0`;
  const len = 4 + 4 + Buffer.byteLength(params);
  const buf = Buffer.alloc(len);
  writeInt32BE(buf, 0, len);
  writeInt32BE(buf, 4, 196608); // protocol 3.0
  buf.write(params, 8, "utf8");
  return buf;
}

function buildPasswordCleartext(password) {
  const payload = Buffer.from(password + "\0");
  const buf = Buffer.alloc(1 + 4 + payload.length);
  buf[0] = 0x70; // 'p'
  writeInt32BE(buf, 1, 4 + payload.length);
  payload.copy(buf, 5);
  return buf;
}

function buildPasswordMD5(user, password, salt) {
  const inner = md5hex(password + user);
  const outer = "md5" + md5hex(Buffer.concat([Buffer.from(inner), salt]));
  const payload = Buffer.from(outer + "\0");
  const buf = Buffer.alloc(1 + 4 + payload.length);
  buf[0] = 0x70;
  writeInt32BE(buf, 1, 4 + payload.length);
  payload.copy(buf, 5);
  return buf;
}

function buildSimpleQuery(sql) {
  const payload = Buffer.from(sql + "\0");
  const buf = Buffer.alloc(1 + 4 + payload.length);
  buf[0] = 0x51; // 'Q'
  writeInt32BE(buf, 1, 4 + payload.length);
  payload.copy(buf, 5);
  return buf;
}

function buildTerminate() {
  const buf = Buffer.alloc(5);
  buf[0] = 0x58; // 'X'
  writeInt32BE(buf, 1, 4);
  return buf;
}

// Extended Query: Parse + Bind + Describe + Execute + Sync
function buildExtendedQuery(sql, params) {
  const parts = [];

  // Parse: 'P' + len + stmtName\0 + query\0 + Int16(0) (no param type hints)
  const queryBuf = Buffer.from(sql + "\0");
  const parsePayload = 1 + queryBuf.length + 2; // \0 for empty name + query + paramCount
  const parseBuf = Buffer.alloc(1 + 4 + parsePayload);
  parseBuf[0] = 0x50; // 'P'
  writeInt32BE(parseBuf, 1, 4 + parsePayload);
  parseBuf[5] = 0; // empty statement name
  queryBuf.copy(parseBuf, 6);
  writeInt16BE(parseBuf, 6 + queryBuf.length, 0);
  parts.push(parseBuf);

  // Bind: 'B' + len + portal\0 + stmt\0 + Int16(0) formats + Int16(paramCount) + params + Int16(0) result formats
  const paramBuffers = params.map((p) => {
    if (p === null || p === undefined) return null;
    return Buffer.from(String(p));
  });
  let bindSize = 1 + 1 + 2 + 2; // portal\0 + stmt\0 + formatCount + paramCount
  for (const pb of paramBuffers) {
    bindSize += 4; // length field
    if (pb !== null) bindSize += pb.length;
  }
  bindSize += 2; // result format count
  const bindBuf = Buffer.alloc(1 + 4 + bindSize);
  bindBuf[0] = 0x42; // 'B'
  writeInt32BE(bindBuf, 1, 4 + bindSize);
  let off = 5;
  bindBuf[off++] = 0; // empty portal name
  bindBuf[off++] = 0; // empty statement name
  writeInt16BE(bindBuf, off, 0); off += 2; // all text format
  writeInt16BE(bindBuf, off, params.length); off += 2;
  for (const pb of paramBuffers) {
    if (pb === null) {
      writeInt32BE(bindBuf, off, -1); off += 4; // NULL
    } else {
      writeInt32BE(bindBuf, off, pb.length); off += 4;
      pb.copy(bindBuf, off); off += pb.length;
    }
  }
  writeInt16BE(bindBuf, off, 0); // all text result format
  parts.push(bindBuf);

  // Describe portal: 'D' + len + 'P' + \0
  const descBuf = Buffer.alloc(1 + 4 + 2);
  descBuf[0] = 0x44; // 'D'
  writeInt32BE(descBuf, 1, 4 + 2);
  descBuf[5] = 0x50; // 'P' for portal
  descBuf[6] = 0;
  parts.push(descBuf);

  // Execute: 'E' + len + portal\0 + Int32(0) = fetch all
  const execBuf = Buffer.alloc(1 + 4 + 1 + 4);
  execBuf[0] = 0x45; // 'E'
  writeInt32BE(execBuf, 1, 4 + 1 + 4);
  execBuf[5] = 0; // empty portal
  writeInt32BE(execBuf, 6, 0); // no row limit
  parts.push(execBuf);

  // Sync: 'S' + len(4)
  const syncBuf = Buffer.alloc(5);
  syncBuf[0] = 0x53; // 'S'
  writeInt32BE(syncBuf, 1, 4);
  parts.push(syncBuf);

  return Buffer.concat(parts);
}

// --- Response parsers ---

function parseRowDescription(buf) {
  const fieldCount = readInt16BE(buf, 0);
  const fields = [];
  let off = 2;
  for (let i = 0; i < fieldCount; i++) {
    const { str: name, next } = cstring(buf, off);
    off = next;
    off += 4 + 2 + 4 + 2 + 4 + 2; // tableOID, colNum, typeOID, typeLen, typeMod, formatCode
    fields.push(name);
  }
  return fields;
}

function parseDataRow(buf, fields) {
  const colCount = readInt16BE(buf, 0);
  const row = {};
  let off = 2;
  for (let i = 0; i < colCount; i++) {
    const len = readInt32BE(buf, off); off += 4;
    if (len === -1) {
      row[fields[i]] = null;
    } else {
      row[fields[i]] = buf.toString("utf8", off, off + len);
      off += len;
    }
  }
  return row;
}

function parseError(buf) {
  const parts = {};
  let off = 0;
  while (off < buf.length && buf[off] !== 0) {
    const type = String.fromCharCode(buf[off++]);
    const { str, next } = cstring(buf, off);
    parts[type] = str;
    off = next;
  }
  return parts;
}

// --- PgClient ---

class PgClient {
  constructor(opts = {}) {
    this.host = opts.host || process.env.PGHOST || "localhost";
    this.port = parseInt(opts.port || process.env.PGPORT || "5432");
    this.user = opts.user || process.env.PGUSER || "plantri";
    this.password = opts.password || process.env.PGPASSWORD || "";
    this.database = opts.database || process.env.PGDATABASE || "plantri";
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this._waiters = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.port, this.host, () => {
        this.socket.write(buildStartup(this.user, this.database));
      });

      this.socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._drainMessages();
      });

      this.socket.on("error", (err) => {
        this.connected = false;
        if (this._authReject) this._authReject(err);
        for (const w of this._waiters) w.reject(err);
        this._waiters = [];
      });

      this.socket.on("close", () => {
        this.connected = false;
      });

      // Auth handshake is handled via _drainMessages
      this._authResolve = resolve;
      this._authReject = reject;
      this._authPhase = true;
    });
  }

  _drainMessages() {
    while (true) {
      if (this.buffer.length < 5) return;
      const type = this.buffer[0];
      const len = readInt32BE(this.buffer, 1);
      const totalLen = 1 + len;
      if (this.buffer.length < totalLen) return;

      const payload = this.buffer.subarray(5, totalLen);
      this.buffer = this.buffer.subarray(totalLen);

      this._handleMessage(type, payload);
    }
  }

  _handleMessage(type, payload) {
    const ch = String.fromCharCode(type);

    // Auth phase
    if (this._authPhase) {
      if (ch === "R") {
        const authType = readInt32BE(payload, 0);
        if (authType === 0) {
          // AuthenticationOk — wait for ReadyForQuery
        } else if (authType === 3) {
          this.socket.write(buildPasswordCleartext(this.password));
        } else if (authType === 5) {
          const salt = payload.subarray(4, 8);
          this.socket.write(buildPasswordMD5(this.user, this.password, salt));
        } else {
          this._authReject(new Error(`Unsupported auth type: ${authType}`));
        }
        return;
      }
      if (ch === "Z") {
        this._authPhase = false;
        this.connected = true;
        this._authResolve();
        return;
      }
      if (ch === "E") {
        const err = parseError(payload);
        this._authReject(new Error(`PG auth error: ${err.M || JSON.stringify(err)}`));
        return;
      }
      // Skip ParameterStatus ('S'), BackendKeyData ('K') during auth
      return;
    }

    // Query phase — dispatch to current waiter
    if (this._waiters.length > 0) {
      this._waiters[0].onMessage(ch, payload);
    }
  }

  // Simple Query protocol (for DDL, no parameters)
  async query(sql) {
    if (!this.connected) throw new Error("Not connected");

    return new Promise((resolve, reject) => {
      const result = { rows: [], fields: [], command: "" };
      const waiter = {
        resolve, reject,
        onMessage(ch, payload) {
          if (ch === "T") {
            result.fields = parseRowDescription(payload);
          } else if (ch === "D") {
            result.rows.push(parseDataRow(payload, result.fields));
          } else if (ch === "C") {
            result.command = cstring(payload, 0).str;
          } else if (ch === "Z") {
            this._done();
            resolve(result);
          } else if (ch === "E") {
            const err = parseError(payload);
            this._done();
            reject(new Error(`PG error: ${err.M || JSON.stringify(err)}`));
          }
          // Ignore: 'N' (NoticeResponse), etc.
        },
        _done: () => {
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) this._waiters.splice(idx, 1);
        },
      };
      // Fix closure for _done
      waiter._done = () => {
        const idx = this._waiters.indexOf(waiter);
        if (idx >= 0) this._waiters.splice(idx, 1);
      };
      this._waiters.push(waiter);
      this.socket.write(buildSimpleQuery(sql));
    });
  }

  // Extended Query protocol (parameterized, safe for data)
  async queryParams(sql, params = []) {
    if (!this.connected) throw new Error("Not connected");

    return new Promise((resolve, reject) => {
      const result = { rows: [], fields: [], command: "" };
      const waiter = {
        resolve, reject,
        onMessage(ch, payload) {
          if (ch === "1") { /* ParseComplete */ }
          else if (ch === "2") { /* BindComplete */ }
          else if (ch === "n") { /* NoData */ }
          else if (ch === "T") { result.fields = parseRowDescription(payload); }
          else if (ch === "D") { result.rows.push(parseDataRow(payload, result.fields)); }
          else if (ch === "C") { result.command = cstring(payload, 0).str; }
          else if (ch === "Z") { this._done(); resolve(result); }
          else if (ch === "E") {
            const err = parseError(payload);
            this._done();
            reject(new Error(`PG error: ${err.M || JSON.stringify(err)}`));
          }
        },
        _done: () => {
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) this._waiters.splice(idx, 1);
        },
      };
      waiter._done = () => {
        const idx = this._waiters.indexOf(waiter);
        if (idx >= 0) this._waiters.splice(idx, 1);
      };
      this._waiters.push(waiter);
      this.socket.write(buildExtendedQuery(sql, params));
    });
  }

  async close() {
    if (this.socket) {
      this.socket.write(buildTerminate());
      this.socket.end();
      this.connected = false;
    }
  }
}

module.exports = { PgClient };
