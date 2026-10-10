/**
 * Who is on the other end of a socket, as an address.
 *
 * Three things key off this: the per-address connection cap, the matchmaker's refusal to
 * pair two players behind one address, and settlement's refusal to rate such a match. All
 * three assume that different players have different addresses.
 *
 * In production they did not. Caddy terminates TLS and forwards `/ws` over loopback, so
 * the socket's own peer address is `127.0.0.1` for every player who connects through the
 * domain — which is every player on the default configuration. As far as this server
 * could tell, the whole player base was one machine: the queue never paired anybody, and
 * the eleventh connection of any kind was turned away.
 *
 * It went unnoticed for months because the mod's first default was the bare IP and port,
 * and a config file keeps the URL it was created with. Those players arrived directly,
 * with real addresses, and were the ones getting matched. Moving to a new Minecraft made
 * everybody reinstall, every config was written fresh with the domain in it, and ranked
 * stopped working for everyone at once.
 */

/**
 * The address to hold this connection to account under.
 *
 * `X-Forwarded-For` is believed only when the socket's peer is loopback — that is, only
 * when the thing talking to us is a proxy on this machine. A client that reaches the port
 * directly can put anything it likes in that header, and believing it there would let one
 * person present as many addresses as they could type: the connection cap, the same-IP
 * pairing rule and the self-play guard would all be a header away from meaningless.
 *
 * Of the addresses in the header, the last one is used. Each proxy appends the peer it
 * saw, so the rightmost entry is what our own proxy observed first-hand; anything to its
 * left was supplied by the client and is worth exactly as much as that.
 *
 * A loopback peer with no header is something on this machine talking to us directly — a
 * dev bot, a health check — and is reported as loopback, which is what it is.
 */
export function remoteAddrOf(
  peer: string | undefined | null,
  forwardedFor: string | string[] | undefined,
): string | null {
  if (!peer) return null;
  const direct = normalise(peer);
  if (!isLoopback(direct)) return direct;

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const hops = (header ?? "").split(",").map((hop) => hop.trim()).filter((hop) => hop.length > 0);
  const observed = hops.at(-1);
  return observed ? normalise(observed) : direct;
}

/**
 * One spelling per address.
 *
 * A dual-stack socket reports an IPv4 peer as `::ffff:1.2.3.4`, while a proxy writes the
 * same peer into its header as `1.2.3.4`. Left alone, one player reaching us both ways
 * would count as two addresses.
 */
function normalise(addr: string): string {
  const lower = addr.trim().toLowerCase();
  return lower.startsWith("::ffff:") && lower.includes(".") ? lower.slice("::ffff:".length) : lower;
}

function isLoopback(addr: string): boolean {
  return addr === "::1" || addr.startsWith("127.");
}
