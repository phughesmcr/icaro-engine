// Control for test 4c: the same import as importmap_worker.js, but by
// relative path, so a failure there is down to the bare specifier alone.
import { spike_dep } from './importmap_dep.js';

self.postMessage( { importmap: spike_dep } );
