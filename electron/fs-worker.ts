// The fs worker: a utility process that does the files browser's folder reads and watches, so
// a call that never returns (a dead NFS / SMB / 9p mount) ties up THIS process, never main
// (main carries every terminal's I/O and its own fs work). Main kills and replaces it when a
// request hangs (fs-worker-client).
import { handleFsRequest, Watches, type FsRequest } from "./fs-worker-ops"

const watches = new Watches((e) => process.parentPort.postMessage(e))

process.parentPort.on("message", (e) => {
  void handleFsRequest(e.data as FsRequest, watches).then((reply) =>
    process.parentPort.postMessage(reply),
  )
})
