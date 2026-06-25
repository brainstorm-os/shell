// pdf.js ships its worker as a side-effect-only ESM build with no types. The
// shim (`pdf-worker.ts`) imports it purely to register the worker's message
// handler, so an empty ambient declaration is all tsc needs.
declare module "pdfjs-dist/build/pdf.worker.min.mjs";
