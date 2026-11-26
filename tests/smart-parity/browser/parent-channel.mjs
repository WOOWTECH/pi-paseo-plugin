// One correlated JSON request at a time. A lost/malformed reply permanently
// closes this channel; an uncertain operation is never replayed.
export class ParentChannel {
  constructor(child) {
    this.child = child; this.buffer = ''; this.pending = null; this.failed = null; this.exited = false;
    this.exit = new Promise(resolve => child.once('close', (code, signal) => {
      this.exited = true; this.fail(Error('Parent transport exited; no retry')); resolve({ code, signal });
    }));
    child.once('error', () => this.fail(Error('Parent transport could not start')));
    child.stdin.on('error', () => this.fail(Error('Parent stdin closed; no retry')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 100000) return this.fail(Error('Parent frame too large'));
      while (this.buffer.includes('\n')) {
        const end = this.buffer.indexOf('\n'), line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        const pending = this.pending;
        if (!pending) return this.fail(Error('Unsolicited parent frame; no retry'));
        try {
          const value = JSON.parse(line);
          if (!pending.accept(value)) throw Error('Parent reply binding differs; no retry');
          this.pending = null; pending.resolve(value);
        } catch (error) { this.fail(error); }
      }
    });
  }
  fail(error) {
    this.failed ??= error;
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(this.failed); }
    this.onFailure?.(this.failed);
  }
  assertAlive() { if (this.failed || this.exited) throw this.failed || Error('Parent exited'); }
  receive(accept, { signal, timeoutMs = 45000 } = {}) {
    this.assertAlive();
    if (this.pending) throw Error('Concurrent parent request forbidden');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(Error('Parent response timeout; no retry')), timeoutMs);
      const abort = () => this.fail(Error('Parent exchange aborted; no retry'));
      const clean = fn => value => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); fn(value); };
      this.pending = { accept, resolve: clean(resolve), reject: clean(reject) };
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async exchange(envelope, options) {
    if (!['begin','finish'].includes(envelope.method)) throw Error('Only begin/finish are supported');
    const reply = this.receive(value => value.protocol === envelope.protocol && value.method === envelope.method &&
      value.requestSha256 === envelope.requestSha256 && (envelope.method !== 'finish' || value.attemptId === envelope.attemptId), options);
    if (!this.failed) this.child.stdin.write(JSON.stringify(envelope) + '\n');
    return reply;
  }
  close() {
    this.closing ??= this.closeOnce();
    return this.closing;
  }
  async closeOnce() {
    // EOF runs Python's finally/abort and closes its exact owned tunnels. A
    // wedged child is terminated only after that bounded cooperative attempt.
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 5000);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 10000);
    try { return await this.exit; } finally { clearTimeout(timer); clearTimeout(kill); }
  }
}
