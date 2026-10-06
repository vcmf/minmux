// The fs worker: a utility process that does the files browser's folder reads, so a read that
// never returns (a dead NFS / SMB / 9p mount) ties up THIS process's threads, never main's
// (main carries every terminal's I/O and its own fs work). Main kills and replaces it when a
// read hangs (fs-worker-client).
import { handleFsRequest, type FsRequest } from "./fs-worker-ops"

process.parentPort.on("message", (e) => {
  void handleFsRequest(e.data as FsRequest).then((reply) => process.parentPort.postMessage(reply))
})
