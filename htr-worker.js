/* Handwriting reader that runs in the background so the screen never freezes.
   Uses TrOCR, an open handwriting-recognition model trained on real handwritten
   lines (cursive included), running on the phone through transformers.js.
   The model (about 60 MB) is downloaded once from Hugging Face and then kept
   on the phone. */
import { pipeline, env, RawImage } from './vendor/transformers/transformers.min.js';

const MODEL = 'Xenova/trocr-small-handwritten';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/', self.location.href).href;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, (self.navigator && navigator.hardwareConcurrency) || 2))
  : 1;

let pipeP = null;
function getPipe() {
  if (!pipeP) {
    pipeP = pipeline('image-to-text', MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.total) {
          postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
        }
      },
    }).then((pipe) => { postMessage({ type: 'ready' }); return pipe; })
      .catch((e) => { pipeP = null; throw e; });
  }
  return pipeP;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'warm') {
    try { await getPipe(); } catch (e) { postMessage({ type: 'error', id: null, message: String(e && e.message || e) }); }
    return;
  }
  if (data.type !== 'read') return;
  try {
    const pipe = await getPipe();
    const img = new RawImage(new Uint8ClampedArray(data.buffer), data.width, data.height, 3);
    const out = await pipe(img, { max_new_tokens: 64 });
    const text = (Array.isArray(out) ? out[0] : out)?.generated_text || '';
    postMessage({ type: 'result', id: data.id, text });
  } catch (e) {
    postMessage({ type: 'error', id: data.id, message: String(e && e.message || e) });
  }
};
