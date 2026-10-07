// Connect only to app pages: browser-wide attachment can fail on WebView2 workers.
export async function connectNativePages(port = 9557) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const pages = targets.filter(t => t.type === 'page' && t.title === 'Meeting Copilot');
  const main = pages.find(t => !t.url.includes('view='));
  const overlay = pages.find(t => t.url.includes('view=overlay'));
  if (!main || !overlay) throw Error('Expected native main and overlay pages');
  async function connect(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      message.error ? call.reject(Error(message.error.message)) : call.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('Native page disconnected')); }
      pending.clear();
    });
    function rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP ${method} timed out`)); }, 120_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    return {
      url: target.url,
      async evaluate(fn, arg) {
        const result = await rpc('Runtime.evaluate', {
          expression: `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`,
          awaitPromise: true, returnByValue: true,
        });
        if (result.exceptionDetails) throw Error('Native page evaluation failed');
        return result.result.value;
      },
      close() { socket.close(); },
    };
  }
  const connectedMain = await connect(main);
  try {
    const connectedOverlay = await connect(overlay);
    return { main: connectedMain, overlay: connectedOverlay, close() { connectedMain.close(); connectedOverlay.close(); } };
  } catch (error) { connectedMain.close(); throw error; }
}
