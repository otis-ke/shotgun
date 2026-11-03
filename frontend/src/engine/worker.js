import { JOBS } from './jobs.js'

self.onmessage = ({ data: { id, kind, payload } }) => {
  try { self.postMessage({ id, result: JOBS[kind](payload) }) } catch (e) { self.postMessage({ id, error: e.message || String(e) }) }
}
