// The remote-client worker (a utilityProcess; docs/design/REMOTE_CONTROL.md, "minmux on another
// machine"): finds the user's other minmux on the tailnet and relays their panes to main.
import { createPeerClient } from "./remote/peer-client"
import type { ToClient } from "./remote/client-messages"
import { cliCandidates, findCli, parseStatus, peersOf, runCli } from "./remote/tailscale"

const ports = (process.env.MINMUX_REMOTE_PORTS ?? "7420,7421")
  .split(",")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
const ownPort = Number(process.env.MINMUX_REMOTE_OWN_PORT ?? 0)
let cli: string | null = null

const client = createPeerClient({
  post: (m) => process.parentPort.postMessage(m),
  ports,
  ownPort,
  tailnet: async () => {
    cli ??= findCli(cliCandidates(process.platform, process.env.PATH ?? "", process.env))
    if (!cli) return { self: { ok: false, reason: "missing" }, peers: [] }
    const raw = await runCli(cli, ["status", "--json"])
    const self = parseStatus(raw)
    return { self, peers: self.ok ? peersOf(raw, self.self) : [] }
  },
})
process.parentPort.on("message", (e) => client.handle(e.data as ToClient))
