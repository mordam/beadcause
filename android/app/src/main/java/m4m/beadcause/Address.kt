package m4m.beadcause

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Which servers this app is willing to send its token to.
 *
 * The token is a bearer credential for every workspace at once, so where it may go is
 * a security decision and it lives here rather than at the three call sites that ask.
 * There are exactly two answers:
 *
 * - **`https://<host>.<tailnet>.ts.net:<port>`** — what `npm run qr` prints. The
 *   certificate comes from `tailscale cert` (Let's Encrypt, through Tailscale), and
 *   `.ts.net` is Tailscale's own domain: only Tailscale issues names under it, and
 *   only to the tailnet that owns them.
 * - **plain http to loopback**, including `10.0.2.2` — how an emulator reaches the
 *   Mac it is running on. There is no wire to eavesdrop on and no certificate to be
 *   had, and this is the one path a developer cannot do without.
 *
 * Everything else is refused *before the first request*, which is the moment that
 * matters: a token sent and then regretted is a token that has been sent.
 *
 * Deliberately not "any https", which is what this check used to say. A blanket allow
 * on the scheme is a check that accepts anything — a typo that resolves on the public
 * internet, a link in a message — and it would hand the token over on the strength of
 * a certificate anyone can get for a domain they own.
 *
 * **What it is not.** The suffix narrows the internet down to *a* tailnet, not to
 * *yours* — somebody else's tailnet has `.ts.net` names and can hold certificates for
 * them too, so a QR photographed off a stranger's screen is still a QR this will pair
 * with. Nothing here can tell those apart; the phone has never been told which tailnet
 * it belongs to, and the token in that QR is the stranger's own. What this rules out
 * is the far larger set — every host that is not on any tailnet — and the whole of
 * cleartext, which is where a token could be taken by someone who was not shown it.
 *
 * The regex is the same one `magicDnsName()` in lib/tls.js validates with, so the
 * names the Mac can hand out and the names the phone will accept are the same set by
 * construction. `test/pairhost.mjs` keeps them that way.
 */
object Address {

    /** Where a cleartext request is still allowed to go. Must match network_security_config.xml. */
    val LOOPBACK = setOf("localhost", "127.0.0.1", "10.0.2.2")

    /** `<host>.<tailnet>.ts.net` — a MagicDNS name, and the only thing a certificate is issued for. */
    private val MAGIC_DNS = Regex("^[a-z0-9.-]+\\.ts\\.net$")

    /** Tailscale's CGNAT range, `100.64.0.0/10`. Recognised in order to explain it — see [Reach]. */
    private fun isTailscaleAddress(host: String): Boolean {
        val octets = host.split('.').mapNotNull { it.toIntOrNull() }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return false
        return octets[0] == 100 && octets[1] in 64..127
    }

    /**
     * What can be said about a base URL, in the three cases that need different words
     * in front of somebody at a QR screen.
     */
    enum class Reach {
        /** Send the token here. */
        OK,

        /**
         * The tailnet over plain http — the Tailscale address, which is the shape
         * `npm run qr` prints when the Mac holds no certificate, or the MagicDNS name
         * typed by hand without the scheme. Nothing is wrong with the phone and
         * nothing is wrong with the QR: the tailnet has *HTTPS Certificates* switched
         * off, or the daemon has not been restarted since it was switched on. Worth
         * its own answer, because "that isn't your tailnet" would be a lie about the
         * one host that unmistakably is.
         */
        NO_CERTIFICATE,

        /** Somewhere else entirely. A typo, a stale LAN address, someone else's screen. */
        OFF_TAILNET,
    }

    fun reach(baseUrl: String?): Reach {
        val url = baseUrl?.trim()?.toHttpUrlOrNull() ?: return Reach.OFF_TAILNET
        // HttpUrl lowercases and punycodes the host for us; a trailing root dot does not
        // survive parsing either, so the suffix test needs no normalising of its own.
        val host = url.host
        if (url.scheme == "https") return if (MAGIC_DNS.matches(host)) Reach.OK else Reach.OFF_TAILNET
        if (host in LOOPBACK) return Reach.OK
        // Cleartext to the tailnet is a missing certificate on the Mac, not a mistake
        // made here, and the two need different sentences on the screen.
        val tailnet = isTailscaleAddress(host) || MAGIC_DNS.matches(host)
        return if (tailnet) Reach.NO_CERTIFICATE else Reach.OFF_TAILNET
    }

    /** Whether the token may be sent to [baseUrl] at all. */
    fun isPairable(baseUrl: String?) = reach(baseUrl) == Reach.OK
}
