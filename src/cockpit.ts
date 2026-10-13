/*
 * The app's single entry point to Cockpit's client library.
 *
 * Import this, never "cockpit" directly. ES modules evaluate their
 * dependencies depth-first in declaration order, so importing the shim on the
 * line above the library is what guarantees `window` and `document` exist
 * before the library's module-level reads run.
 */
import "./shim/dom.js";
import cockpit from "cockpit";

export default cockpit;
export { cockpit };
