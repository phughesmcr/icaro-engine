// Test 4b: does a module Worker resolve a bare specifier through the page's
// import map? If not, this module fails to load and the Worker's error event
// fires instead.
import { spike_dep } from "spike-dep";

self.postMessage({ importmap: spike_dep });
