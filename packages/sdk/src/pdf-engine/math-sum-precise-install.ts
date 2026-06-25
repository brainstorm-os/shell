// Side-effect module: installs the `Math.sumPrecise` polyfill on evaluation.
// Imported first by the pdf worker shim so the install runs before pdf.js's
// worker body — static import order guarantees this (a dynamic import would
// instead force a code-splitting worker build, which Vite can't emit).
import { installMathSumPrecise } from "./math-sum-precise";

installMathSumPrecise();
