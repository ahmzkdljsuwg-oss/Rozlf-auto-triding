'use strict';

// Minimal Chrome DevTools Protocol client: one WebSocket, one pending map.
// Node 22+ ships a global WebSocket, so the connector needs no extra dependency.
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);

      ws.addEventListener('open', () => { clearTimeout(timer); resolve(this); });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP socket error'));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        clearTimeout(timer);
        for (const [, p] of this.pending) p.reject(new Error('CDP closed'));
        this.pending.clear();
      });
      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        if (!msg || typeof msg.id !== 'number') return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      });
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (!this.ws || this.closed) return Promise.reject(new Error('CDP is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.closed = true;
  }
}

module.exports = { CdpClient };
